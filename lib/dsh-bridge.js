/** Bridge runtime: host-bound commands, opaque interaction occurrences and applied receipts.
 * Shared host state serves double-mounted fibers; only each fiber's own tasks abort on disposal.
 * Applied receipts survive resolver removal; active runs are retained, terminal cache is bounded.
 */
import { randomUUID, createHash } from 'node:crypto'
import { ChannelConnection } from './connections.js'
import { readConfig, writeConfig } from './config.js'
import { executeDshTask, steerOwnedTurn, failure, PROTOCOL } from './dsh-call.js'

const MAX_RECEIPTS = 200
const DEP_RETRY_DELAYS_MS = [5000, 15000, 30000]
const fibers = new Set()
const identities = new WeakMap()
const hosts = new Map()
export function requestDshBridgeRefresh() {
  return Promise.allSettled([...fibers].map((f) => f.refresh())).then(() => undefined)
}
export function getDshBridgeStatus() {
  return { fibers: [...fibers].map((f) => ({ mode: f.state.mode, reason: f.state.reason, deps: { ...f.state.deps }, bridge: f.bridgeChannel.getState() })) }
}

async function identity(ctx, config) {
  const service = ctx.get('sessionController')
  if (!identities.has(service)) {
    identities.set(service, (async () => {
      const existing = readConfig(config).bridgeId
      const id = existing || randomUUID()
      if (!existing) await writeConfig(ctx, { bridgeId: id })
      return id
    })().catch((error) => { identities.delete(service); throw error }))
  }
  return identities.get(service)
}

export function validAnswers(payload, answer) {
  const questions = payload?.questions
  const answers = answer?.answers
  if (!Array.isArray(questions) || !Array.isArray(answers) || answers.length !== questions.length) return false
  const ids = new Set()
  for (const q of questions) {
    const matches = answers.filter((a) => a?.id === q.id)
    if (matches.length !== 1 || ids.has(q.id)) return false
    ids.add(q.id)
    const a = matches[0]
    const selected = a.selected ?? []
    const custom = a.custom ?? ''
    const options = (q.options || []).map((o) => o.label)
    if (!Array.isArray(selected) || !selected.every((label) => options.includes(label)) || new Set(selected).size !== selected.length) return false
    if (!q.multiSelect && selected.length > 1) return false
    if (typeof custom !== 'string' || (!selected.length && !custom.trim())) return false
  }
  return true
}

