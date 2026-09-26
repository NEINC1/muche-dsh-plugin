/**
 * dsh 反向桥接：用户本机插件的出站常驻 WS（`channel=dsh-bridge`）。
 *
 * 方向：后端拨不进用户机器（NAT），所以不建任何入站隧道。本模块在插件所在
 * dsh 进程内持一条到后端的出站长连接；后端把该用户的 `dsh_task` 从这条连接
 * 递下来，本模块经 `dsh-call.js` 的执行核在**本机**建会话执行，结果以
 * `dsh_result` 原路回传。传输类为 `backend_ws.js` 的 `BackendWs`
 * （ping/重连/开关语义与面板 WS 一致，通道名不同故后端额度池独立）。
 *
 * 启动条件：Config 配了 `apiKey` 即起；无 key 即停。官方表单保存后，
 * 宿主经 `loader/volatile-update` 事件调 `requestDshBridgeRefresh` 换连
 * （ctx 不允许挂属性故用模块级单例）。
 *
 * 任务语义（一任务只执行一次）：`task_id` 进程内去重，同 id 重发直接忽略；
 * 结果只回传一次，直发失败（桥已断）即丢弃——断连的在途任务由后端终结，
 * 本侧不进离线缓冲。桥断时中止本机在途执行（AbortController，复用 HTTP
 * 时代"请求关闭即 abort"的既定路径），不留孤儿计算。
 * 同会话串行：同一 `session_id` 的任务按到达序串行执行（后任务等前任务的
 * turn/end 监听退订后再 prompt）。`dsh-call.js` 的 waitForTurn 只按
 * sessionId 过滤，并发 prompt 同一会话会同时吃到第一个 turn/end 而串扰
 * （一真一假、真 turn 丢失），故必须在桥接层串行；新会话（无 session_id）
 * 彼此独立，可并发。
 *
 * 在途交互（WP3）：`approval/request` 与 `user-questions/request` 以
 * prepend 先于转发器/UI 拦截——命中在途小沐会话（task/run → session
 * 映射＋反向 session → run 映射）即经 `dsh_interactive` 上行等后端决议，
 * `dsh_decide` 按 interactive_id 终结等待；他会话与不可识别一律 next()
 * 透传。桥断/卸载即失败闭环（授权回 unavailable，提问抛错）。
 */
import { BackendWs } from './backend_ws.js'
import { readConfig } from './config.js'
import { executeDshTask, promptSession } from './dsh-call.js'

// 去重集合上限（防常驻进程内存缓慢增长；最早的先逐出）。
const MAX_SEEN_TASK_IDS = 200

// 各主纤程 refresh 注册表：配置保存后全部重刷（幂等）。旧单例 hook 在双挂载下
// 只刷最后一个纤程，主纤程换 key 后不断连——收成集合，dispose 即摘除。
const refreshHooks = new Set()
export function requestDshBridgeRefresh() {
  if (refreshHooks.size === 0) return Promise.resolve()
  return Promise.allSettled([...refreshHooks].map((fn) => {
    try {
      return fn()
    } catch {
      // 单纤程失败不影响其他纤程的重刷。
      return undefined
    }
  })).then(() => undefined)
}

// 纤程状态聚合（/api/muche/status 与契约测试的唯一消费口）：数组而非单值，
// 双挂载下后写的副纤程不覆盖主纤程；dispose 即摘除，不留幽灵。
const fiberStates = new Set()
export function getDshBridgeStatus() {
  return {
    fibers: [...fiberStates].map((s) => ({
      mode: s.mode,
      reason: s.reason,
      deps: { ...s.deps },
      bridge: s.bridge ? s.bridge.getState() : { status: 'idle', lastError: '', buffered: 0, oldestTs: 0 },
    })),
  }
}

// 依赖缺失时的有界自愈窗口：宿主各行异步挂载，apply 时刻缺失不代表永远缺失
// （2026-09-23 桌面端静默丢桥根因）。计时器全部 unref + dispose 清理，
// 不拖住事件循环（OI-025 教训）；耗尽后静默等下一次配置保存触发。
const DEP_RETRY_DELAYS_MS = [5000, 15000, 30000]

