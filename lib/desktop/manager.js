/** Owns the desired desktop state and serializes helper lifecycle transitions. */
export function createDesktopManager({ runtimeState, getChatUrl, stateFile, electronRuntime, hostSupport, helperFactory, protocol, runtimeConfig, assetPath, logger = console }) {
  const t = runtimeConfig.timeouts
  let current = { available: hostSupport.supported, state: hostSupport.supported ? 'idle' : 'unavailable', visible: false, code: hostSupport.code || '', text: hostSupport.text || '', progress: '' }
  let saved = stateFile.read(), desired = saved.visible, helper = null, epoch = 0, disposed = false, queue = Promise.resolve()
  let waiters = new Map(), restartTimer = null, stableTimer = null, attempts = 0
  const snapshot = () => Object.freeze({ ...current })
  function commit(patch) {
    if (disposed) return
    const old = current.state
    current = { ...current, ...patch }
    if (old !== current.state) logger.info?.(`muche desktop: ${old} -> ${current.state}`)
    runtimeState.setDesktop(snapshot())
  }
  function persist() { stateFile.write({ visible: desired, x: saved.x, y: saved.y }) }
  function rejectWaiters(error) {
    for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
    waiters.clear()
  }
  function waitFor(type, ms) {
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(type); reject(new Error(`helper ${type} timeout`)) }, ms)
      waiters.set(type, { resolve, reject, timer })
    })
    // Sending or starting can throw before the caller reaches its await.
    void pending.catch(() => {})
    return pending
  }
  function onMessage(message) {
    const waiter = waiters.get(message.type)
    if (waiter) { waiters.delete(message.type); clearTimeout(waiter.timer); waiter.resolve(message) }
    if (message.type === 'clicked' && current.state === 'visible') {
      try {
        const url = getChatUrl()
        if (!helper?.send({ type: 'open-chat', url })) throw new Error('helper command unavailable')
        commit({ code: '', text: '' })
      } catch (error) {
        logger.warn('muche desktop: chat window unavailable', error?.name || 'Error')
        commit({ code: 'CHAT_UNAVAILABLE', text: '聊天窗口暂时不可用，请重试' })
      }
    }
    if (message.type === 'chat-error') commit({ code: 'CHAT_UNAVAILABLE', text: '聊天窗口暂时不可用，请重试' })
    // 桌面级语音：立绘按快捷键要开一个不显示的语音窗口，地址由宿主现取（令牌会轮换，不能预存）。
    if (message.type === 'chat-url-request') {
      let url = ''
      try { url = getChatUrl() } catch (error) { logger.warn('muche desktop: chat url unavailable', error?.name || 'Error') }
      helper?.send({ type: 'chat-url', url })
    }
    if (message.type === 'moved' && current.state === 'visible' && Number.isFinite(message.x) && Number.isFinite(message.y)) {
      saved = { ...saved, x: message.x, y: message.y }; persist()
    }
    if (message.type === 'error') {
      logger.warn('muche desktop: helper error', message.code || 'unknown')
      rejectWaiters(new Error(String(message.code || 'helper error')))
      if (current.state === 'visible' && helper) {
        const failed = helper; helper = null
        commit({ state: 'starting', visible: false, progress: '正在重新连接小沐…' })
        enqueue(async () => { await failed.stop(); scheduleRestart() })
      }
    }
  }
  function scheduleRestart() {
    if (disposed || !desired || restartTimer) return
    if (++attempts > t.restartMaxAttempts) { commit({ state: 'failed', visible: false, code: 'HELPER_CRASHED', text: '小沐悬浮窗反复异常，请重试', progress: '' }); return }
    commit({ state: 'starting', visible: false, code: '', text: '', progress: '正在重新连接小沐…' })
    restartTimer = setTimeout(() => { restartTimer = null; enqueue(() => start(epoch, true)) }, t.restartBaseMs * 2 ** (attempts - 1))
  }
  function onExit(source, event) {
    if (helper !== source) return
    helper = null
    rejectWaiters(new Error('helper exited'))
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = null }
    if (!event.expected && current.state === 'visible') scheduleRestart()
  }
  function enqueue(fn) { queue = queue.then(fn, fn).catch(error => logger.warn('muche desktop: lifecycle error', error?.message || error)); return queue }
  async function start(ticket, recovering = false) {
    if (disposed || !desired || ticket !== epoch || !current.available || current.state === 'visible') return
    commit({ state: 'starting', visible: false, code: '', text: '', progress: '正在准备桌面组件…' })
    let proc
    try {
      const runtime = await electronRuntime.ensure()
      if (disposed || !desired || ticket !== epoch) return
      proc = helperFactory({ exePath: runtime.exePath, onMessage: message => { if (helper === proc) onMessage(message) }, onExit: event => onExit(proc, event) })
      helper = proc
      const hello = waitFor('hello', t.readyMs)
      proc.start()
      const greeting = await hello
      if (greeting.protocol !== protocol.protocol || greeting.app !== protocol.app) { const error = new Error('protocol mismatch'); error.code = 'PROTOCOL_MISMATCH'; throw error }
      const ready = waitFor('ready', t.readyMs)
      proc.send({ type: 'init', protocol: protocol.protocol, window: { x: saved.x, y: saved.y, bodyHeight: runtimeConfig.window.bodyHeight, padding: runtimeConfig.window.padding }, assetPath })
      await ready
      const shown = waitFor('shown', t.shownMs); proc.send({ type: 'show' })
      const frame = await shown
      if (disposed || !desired || ticket !== epoch) { await proc.stop(); return }
      if (helper !== proc) throw new Error('helper exited before display was committed')
      if (Number.isFinite(frame.bounds?.x) && Number.isFinite(frame.bounds?.y)) saved = { ...saved, x: frame.bounds.x, y: frame.bounds.y }
      persist()
      commit({ state: 'visible', visible: true, code: '', text: '', progress: '' })
      if (stableTimer) clearTimeout(stableTimer)
      stableTimer = setTimeout(() => { attempts = 0; stableTimer = null }, t.stableResetMs)
      stableTimer.unref?.()
    } catch (error) {
      rejectWaiters(error)
      if (proc) { if (helper === proc) helper = null; await proc.stop() }
      if (disposed || !desired || ticket !== epoch) return
      if (recovering) { scheduleRestart(); return }
      const code = error.code === 'RUNTIME_DOWNLOAD_FAILED' ? error.code : error.code === 'PROTOCOL_MISMATCH' ? error.code : 'HELPER_START_FAILED'
      logger.warn('muche desktop: start failed', error?.message || error)
      commit({ state: 'failed', visible: false, code, text: code === 'RUNTIME_DOWNLOAD_FAILED' ? '桌面组件下载失败，请检查网络后重试' : '小沐悬浮窗启动失败，请重试', progress: '' })
    }
  }
  function show() {
    if (disposed || !current.available) return Promise.resolve()
    desired = true; persist()
    if (current.state === 'visible' || current.state === 'starting') return queue
    attempts = 0
    return enqueue(() => start(epoch))
  }
  function hide() {
    if (disposed) return Promise.resolve()
    desired = false; epoch++; persist(); rejectWaiters(new Error('hidden'))
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
    return enqueue(async () => {
      if (disposed) return
      const proc = helper; helper = null
      commit({ state: 'stopping', visible: false, code: '', text: '', progress: '' })
      if (proc) await proc.stop()
      commit({ state: current.available ? 'idle' : 'unavailable', visible: false })
    })
  }
  function restore() { if (desired && current.available) return enqueue(() => start(epoch)); return Promise.resolve() }
  async function dispose() {
    if (disposed) return
    disposed = true; epoch++; rejectWaiters(new Error('disposed'))
    if (restartTimer) clearTimeout(restartTimer)
    if (stableTimer) clearTimeout(stableTimer)
    stateFile.dispose()
    const proc = helper; helper = null
    logger.info?.(`muche desktop: dispose helper=${proc ? 'present' : 'absent'}`)
    if (proc) await proc.stop()
  }
  runtimeState.setDesktop(snapshot())
  return { snapshot, show, hide, retry: show, restore, dispose, setProgress: progress => { if (current.state === 'starting') commit({ progress }) } }
}