export function registerDshBridge(ctx, config) {
  let disposed = false
  let retryTimer = null
  let retries = 0
  let hostId = ''
  let runtime
  const inflight = new Map()
  const state = { mode: 'starting', reason: '', deps: {} }
  const bridgeChannel = new ChannelConnection({ channel: 'dsh-bridge' })
  const disposers = []
  const fiber = { state, bridgeChannel, refresh }
  fibers.add(fiber)
  const usable = () => !disposed
  const send = (frame) => bridgeChannel.current.sendFrame({ ...frame, host_id: hostId })
  function safeSend(frame) {
    try { send(frame); return true } catch (error) {
      console.error('muche dsh-bridge: receipt unavailable', frame.type, String(error?.message || error))
      return false
    }
  }
  function cache(key, fingerprint, frame) {
    runtime.receipts.set(key, { fingerprint, frame })
    pruneReceipts()
    safeSend(frame)
  }
  function pruneReceipts() {
    for (const [key, entry] of runtime.receipts) {
      if (runtime.receipts.size <= MAX_RECEIPTS) break
      if (!runtime.sessions.has(entry.frame.run_id)) runtime.receipts.delete(key)
    }
  }
  function fingerprint(frame) {
    return createHash('sha256').update(JSON.stringify([frame.type, frame.run_id, frame.interactive_id, frame.session_id, frame.task, frame.outcome, frame.answer, frame.error])).digest('hex')
  }
  function replay(key, frame, responseType) {
    const existing = runtime.receipts.get(key)
    if (!existing) return false
    safeSend(existing.fingerprint === fingerprint(frame) ? existing.frame : { type: responseType, command_id: key, append_id: key, task_id: key, ok: false, code: 'command_conflict' })
    return true
  }
  function abortOwn(reason) {
    for (const ac of inflight.values()) ac.abort(new Error(reason))
  }
  async function handleTask(frame) {
    if (!usable() || !runtime || !frame.task_id) return
    const id = frame.task_id
    if (replay(id, frame, 'dsh_result')) return
    if (runtime.tasks.has(id)) {
      const existing = runtime.tasks.get(id)
      safeSend(existing.fingerprint === fingerprint(frame)
        ? { type: 'dsh_task_started', task_id: id, run_id: frame.run_id, admitted: existing.admitted }
        : { type: 'dsh_result', task_id: id, run_id: frame.run_id, ok: false, code: 'command_conflict', admitted: false })
      return
    }
    const task = { admitted: false, fingerprint: fingerprint(frame) }
    runtime.tasks.set(id, task)
    const previous = runtime.chains.get(frame.session_id) || Promise.resolve()
    const job = previous.catch(() => {}).then(async () => {
      const ac = new AbortController()
      inflight.set(id, ac)
      let sessionId = frame.session_id || ''
      try {
        if (!usable()) throw Object.assign(new Error('bridge disposed before admission'), { code: 'cancelled', admitted: false })
        const result = await executeDshTask(ctx, config, {
          task: frame.task, session_id: sessionId, taskId: id, agentPreset: frame.agentPreset, signal: ac.signal,
          isWaiting: () => [...runtime.interactions.values()].some((entry) => entry.runId === frame.run_id),
          onSessionCreated: (sid) => {
            sessionId = sid
            runtime.sessions.set(frame.run_id, sid)
            safeSend({ type: 'dsh_session_created', task_id: id, run_id: frame.run_id, session_id: sid })
          },
          onAdmitted: (sid) => { task.admitted = true; safeSend({ type: 'dsh_task_started', task_id: id, run_id: frame.run_id, session_id: sid, admitted: true }) },
          onTurnStarted: () => { runtime.runs.set(sessionId, { runId: frame.run_id, taskId: id }) },
          onTurnEnded: () => { if (runtime.runs.get(sessionId)?.taskId === id) runtime.runs.delete(sessionId) },
        })
        cache(id, fingerprint(frame), { type: 'dsh_result', task_id: id, run_id: frame.run_id, ok: true, code: 'ok', reply: result.reply, session_id: result.sessionId, admitted: true })
      } catch (error) {
        const observation = failure(error, { admitted: error && 'admitted' in error ? error.admitted : task.admitted, partial: error?.partial || '', sessionId: error?.sessionId || sessionId })
        cache(id, fingerprint(frame), { type: 'dsh_result', task_id: id, run_id: frame.run_id, ok: false, code: observation.code, source_code: observation.source_code, error: observation.message, reply: observation.partial, session_id: observation.sessionId, admitted: observation.admitted })
      } finally {
        inflight.delete(id)
        runtime.tasks.delete(id)
        runtime.sessions.delete(frame.run_id)
        if (runtime.runs.get(sessionId)?.taskId === id) runtime.runs.delete(sessionId)
        for (const [iid, entry] of runtime.interactions) if (entry.taskId === id) closeInteractive(iid, entry, 'turn ended')
        pruneReceipts()
      }
    })
    if (frame.session_id) runtime.chains.set(frame.session_id, job)
    try { await job } finally { if (runtime.chains.get(frame.session_id) === job) runtime.chains.delete(frame.session_id) }
  }
  async function handleAppend(frame) {
    if (!usable() || !runtime || !frame.append_id) return
    const id = frame.append_id
    if (replay(id, frame, 'dsh_append_result')) return
    if (runtime.controls.has(id)) return
    runtime.controls.add(id)
    const sid = frame.session_id || runtime.sessions.get(frame.run_id) || ''
    const previous = runtime.appends.get(sid) || Promise.resolve()
    let release
    const waiting = new Promise((resolve) => { release = resolve })
    runtime.appends.set(sid, waiting)
    await previous
    let result
    let promptAttempted = false
    try {
      if (!usable()) throw Object.assign(new Error('bridge disposed before append admission'), { code: 'cancelled' })
      const owner = runtime.runs.get(sid)
      if (!owner || owner.runId !== frame.run_id) throw Object.assign(new Error('no active owned turn for append'), { code: runtime.sessions.get(frame.run_id) === sid ? 'turn_pending' : 'admission_rejected' })
      const ac = new AbortController()
      inflight.set(id, ac)
      promptAttempted = true
      steerOwnedTurn(ctx, sid, frame.task, `muche-append-${id}`, () => runtime.runs.get(sid)?.runId === frame.run_id)
      result = { ok: true, code: 'ok', admitted: true }
    } catch (error) {
      const observed = failure(error)
      result = { ok: false, code: observed.code, error: observed.message, admitted: observed.code === 'unknown' && promptAttempted ? null : false }
    } finally {
      inflight.delete(id); runtime.controls.delete(id)
      release()
      if (runtime.appends.get(sid) === waiting) runtime.appends.delete(sid)
    }
    const response = { type: 'dsh_append_result', append_id: id, run_id: frame.run_id, session_id: sid, ...result }
    if (result.code === 'turn_pending') safeSend(response)
    else cache(id, fingerprint(frame), response)
  }
  async function handleQuery(frame) {
    let observed
    if (frame.task_id) {
      const result = runtime?.receipts.get(frame.task_id)?.frame
      for (const [iid, entry] of runtime?.interactions || []) {
        if (entry.taskId === frame.task_id) safeSend({ type: 'dsh_interactive', run_id: entry.runId, task_id: entry.taskId, session_id: runtime.sessions.get(entry.runId), interactive_id: iid, kind: entry.kind, payload: entry.payload })
      }
      safeSend({ type: 'dsh_session_query_result', command_id: frame.command_id, stage: result ? 'finished' : runtime?.tasks.has(frame.task_id) ? 'active' : 'unknown', result, ok: !!result || runtime?.tasks.has(frame.task_id) })
      return
    }
    try {
      const sc = ctx.get('sessionController')
      if (typeof sc?.inspect !== 'function') throw Object.assign(new Error('inspect unavailable'), { code: 'host_not_ready' })
      await sc.inspect(frame.session_id, new AbortController().signal)
      observed = { ok: true }
    } catch (error) { const e = failure(error); observed = { ok: false, code: e.code, error: e.message } }
    safeSend({ type: 'dsh_session_query_result', command_id: frame.command_id, session_id: frame.session_id, ...observed })
  }
  function closeInteractive(iid, entry, error) {
    runtime.interactions.delete(iid)
    entry.cleanup?.()
    if (entry.kind === 'approval') entry.resolve('unavailable')
    else entry.reject(new Error(error))
  }
  function handleDecide(frame) {
    if (!runtime || !frame.command_id) return
    const id = frame.command_id
    if (replay(id, frame, 'dsh_decide_result')) return
    const iid = frame.interactive_id
    const entry = runtime.interactions.get(iid)
    let code = ''
    if (!entry || entry.runId !== frame.run_id) code = 'interactive_expired'
    else if (!frame.error && (entry.kind === 'approval' ? !['allowed-once', 'rejected'].includes(frame.outcome) || !!frame.answer : !validAnswers(entry.payload, frame.answer) || !!frame.outcome)) code = 'invalid_answer'
    if (code) { cache(id, fingerprint(frame), { type: 'dsh_decide_result', command_id: id, interactive_id: iid, run_id: frame.run_id, ok: false, code }); return }
    if (frame.error) closeInteractive(iid, entry, frame.error)
    else {
      runtime.interactions.delete(iid)
      entry.cleanup?.()
      entry.resolve(entry.kind === 'approval' ? frame.outcome : frame.answer)
    }
    cache(id, fingerprint(frame), { type: 'dsh_decide_result', command_id: id, interactive_id: iid, run_id: frame.run_id, ok: true, code: 'ok' })
  }
  function interaction(kind, req, next) {
    const sessionId = String(req?.agent?.id || req?.agent?.sessionId || '')
    const own = runtime?.runs.get(sessionId)
    if (!own?.runId) return next()
    const iid = `${own.runId}:${kind}:${randomUUID()}`
    const payload = kind === 'question' ? { questions: req.questions, intent: req.intent, callId: req.callId } : { toolName: req.toolName || '', callId: req.callId || '', reason: req.reason || '' }
    const promise = new Promise((resolve, reject) => {
      const entry = { kind, payload, resolve, reject, runId: own.runId, taskId: own.taskId }
      runtime.interactions.set(iid, entry)
      const aborted = () => closeInteractive(iid, entry, 'interaction cancelled')
      req.signal?.addEventListener('abort', aborted, { once: true })
      entry.cleanup = () => req.signal?.removeEventListener('abort', aborted)
      if (req.signal?.aborted) aborted()
    })
    // Resolver is installed before reporting; a synchronous backend decision is safe.
    if (runtime.interactions.has(iid) && !safeSend({ type: 'dsh_interactive', run_id: own.runId, task_id: own.taskId, session_id: sessionId, interactive_id: iid, kind, payload })) closeInteractive(iid, runtime.interactions.get(iid), 'bridge disconnected')
    return promise
  }
  const handlers = {
    onTask: (f) => { void handleTask(f) }, onAppend: (f) => { void handleAppend(f) }, onDecide: handleDecide, onQuery: (f) => { void handleQuery(f) },
    onStatus: (st) => {
      if (st.status === 'open') safeSend({ type: 'dsh_hello', protocol: PROTOCOL.version, capabilities: PROTOCOL.capabilities })
      if (st.status === 'closed' || st.status === 'idle') abortOwn('bridge disconnected')
    },
  }
  async function refresh() {
    if (disposed) return
    const sc = ctx.get('sessionController')
    const wr = ctx.get('workspaceRegistry')
    state.deps = { sessionController: !!sc, workspaceRegistry: !!wr }
    if (!sc || !wr) {
      state.mode = 'disabled'; state.reason = '缺少本地执行依赖：sessionController/workspaceRegistry'
      bridgeChannel.stop()
      if (!retryTimer && retries < DEP_RETRY_DELAYS_MS.length) { retryTimer = setTimeout(() => { retryTimer = null; void refresh() }, DEP_RETRY_DELAYS_MS[retries++]); retryTimer.unref?.() }
      return
    }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    retries = 0
    const cfg = readConfig(config)
    if (!cfg.apiKey) { state.mode = 'waiting-key'; state.reason = '未配置 API key：去 设置 → 小沐 填写保存'; bridgeChannel.stop(); return }
    try { hostId = await identity(ctx, config) } catch (error) {
      state.mode = 'disabled'; state.reason = '宿主身份无法经官方配置保存'
      console.error('muche dsh-bridge: host identity failed', String(error?.message || error)); return
    }
    if (disposed) return
    if (!hosts.has(hostId)) hosts.set(hostId, { receipts: new Map(), tasks: new Map(), controls: new Set(), chains: new Map(), appends: new Map(), runs: new Map(), sessions: new Map(), interactions: new Map() })
    runtime = hosts.get(hostId)
    bridgeChannel.sync({ backendUrl: cfg.backendUrl, apiKey: cfg.apiKey, handlers })
    state.mode = 'active'; state.reason = ''
  }
  disposers.push(ctx.on('approval/request', (req, next) => interaction('approval', req, next), { prepend: true }))
  disposers.push(ctx.on('user-questions/request', (req, next) => interaction('question', req, next), { prepend: true }))
  void refresh()
  ctx.on('dispose', () => {
    disposed = true; fibers.delete(fiber)
    if (retryTimer) clearTimeout(retryTimer)
    for (const dispose of disposers) dispose?.()
    abortOwn('plugin disposed'); bridgeChannel.dispose()
  })
}