export function registerDshBridge(ctx, config) {
  // 市场安装形态：桥接依赖走 ctx.get 可选——缺失时桥接停用（状态可见）、
  // 面板照常，整插件不进 waiting。依赖检查推迟到每次 refresh（启动/重存配置/
  // 有界重试），不再在 apply 时刻一判终身（桌面端启动顺序竞态曾致静默丢桥）。
  // 热路径只要 sessionController + workspaceRegistry；sessionQuery 只给
  // listWorkspaceSessions 用（当前无热路径调用方），缺时该函数返回 []。
  let disposed = false
  const seenTaskIds = new Set()
  const inflight = new Map() // task_id -> AbortController（桥断时中止本机执行）
  const sessionChains = new Map() // session_id -> tail promise（同会话串行）
  const liveSessions = new Map() // run:${runId} / task:${taskId} -> sessionId（在途映射，turn 结束即删）
  let depRetryTimer = null
  let depRetries = 0

  const bridge = new BackendWs({
    channel: 'dsh-bridge',
    onTask: (frame) => { void handleTask(frame) },
    onAppend: (frame) => { void handleAppend(frame) },
    onDecide: (frame) => { void handleDecide(frame) },
    onStatus: (st) => {
      if (st.status === 'closed' || st.status === 'idle') {
        abortInflight('桥接已断开')
        abortInteractive('桥接已断开')
      }
    },
  })

  // 本纤程状态（status 聚合的唯一写入点，随纤程消亡）。
  const state = {
    mode: 'starting',
    reason: '',
    deps: { sessionController: false, workspaceRegistry: false },
    bridge,
  }
  fiberStates.add(state)

  function readCfg() {
    return readConfig(config)
  }

  function hostUsable() {
    try {
      readCfg()
      return !disposed
    } catch {
      return false
    }
  }

  function rememberTaskId(taskId) {
    if (seenTaskIds.has(taskId)) return false
    seenTaskIds.add(taskId)
    if (seenTaskIds.size > MAX_SEEN_TASK_IDS) {
      const oldest = seenTaskIds.values().next()
      if (!oldest.done) seenTaskIds.delete(oldest.value)
    }
    return true
  }

  function abortInflight(reason) {
    for (const [taskId, ac] of inflight) {
      inflight.delete(taskId)
      try { ac.abort(new Error(reason)) } catch { /* 已结束 */ }
    }
  }

  // 在途交互（WP3：授权/提问双向）：sessionId → 在途 run 引用（turn 结束即删，
  // 与 liveSessions 同寿命）；interactivePending 按 interactive_id 等后端决议，
  // 桥断/卸载即失败闭环（授权回 unavailable，提问抛错进工具 isError）。
  // 拦截以 prepend 先于转发器与 UI：命中自有会话即认领（UI 零感知），
  // 他会话与不可识别一律 next() 透传，绝不劫持。
  const liveRuns = new Map() // sessionId -> { runId, taskId }
  const interactivePending = new Map() // interactive_id -> { kind, resolve, reject, onAbort }
  const interactiveDisposers = []

  function reply(taskId, payload) {
    try {
      bridge.sendFrame({ type: 'dsh_result', task_id: taskId, ...payload })
    } catch (error) {
      // 桥已断：结果无人收，后端会终结在途任务；本侧只记日志。
      console.error('muche dsh-bridge: 结果回传失败（桥已断）task=' + taskId.slice(0, 16),
        String(error && error.message ? error.message : error))
    }
  }

  async function handleTask(frame) {
    if (!hostUsable()) return
    const taskId = typeof frame.task_id === 'string' ? frame.task_id : ''
    if (!taskId) return
    if (!rememberTaskId(taskId)) return // 去重：同 id 重发不重复执行
    const sessionId = typeof frame.session_id === 'string' ? frame.session_id : ''
    if (sessionId) {
      // 同会话串行：排到该会话队尾，前任务结束（含监听退订）后才跑。
      const prev = sessionChains.get(sessionId) || Promise.resolve()
      const next = prev.then(() => runTask(frame, taskId), () => runTask(frame, taskId))
      sessionChains.set(sessionId, next)
      try { await next } finally {
        if (sessionChains.get(sessionId) === next) sessionChains.delete(sessionId)
      }
      return
    }
    await runTask(frame, taskId)
  }

  async function runTask(frame, taskId) {
    if (!hostUsable()) {
      reply(taskId, {
        ok: false,
        reply: '',
        session_id: typeof frame.session_id === 'string' ? frame.session_id : '',
        error: '插件已卸载',
      })
      return
    }
    const runId = typeof frame.run_id === 'string' ? frame.run_id : ''
    const frameSessionId = typeof frame.session_id === 'string' ? frame.session_id : ''
    const ac = new AbortController()
    inflight.set(taskId, ac)
    const liveKeys = []
    if (runId) liveKeys.push(`run:${runId}`)
    liveKeys.push(`task:${taskId}`)
    // 复用路径会话 id 已知：先登记，拦截即刻生效。
    let liveRunKey = null
    if (frameSessionId) {
      liveRunKey = frameSessionId
      liveRuns.set(frameSessionId, { runId, taskId })
    }
    try {
      const { reply: text, sessionId } = await executeDshTask(ctx, config, {
        task: frame.task,
        session_id: frame.session_id,
        agentPreset: frame.agentPreset,
        signal: ac.signal,
        onSessionCreated: (newId) => {
          // 在途映射（首轮 turn/end 前就可用）：占位会话的追单按 run/task 寻址。
          for (const k of liveKeys) liveSessions.set(k, newId)
          liveRunKey = newId
          liveRuns.set(newId, { runId, taskId })
          // 早期上报：后端回填工作区占位行（best-effort，失败不阻断执行）。
          try {
            bridge.sendFrame({ type: 'dsh_session_created', task_id: taskId, run_id: runId, session_id: newId })
          } catch { /* 桥已断：真 id 随 turn 结果回传，后端照常落账 */ }
        },
      })
      reply(taskId, { ok: true, reply: text, session_id: sessionId })
    } catch (error) {
      console.error('muche dsh-bridge: 任务执行失败 task=' + taskId.slice(0, 16),
        String(error && error.message ? error.message : error))
      reply(taskId, {
        ok: false,
        reply: '',
        session_id: typeof frame.session_id === 'string' ? frame.session_id : '',
        error: String(error && error.message ? error.message : error).slice(0, 300),
      })
    } finally {
      inflight.delete(taskId)
      // 映射只活到 turn 结束：之后追入会另起无人收的新轮，
      // 不如诚实回未知（后端走正常新 run 路径，不伪造送达）。
      for (const k of liveKeys) liveSessions.delete(k)
      if (liveRunKey) liveRuns.delete(liveRunKey)
      // 同 run 的交互等待一并终结：挂起的 tool promise 不能留给已死的 turn。
      abortInteractiveRun(runId, taskId, 'dsh turn 已结束')
    }
  }

  // 追单 append 链（与同会话 task 串行链独立）：append 必须趁在途 turn
  // 没结束时发出去才能并进同一轮，故不排在 task 链后；多个 append 之间
  // 按到达序串行。只发 prompt（steer 模式，进当前轮下一个 step 边界，
  // 闲时自动开新轮），不等 turn/end——在途 waiter 会收到合并后的最终
  // 结果，最终只出一个结果。寻址优先 session_id，空占位按 run/task 查
  // 在途映射；turn 已结束（映射已删）即诚实回未知，后端走正常新 run。
  const appendChains = new Map() // session_id -> tail promise（append 间串行）

  async function handleAppend(frame) {
    if (!hostUsable()) return
    const appendId = typeof frame.append_id === 'string' ? frame.append_id : ''
    if (!appendId) return
    if (!rememberTaskId(appendId)) return // 去重：同 id 重发不重复执行
    const text = typeof frame.task === 'string' ? frame.task.trim().slice(0, 4000) : ''
    if (!text) {
      ackAppend(appendId, '', false, '缺少 task')
      return
    }
    // 寻址：session_id 已知直达；空占位（首轮未结束、后端尚无真 id）按
    // run/task 查在途映射；都 miss 即诚实回未知（后端走正常新 run 路径）。
    let sessionId = typeof frame.session_id === 'string' ? frame.session_id : ''
    if (!sessionId) {
      const runId = typeof frame.run_id === 'string' ? frame.run_id : ''
      const taskRef = typeof frame.task_id === 'string' ? frame.task_id : ''
      sessionId = (runId && liveSessions.get(`run:${runId}`))
        || (taskRef && liveSessions.get(`task:${taskRef}`))
        || ''
    }
    if (!sessionId) {
      console.error('muche dsh-bridge: 追单无在途会话 append=' + appendId.slice(0, 16))
      ackAppend(appendId, '', false, '未知会话（不在途）')
      return
    }
    const prev = appendChains.get(sessionId) || Promise.resolve()
    const next = prev.then(() => runAppend(frame, appendId, sessionId, text), () => runAppend(frame, appendId, sessionId, text))
    appendChains.set(sessionId, next)
    try { await next } finally {
      if (appendChains.get(sessionId) === next) appendChains.delete(sessionId)
    }
  }

  async function runAppend(frame, appendId, sessionId, text) {
    if (!hostUsable()) {
      ackAppend(appendId, sessionId, false, '插件已卸载')
      return
    }
    try {
      // 常开 signal：只满足 prompt 必传 signal 的接口要求，不主动取消。
      // steer 进当前轮下一个 step 边界（闲时自动开新轮），在途 waiter
      // 收到合并后的最终结果，最终只出一个结果。queue 会另起一轮，
      // 与单 waiter 语义冲突，禁用。
      const ac = new AbortController()
      inflight.set(appendId, ac)
      try {
        try {
          await promptSession(ctx, sessionId, text, ac.signal, 'steer')
        } catch (steerError) {
          // 当前轮已不收转向（如边界竞态）：回落 queue 另起一轮，
          // 结果仍由在途链收敛，不静默丢。
          if (!/steer-unavailable/.test(String(steerError && steerError.message ? steerError.message : steerError))) throw steerError
          console.error('muche dsh-bridge: 追单转向不可用，回落 queue append=' + appendId.slice(0, 16))
          await promptSession(ctx, sessionId, text, ac.signal, 'queue')
        }
      } finally {
        inflight.delete(appendId)
      }
      ackAppend(appendId, sessionId, true, '')
    } catch (error) {
      console.error('muche dsh-bridge: 追单发送失败 append=' + appendId.slice(0, 16),
        String(error && error.message ? error.message : error))
      ackAppend(appendId, sessionId, false,
        String(error && error.message ? error.message : error).slice(0, 300))
    }
  }

  function ackAppend(appendId, sessionId, ok, error) {
    try {
      bridge.sendFrame({ type: 'dsh_append_result', append_id: appendId, session_id: sessionId, ok, error: String(error || '').slice(0, 300) })
    } catch {
      // 桥已断：后端会从日志看到缺失；本侧只记日志。
      console.error('muche dsh-bridge: 追单回执发送失败（桥已断）append=' + String(appendId).slice(0, 16))
    }
  }

  // ── 在途交互（授权/提问）：上游 waterfall 转后端决议 ──

  function ownRunOf(agent) {
    const id = agent && (agent.id || agent.sessionId)
    if (id === undefined || id === null) return null
    const ref = liveRuns.get(String(id))
    if (!ref) return null
    return { sessionId: String(id), runId: ref.runId, taskId: ref.taskId }
  }

  function sendInteractive(payload) {
    try {
      bridge.sendFrame({ type: 'dsh_interactive', ...payload })
      return true
    } catch {
      return false
    }
  }

  function settleInteractive(interactiveId, fn) {
    const entry = interactivePending.get(interactiveId)
    if (!entry) {
      console.error('muche dsh-bridge: 决议无在途等待 id=' + String(interactiveId).slice(0, 32))
      return false
    }
    interactivePending.delete(interactiveId)
    if (entry.onAbort) {
      try { entry.onAbort() } catch { /* 已解绑 */ }
    }
    fn(entry)
    return true
  }

  function abortInteractive(reason) {
    for (const [id, entry] of interactivePending) {
      interactivePending.delete(id)
      if (entry.onAbort) {
        try { entry.onAbort() } catch { /* 已解绑 */ }
      }
      try {
        // 失败闭环：授权回 unavailable，提问抛错进工具 isError 结果。
        if (entry.kind === 'approval') entry.resolve('unavailable')
        else entry.reject(new Error(reason))
      } catch { /* 调用方已走远 */ }
    }
  }

  function watchAbortSignal(entry, interactiveId, signal) {
    if (!signal || typeof signal.addEventListener !== 'function') return
    if (signal.aborted) {
      if (interactivePending.get(interactiveId) === entry) {
        interactivePending.delete(interactiveId)
        try {
          if (entry.kind === 'approval') entry.resolve('unavailable')
          else entry.reject(new Error('dsh 交互等待已取消'))
        } catch { /* 调用方已走远 */ }
      }
      return
    }
    const onAbort = () => {
      if (interactivePending.get(interactiveId) === entry) {
        interactivePending.delete(interactiveId)
        try {
          if (entry.kind === 'approval') entry.resolve('unavailable')
          else entry.reject(new Error('dsh 交互等待已取消'))
        } catch { /* 调用方已走远 */ }
      }
    }
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { /* 无 signal 语义 */ return }
    entry.onAbort = () => {
      try { signal.removeEventListener('abort', onAbort) } catch { /* 已解绑 */ }
    }
  }

  function waitInteractive(runId, taskId, interactiveId, kind, signal) {
    return new Promise((resolve, reject) => {
      const entry = { kind, resolve, reject, onAbort: null, runId, taskId }
      interactivePending.set(interactiveId, entry)
      watchAbortSignal(entry, interactiveId, signal)
    })
  }

  function abortInteractiveRun(runId, taskId, reason) {
    // turn 终结（完成/失败/超时）时清掉该 run 的交互等待：挂起的 tool
    // promise 不能留给已死的 turn，否则 agent 侧 tool 调用永 treo。
    for (const [id, entry] of interactivePending) {
      if (entry.runId !== runId && entry.taskId !== taskId) continue
      interactivePending.delete(id)
      if (entry.onAbort) {
        try { entry.onAbort() } catch { /* 已解绑 */ }
      }
      try {
        if (entry.kind === 'approval') entry.resolve('unavailable')
        else entry.reject(new Error(reason))
      } catch { /* 调用方已走远 */ }
    }
  }

  async function handleApproval(req, next) {
    const own = ownRunOf(req && req.agent)
    if (!own || !own.runId) return next()
    const callId = req && typeof req.callId === 'string' ? req.callId : ''
    const interactiveId = `${own.runId}:approval:${callId || 'noid'}`
    const payload = {
      toolName: req && typeof req.toolName === 'string' ? req.toolName : '',
      callId,
      reason: req && typeof req.reason === 'string' ? req.reason.slice(0, 500) : '',
    }
    const sent = sendInteractive({
      run_id: own.runId, task_id: own.taskId, session_id: own.sessionId,
      interactive_id: interactiveId, kind: 'approval', payload,
    })
    if (!sent) return 'unavailable'
    return waitInteractive(own.runId, own.taskId, interactiveId, 'approval', req && req.signal)
  }

  function trimQuestions(questions) {
    if (!Array.isArray(questions)) return []
    return questions.slice(0, 5).map((q) => {
      if (!q || typeof q !== 'object') return null
      const out = {}
      if (typeof q.id === 'string') out.id = q.id
      if (typeof q.question === 'string') out.question = q.question.slice(0, 500)
      if (typeof q.detail === 'string') out.detail = q.detail.slice(0, 500)
      if (typeof q.header === 'string') out.header = q.header
      if (typeof q.multiSelect === 'boolean') out.multiSelect = q.multiSelect
      if (Array.isArray(q.options)) {
        out.options = q.options.slice(0, 6).map((o) => {
          if (!o || typeof o !== 'object') return null
          const opt = {}
          if (typeof o.label === 'string') opt.label = o.label
          if (typeof o.description === 'string') opt.description = o.description.slice(0, 200)
          return opt
        }).filter(Boolean)
      }
      return out
    }).filter(Boolean)
  }

  async function handleQuestion(req, next) {
    const own = ownRunOf(req && req.agent)
    if (!own || !own.runId) return next()
    const questions = trimQuestions(req ? req.questions : [])
    const ids = questions.map((q) => q.id).filter(Boolean).sort()
    const interactiveId = `${own.runId}:question:${ids.join('+') || 'noid'}`
    const sent = sendInteractive({
      run_id: own.runId, task_id: own.taskId, session_id: own.sessionId,
      interactive_id: interactiveId, kind: 'question', payload: { questions },
    })
    if (!sent) throw new Error('dsh 交互通道已断开')
    return waitInteractive(own.runId, own.taskId, interactiveId, 'question', req && req.signal)
  }

  function handleDecide(frame) {
    if (!hostUsable()) return
    const interactiveId = typeof frame.interactive_id === 'string' ? frame.interactive_id : ''
    if (!interactiveId) return
    settleInteractive(interactiveId, (entry) => {
      if (entry.kind === 'approval') {
        const outcome = frame.outcome === 'allowed-once' || frame.outcome === 'rejected'
          ? frame.outcome
          : 'unavailable'
        entry.resolve(outcome)
      } else if (frame.answer && typeof frame.answer === 'object') {
        entry.resolve(frame.answer)
      } else {
        entry.reject(new Error('dsh 回执缺少答案'))
      }
    })
  }

  function registerInteractive() {
    // prepend 先于转发器与 UI：命中即认领，他会话与不可识别走 next()。
    try {
      const d1 = ctx.on('approval/request', (req, next) => handleApproval(req, next), { prepend: true })
      if (typeof d1 === 'function') interactiveDisposers.push(d1)
      const d2 = ctx.on('user-questions/request', (req, next) => handleQuestion(req, next), { prepend: true })
      if (typeof d2 === 'function') interactiveDisposers.push(d2)
    } catch (error) {
      console.error('muche dsh-bridge: 交互拦截注册失败（授权/提问将回退 UI）',
        String(error && error.message ? error.message : error))
    }
  }

  function depsOk() {
    const sc = ctx.get('sessionController')
    const wr = ctx.get('workspaceRegistry')
    state.deps = { sessionController: !!sc, workspaceRegistry: !!wr }
    return !!sc && !!wr
  }

  function clearDepRetry() {
    if (depRetryTimer) {
      clearTimeout(depRetryTimer)
      depRetryTimer = null
    }
  }

  function scheduleDepRetry() {
    if (disposed || depRetryTimer || depRetries >= DEP_RETRY_DELAYS_MS.length) return
    const delay = DEP_RETRY_DELAYS_MS[depRetries++]
    depRetryTimer = setTimeout(() => {
      depRetryTimer = null
      void refresh()
    }, delay)
    // 不拖住事件循环：重试只是自愈尝试，进程退出/测试结束不等它。
    if (typeof depRetryTimer.unref === 'function') depRetryTimer.unref()
  }

  async function refresh() {
    if (disposed || !hostUsable()) return
    if (!depsOk()) {
      const missing = [
        !state.deps.sessionController && 'sessionController',
        !state.deps.workspaceRegistry && 'workspaceRegistry',
      ].filter(Boolean).join('/')
      state.mode = 'disabled'
      state.reason = `缺少本地执行依赖（${missing}）：宿主行尚未挂载，有界自愈中，重存配置立即重试`
      bridge.stop()
      scheduleDepRetry()
      return
    }
    clearDepRetry()
    depRetries = 0
    const cfg = readCfg()
    if (!cfg.apiKey) {
      state.mode = 'waiting-key'
      state.reason = '未配置 API key：去 设置 → 小沐 填写保存'
      bridge.stop()
      return
    }
    const normUrl = String(cfg.backendUrl || '').replace(/\/+$/, '')
    if (bridge.apiKey !== cfg.apiKey || String(bridge.backendUrl || '').replace(/\/+$/, '') !== normUrl) {
      // 换 key/换地址即换连：不断旧连就是下一轮半残。
      bridge.stop()
    }
    bridge.backendUrl = cfg.backendUrl
    bridge.apiKey = cfg.apiKey
    bridge.start()
    state.mode = 'active'
    state.reason = ''
  }

  refreshHooks.add(refresh)

  // 交互拦截与任务通道同寿命：加载即注册，卸载即摘除。
  // waterfall 监听与连接状态无关（无 key 时收到请求也只会 next 透传）。
  registerInteractive()

  // 插件加载即起（有 key 才真连，无 key 时 start 内部保持 stopped）。
  void refresh()

  ctx.on('dispose', () => {
    disposed = true
    refreshHooks.delete(refresh)
    fiberStates.delete(state)
    clearDepRetry()
    for (const dispose of interactiveDisposers.splice(0)) {
      try { dispose() } catch { /* 已摘除 */ }
    }
    abortInflight('插件卸载')
    abortInteractive('插件卸载')
    bridge.dispose()
  })
}
