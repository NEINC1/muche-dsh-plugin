/** Bridge runtime: host-bound commands, opaque interaction occurrences and applied receipts.
 * Host caches share only an irreversible backend/key scope, never unproved cross-key ownership.
 * Commands capture an explicit origin; late receipts stay in that scope and cannot enter new config.
 * Applied receipts survive resolver removal; active runs are retained, terminal cache is bounded.
 */
import { randomUUID, createHash } from 'node:crypto'
import { ChannelConnection, fingerprint as connectionFingerprint } from './connections.js'
import { normalizeBackendUrl } from './backend.js'
import { readConfig, writeConfig } from './config.js'
import { BRIDGE_DEPENDENCIES, BRIDGE_STARTUP, BRIDGE_OFFLINE } from './errors.js'
import { executeDshTask, steerOwnedTurn, failure, PROTOCOL } from './dsh-call.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const MAX_RECEIPTS = 200
const DEP_RETRY_DELAYS_MS = [5000, 15000, 30000]
const fibers = new Set()
const identities = new WeakMap()
const hosts = new Map()
let receiptOrder = 0

export function requestDshBridgeRefresh() {
  return Promise.allSettled([...fibers].map((f) => f.refresh())).then(() => undefined)
}
export function getDshBridgeStatus() {
  return { fibers: [...fibers].map((f) => f.getState()) }
}

async function identity(ctx, cfg, service) {
  if (cfg.bridgeId) return cfg.bridgeId
  if (!identities.has(service)) {
    identities.set(service, (async () => {
      const id = randomUUID()
      await writeConfig(ctx, { bridgeId: id })
      return id
    })().catch((error) => { identities.delete(service); throw error }))
  }
  return identities.get(service)
}

const sameContext = (a, b) => a?.runtimeId === b?.runtimeId && a?.configNs === b?.configNs && a?.generation === b?.generation

export function normalizeAnswers(payload, answer) {
  const questions = payload?.questions
  const answers = answer?.answers
  if (!Array.isArray(questions) || !Array.isArray(answers) || answers.length !== questions.length) return null
  const ids = new Set()
  const normalized = []
  for (const q of questions) {
    const matches = answers.filter((a) => a?.id === q.id)
    if (matches.length !== 1 || ids.has(q.id)) return null
    ids.add(q.id)
    const a = matches[0]
    const selected = a.selected ?? []
    const custom = a.custom
    const options = (q.options || []).map((o) => o.label)
    if (!Array.isArray(selected) || !selected.every((label) => options.includes(label)) || new Set(selected).size !== selected.length) return null
    if (!q.multiSelect && selected.length > 1) return null
    if (custom != null && typeof custom !== 'string') return null
    normalized.push({ id: q.id, selected: [...selected], ...(custom != null ? { custom } : {}) })
  }
  return { answers: normalized }
}

export const validAnswers = (payload, answer) => normalizeAnswers(payload, answer) !== null

export function registerDshBridge(ctx, config, options = {}) {
  let disposed = false
  let retryTimer = null
  let retries = 0
  let refreshEpoch = 0
  let scopeInitialized = false
  let activeContext
  let fallbackFingerprint = ''
  let connectionTicket = null
  let activeOrigin = null
  let retiringOrigin = null
  let retirement = null
  let configScope = ''
  const retryDelays = options.dependencyRetryDelays || DEP_RETRY_DELAYS_MS
  const inflight = new Map()
  const state = { phase: 'not-started', startupComplete: false, mode: 'waiting-key', reason: '', deps: {} }
  const bridgeChannel = new ChannelConnection({ channel: 'dsh-bridge', createTransport: options.createTransport })
  const disposers = []
  const controller = { refresh, getState, dispose }
  fibers.add(controller)
  const contextCurrent = (context) => !options.getContext || sameContext(options.getContext(), context)
  const usable = (origin, admissionEpoch = origin?.admissionEpoch) => !disposed && origin === activeOrigin && !!origin?.accepting && !origin.retired && origin.admissionEpoch === admissionEpoch && contextCurrent(origin.context)
  function getState() {
    return { ...state, deps: { ...state.deps }, bridge: bridgeChannel.getState() }
  }
  function publish(context = activeContext) {
    if (!contextCurrent(context)) return
    try {
      options.onState?.({ phase: state.phase, startupComplete: state.startupComplete, ...(state.code ? { code: state.code } : {}), ...(state.reason ? { reason: state.reason } : {}) }, context)
    } catch (error) { console.error('muche dsh-bridge: state subscriber failed', error?.name || 'Error') }
  }
  function transition(phase, startupComplete, { code, reason = '', mode = state.mode } = {}, context = activeContext) {
    if (disposed || !contextCurrent(context)) return
    Object.assign(state, { phase, startupComplete, reason, mode })
    if (code) state.code = code
    else delete state.code
    publish(context)
  }
  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }
  function closeOwnInteractions(origin, reason) {
    if (!origin) return
    for (const [iid, entry] of [...origin.runtime.interactions]) {
      if (entry.origin === origin) closeInteractive(origin, iid, entry, reason)
    }
    for (const [iid, entry] of origin.runtime.native) if (entry.origin === origin) origin.runtime.native.delete(iid)
  }
  function interruptOrigin(origin, reason) {
    if (!origin) return
    origin.accepting = false
    origin.admissionEpoch += 1
    abortOwn(reason, origin)
    closeOwnInteractions(origin, reason)
  }
  function stopConnection(reason) {
    connectionTicket = null
    interruptOrigin(activeOrigin, reason)
    bridgeChannel.stop()
  }
  function retireActive(reason) {
    const origin = activeOrigin
    if (!origin) return retirement
    activeOrigin = null
    origin.retired = true
    origin.runtime.references -= 1
    retiringOrigin = origin
    connectionTicket = null
    interruptOrigin(origin, reason)
    pruneReceipts(origin)
    const pending = (async () => {
      // Settled observers get receipt microtasks on the old channel; pending host IO is never
      // awaited. Later results remain in the original cache behind the explicit origin gate.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      if (bridgeChannel.current === origin.transport) bridgeChannel.stop()
      if (retiringOrigin === origin) retiringOrigin = null
    })()
    retirement = pending
    pending.then(() => { if (retirement === pending) retirement = null })
    return pending
  }
  function safeSend(origin, frame) {
    const current = origin && origin === activeOrigin && !origin.retired && contextCurrent(origin.context)
    const retiring = origin && origin === retiringOrigin && origin.transport && bridgeChannel.current === origin.transport
    if (disposed || (!current && !retiring)) {
      console.warn('muche dsh-bridge: stale-origin output retained locally', frame.type)
      return false
    }
    try {
      bridgeChannel.current.sendFrame({ ...frame, host_id: origin.hostId })
      return true
    } catch (error) {
      console.error('muche dsh-bridge: receipt unavailable', frame.type, String(error?.message || error))
      return false
    }
  }
  function cache(origin, key, fingerprint, frame) {
    origin.runtime.receipts.set(key, { fingerprint, frame, order: ++receiptOrder })
    pruneReceipts(origin)
    safeSend(origin, frame)
  }
  function pruneReceipts(origin) {
    const terminal = []
    for (const runtime of hosts.values()) {
      if (runtime.hostId !== origin.hostId) continue
      for (const [key, entry] of runtime.receipts) {
        if (!runtime.sessions.has(entry.frame.run_id)) terminal.push({ runtime, key, order: entry.order })
      }
    }
    terminal.sort((a, b) => a.order - b.order)
    for (const { runtime, key } of terminal.slice(0, Math.max(0, terminal.length - MAX_RECEIPTS))) runtime.receipts.delete(key)
    for (const [key, runtime] of hosts) {
      if (runtime.hostId !== origin.hostId || runtime.references > 0) continue
      if ([runtime.receipts, runtime.tasks, runtime.controls, runtime.chains, runtime.appends, runtime.runs, runtime.sessions, runtime.interactions, runtime.calls, runtime.native, runtime.continued].every((entries) => entries.size === 0)) hosts.delete(key)
    }
  }
  function fingerprint(frame) {
    return createHash('sha256').update(JSON.stringify([frame.type, frame.run_id, frame.interactive_id, frame.session_id, frame.task, frame.outcome, frame.answer, frame.error])).digest('hex')
  }
  function replay(origin, key, frame, responseType) {
    const existing = origin.runtime.receipts.get(key)
    if (!existing) return false
    safeSend(origin, existing.fingerprint === fingerprint(frame) ? existing.frame : { type: responseType, command_id: key, append_id: key, task_id: key, ok: false, code: 'command_conflict' })
    return true
  }
  function abortOwn(reason, origin) {
    for (const entry of inflight.values()) if (!origin || entry.origin === origin) entry.controller.abort(new Error(reason))
  }
  function ambiguousTask(origin, id) {
    for (const runtime of hosts.values()) {
      if (runtime === origin.runtime || runtime.hostId !== origin.hostId) continue
      if (runtime.tasks.has(id) || runtime.receipts.get(id)?.frame.type === 'dsh_result') return true
    }
    return false
  }
  async function handleTask(frame, origin) {
    if (!usable(origin) || !frame.task_id) return
    const runtime = origin.runtime
    const admissionEpoch = origin.admissionEpoch
    const taskConfig = origin.taskConfig
    const id = frame.task_id
    if (replay(origin, id, frame, 'dsh_result')) return
    if (runtime.tasks.has(id)) {
      const existing = runtime.tasks.get(id)
      safeSend(origin, existing.fingerprint === fingerprint(frame)
        ? { type: 'dsh_task_started', task_id: id, run_id: frame.run_id, admitted: existing.admitted }
        : { type: 'dsh_result', task_id: id, run_id: frame.run_id, ok: false, code: 'command_conflict', admitted: false })
      return
    }
    if (ambiguousTask(origin, id)) {
      cache(origin, id, fingerprint(frame), { type: 'dsh_result', task_id: id, run_id: frame.run_id, ok: false, code: 'unknown', error: '当前配置无法确认该任务的原受理与结果，未重新执行', admitted: null })
      return
    }
    const task = { admitted: false, fingerprint: fingerprint(frame) }
    runtime.tasks.set(id, task)
    const previous = runtime.chains.get(frame.session_id) || Promise.resolve()
    const job = previous.catch(() => {}).then(async () => {
      const ac = new AbortController()
      inflight.set(task, { controller: ac, origin })
      let sessionId = frame.session_id || ''
      try {
        if (!usable(origin, admissionEpoch)) throw Object.assign(new Error('bridge origin ended before admission'), { code: 'cancelled', admitted: false })
        const result = await executeDshTask(ctx, taskConfig, {
          task: frame.task, session_id: sessionId, taskId: id, agentPreset: frame.agentPreset, signal: ac.signal,
          isWaiting: () => [...runtime.interactions.values()].some((entry) => entry.runId === frame.run_id),
          isContinuationPending: () => [...runtime.interactions.values(), ...runtime.native.values()].some((entry) => entry.runId === frame.run_id && entry.phase === 'continued'),
          ownsContinuation: (source) => runtime.continued.get(source?.rpcId || source?.callId) === frame.run_id,
          onSessionCreated: (sid) => {
            sessionId = sid
            runtime.sessions.set(frame.run_id, sid)
            safeSend(origin, { type: 'dsh_session_created', task_id: id, run_id: frame.run_id, session_id: sid })
          },
          onAdmitted: (sid) => { task.admitted = true; safeSend(origin, { type: 'dsh_task_started', task_id: id, run_id: frame.run_id, session_id: sid, admitted: true }) },
          onTurnStarted: () => { runtime.runs.set(sessionId, { runId: frame.run_id, taskId: id }) },
          onTurnEnded: () => { if (runtime.runs.get(sessionId)?.taskId === id) runtime.runs.delete(sessionId) },
        })
        cache(origin, id, fingerprint(frame), { type: 'dsh_result', task_id: id, run_id: frame.run_id, ok: true, code: 'ok', reply: result.reply, session_id: result.sessionId, admitted: true })
      } catch (error) {
        const observation = failure(error, { admitted: error && 'admitted' in error ? error.admitted : task.admitted, partial: error?.partial || '', sessionId: error?.sessionId || sessionId })
        cache(origin, id, fingerprint(frame), { type: 'dsh_result', task_id: id, run_id: frame.run_id, ok: false, code: observation.code, source_code: observation.source_code, error: observation.message, reply: observation.partial, session_id: observation.sessionId, admitted: observation.admitted })
      } finally {
        inflight.delete(task)
        runtime.tasks.delete(id)
        runtime.sessions.delete(frame.run_id)
        for (const [key, runId] of runtime.continued) if (runId === frame.run_id) runtime.continued.delete(key)
        for (const [iid, entry] of runtime.native) if (entry.taskId === id) runtime.native.delete(iid)
        for (const key of runtime.calls.keys()) if (key.startsWith(`${sessionId}:`)) runtime.calls.delete(key)
        if (runtime.runs.get(sessionId)?.taskId === id) runtime.runs.delete(sessionId)
        for (const [iid, entry] of runtime.interactions) if (entry.taskId === id) closeInteractive(entry.origin, iid, entry, 'turn ended')
        pruneReceipts(origin)
      }
    })
    if (frame.session_id) runtime.chains.set(frame.session_id, job)
    try { await job } finally {
      if (runtime.chains.get(frame.session_id) === job) runtime.chains.delete(frame.session_id)
      pruneReceipts(origin)
    }
  }
  async function handleAppend(frame, origin) {
    if (!usable(origin) || !frame.append_id) return
    const runtime = origin.runtime
    const admissionEpoch = origin.admissionEpoch
    const control = {}
    const id = frame.append_id
    if (replay(origin, id, frame, 'dsh_append_result')) return
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
      if (!usable(origin, admissionEpoch)) throw Object.assign(new Error('bridge origin ended before append admission'), { code: 'cancelled' })
      const owner = runtime.runs.get(sid)
      if (!owner || owner.runId !== frame.run_id) throw Object.assign(new Error('no active owned turn for append'), { code: runtime.sessions.get(frame.run_id) === sid ? 'turn_pending' : 'admission_rejected' })
      const ac = new AbortController()
      inflight.set(control, { controller: ac, origin })
      promptAttempted = true
      runtime.continued.set(`muche-append-${id}`, frame.run_id)
      steerOwnedTurn(ctx, sid, frame.task, `muche-append-${id}`, () => runtime.runs.get(sid)?.runId === frame.run_id)
      result = { ok: true, code: 'ok', admitted: true }
    } catch (error) {
      const observed = failure(error)
      result = { ok: false, code: observed.code, error: observed.message, admitted: observed.code === 'unknown' && promptAttempted ? null : false }
    } finally {
      inflight.delete(control); runtime.controls.delete(id)
      release()
      if (runtime.appends.get(sid) === waiting) runtime.appends.delete(sid)
    }
    const response = { type: 'dsh_append_result', append_id: id, run_id: frame.run_id, session_id: sid, ...result }
    if (result.code === 'turn_pending') safeSend(origin, response)
    else cache(origin, id, fingerprint(frame), response)
  }
  async function handleQuery(frame, origin) {
    if (!usable(origin)) return
    const runtime = origin.runtime
    let observed
    if (frame.task_id) {
      const result = runtime?.receipts.get(frame.task_id)?.frame
      for (const [iid, entry] of runtime?.interactions || []) {
        if (entry.taskId === frame.task_id) safeSend(origin, { type: 'dsh_interactive', run_id: entry.runId, task_id: entry.taskId, session_id: runtime.sessions.get(entry.runId), interactive_id: iid, kind: entry.kind, payload: entry.payload })
      }
      for (const receipt of runtime.receipts.values()) {
        if (receipt.frame.type === 'dsh_interactive_result' && receipt.frame.task_id === frame.task_id) safeSend(origin, receipt.frame)
      }
      safeSend(origin, { type: 'dsh_session_query_result', command_id: frame.command_id, stage: result ? 'finished' : runtime?.tasks.has(frame.task_id) ? 'active' : 'unknown', result, ok: !!result || runtime?.tasks.has(frame.task_id) })
      return
    }
    try {
      const sc = ctx.get('sessionController')
      if (typeof sc?.inspect !== 'function') throw Object.assign(new Error('inspect unavailable'), { code: 'host_not_ready' })
      await sc.inspect(frame.session_id, new AbortController().signal)
      observed = { ok: true }
    } catch (error) { const e = failure(error); observed = { ok: false, code: e.code, error: e.message } }
    safeSend(origin, { type: 'dsh_session_query_result', command_id: frame.command_id, session_id: frame.session_id, ...observed })
  }
  function closeInteractive(origin, iid, entry, error) {
    if (origin.runtime.interactions.get(iid) !== entry) return
    origin.runtime.interactions.delete(iid)
    entry.cleanup?.()
    if (entry.kind === 'approval') entry.resolve('unavailable')
    else entry.reject(new Error(error))
  }
  function handleDecide(frame, origin) {
    if (!usable(origin) || !frame.command_id) return
    const runtime = origin.runtime
    const id = frame.command_id
    if (replay(origin, id, frame, 'dsh_decide_result')) return
    const iid = frame.interactive_id
    const entry = runtime.interactions.get(iid)
    const answer = entry?.kind === 'question' ? normalizeAnswers(entry.payload, frame.answer) : null
    let code = ''
    if (!entry || entry.runId !== frame.run_id) code = 'interactive_expired'
    else if (!frame.error && (entry.kind === 'approval' ? !['allowed-once', 'rejected'].includes(frame.outcome) || !!frame.answer : !answer || !!frame.outcome || !entry.answerSchema || validateJsonSchemaValue(entry.answerSchema, answer, 'answer').length > 0)) code = 'invalid_answer'
    if (code) { cache(origin, id, fingerprint(frame), { type: 'dsh_decide_result', command_id: id, interactive_id: iid, run_id: frame.run_id, ok: false, code }); return }
    if (frame.error) closeInteractive(entry.origin, iid, entry, frame.error)
    else {
      if (entry.payload.callId) runtime.native.set(iid, { ...entry, sessionId: runtime.sessions.get(entry.runId), commandId: id })
      if (entry.phase === 'continued') {
        try {
          runtime.continued.set(entry.payload.callId, entry.runId)
          if (!ctx.get('userQuestions')?.answer(entry.agent, entry.payload.callId, answer)) code = 'interactive_expired'
        } catch (error) { code = error?.code === 'BAD_ANSWER' ? 'invalid_answer' : 'interactive_expired' }
        if (code) { runtime.native.delete(iid); runtime.continued.delete(entry.payload.callId); cache(origin, id, fingerprint(frame), { type: 'dsh_decide_result', command_id: id, interactive_id: iid, run_id: frame.run_id, ok: false, code }); return }
      }
      runtime.interactions.delete(iid)
      entry.cleanup?.()
      if (entry.phase !== 'continued') entry.resolve(entry.kind === 'approval' ? frame.outcome : answer)
    }
    cache(origin, id, fingerprint(frame), { type: 'dsh_decide_result', command_id: id, interactive_id: iid, run_id: frame.run_id, ok: true, code: 'ok', stage: 'validated_submitted' })
  }
  function interaction(kind, req, next) {
    const origin = activeOrigin
    const runtime = origin?.runtime
    if (!usable(origin)) return next()
    const sessionId = String(req?.agent?.id || req?.agent?.sessionId || '')
    const own = runtime?.runs.get(sessionId)
    if (!own?.runId) return next()
    const iid = `${own.runId}:${kind}:${randomUUID()}`
    const callId = req.wait?.callId || req.callId || ''
    const toolCall = runtime.calls.get(`${sessionId}:${callId}`)
    const payload = kind === 'question' ? { questions: req.questions, ...(req.intent ? { intent: req.intent } : {}), callId, ...(req.wait?.timed ? { timed: true } : {}) } : { toolName: req.toolName || '', callId, reason: req.reason || '', ...(toolCall ? { arguments: toolCall.arguments } : {}) }
    const promise = new Promise((resolve, reject) => {
      const answerSchema = kind === 'question' ? ctx.get('tools')?.get('ask_user_question', req.agent)?.output?.schema : undefined
      const entry = { origin, kind, payload, answerSchema, resolve, reject, agent: req.agent, runId: own.runId, taskId: own.taskId }
      runtime.interactions.set(iid, entry)
      const aborted = () => closeInteractive(origin, iid, entry, 'interaction cancelled')
      req.signal?.addEventListener('abort', aborted, { once: true })
      entry.cleanup = () => req.signal?.removeEventListener('abort', aborted)
      if (req.signal?.aborted) aborted()
      if (req.wait?.timed && runtime.interactions.has(iid)) {
        const waitController = new AbortController()
        let foregroundTimer
        const previousCleanup = entry.cleanup
        entry.cleanup = () => { previousCleanup?.(); clearTimeout(foregroundTimer); waitController.abort() }
        const questions = ctx.get('userQuestions')
        if (typeof questions?.attachWait !== 'function') { closeInteractive(origin, iid, entry, 'native timed question capability unavailable'); return }
        void (async () => {
          try { for await (const frame of questions.attachWait(req.agent, callId, waitController.signal)) {
            clearTimeout(foregroundTimer)
            foregroundTimer = setTimeout(() => {
              if (runtime.interactions.get(iid) !== entry) return
              entry.phase = 'continued'
              waitController.abort()
              reject(Object.assign(new Error('native foreground question timed out; still answerable'), { code: 'ASK_TIMED_OUT' }))
            }, frame.remainingMs)
          } }
          catch (error) { if (!waitController.signal.aborted && runtime.interactions.get(iid) === entry) closeInteractive(origin, iid, entry, String(error?.message || error)) }
        })()
      }
    })
    // Resolver is installed before reporting; a synchronous backend decision is safe.
    if (runtime.interactions.has(iid) && !safeSend(origin, { type: 'dsh_interactive', run_id: own.runId, task_id: own.taskId, session_id: sessionId, interactive_id: iid, kind, payload })) closeInteractive(origin, iid, runtime.interactions.get(iid), 'bridge disconnected')
    return promise
  }
  function transportHandlers(origin, ticket) {
    const context = origin.context
    let previousStatus = 'idle'
    const current = () => !disposed && connectionTicket === ticket && origin === activeOrigin && !origin.retired && contextCurrent(context)
    function onHelloAck(frame) {
      if (!current()) return
      // 登记确认的唯一事实来源是后端 dsh_hello_ack；socket hello/本地 ready
      // 只证明传输可达，不证明 _peers 里有本宿主。未收到 ack 前保持 starting。
      if (frame?.ok === true) {
        origin.registered = true
        if (bridgeChannel.current?.getState?.().ready === true) {
          transition('ready', true, { mode: 'active' }, context)
        }
        return
      }
      const code = String(frame?.code || 'upgrade_required')
      // 拒收码与后端 protocol.json / locate() 同语义：upgrade_required 才提示
      // 升级；protocol_error 是登记请求非法；其余在册缺失是连接事实，进离线。
      const mapped = code === 'protocol_error' ? BRIDGE_STARTUP : code === 'upgrade_required' ? code : BRIDGE_OFFLINE
      const reason = code === 'protocol_error' ? '桥接登记被后端拒绝' : code === 'upgrade_required' ? '桥接协议需要升级' : '本机桥接连接已断开'
      transition('fault', true, { code: mapped, reason, mode: 'active' }, context)
    }
    return {
      onTask: (frame) => { if (current()) void handleTask(frame, origin) },
      onAppend: (frame) => { if (current()) void handleAppend(frame, origin) },
      onDecide: (frame) => { if (current()) handleDecide(frame, origin) },
      onQuery: (frame) => { if (current()) void handleQuery(frame, origin) },
      onHelloAck,
      onStatus: (st) => {
        if (!current()) return
        const opened = st.status === 'open' && previousStatus !== 'open'
        previousStatus = st.status
        origin.transport = bridgeChannel.current
        if (st.status === 'open') origin.accepting = true
        // open 后仍按协议发 hello；登记成功与否只认后端的 dsh_hello_ack。
        if (opened) { origin.registered = false; safeSend(origin, { type: 'dsh_hello', protocol: PROTOCOL.version, capabilities: PROTOCOL.capabilities }) }
        if (st.status === 'closed' || st.status === 'idle') interruptOrigin(origin, 'bridge disconnected')
        if (st.status === 'open' && st.ready === true && origin.registered === true) {
          transition('ready', true, { mode: 'active' }, context)
        } else if (st.status === 'closed' || state.phase === 'ready') {
          transition('fault', true, { code: st.code || BRIDGE_OFFLINE, reason: '本机桥接连接已断开', mode: 'active' }, context)
        } else if (state.phase !== 'fault') {
          transition('starting', false, { mode: 'starting' }, context)
        }
      },
    }
  }
  async function refresh(next, context = options.getContext?.()) {
    if (disposed) return
    const cfg = readConfig(next === undefined ? config : next)
    const capturedContext = context && { ...context }
    if (!contextCurrent(capturedContext)) return
    const target = normalizeBackendUrl(cfg.backendUrl)
    const apiKey = cfg.apiKey.trim()
    const epoch = ++refreshEpoch
    const scope = createHash('sha256').update(connectionFingerprint('dsh-bridge', target.ok ? target.url : cfg.backendUrl, apiKey)).digest('hex')
    const fallback = options.getContext ? '' : JSON.stringify([scope, cfg.workspacePath, cfg.bridgeId])
    const changed = !scopeInitialized || configScope !== scope || (options.getContext ? !sameContext(activeContext, capturedContext) : fallbackFingerprint !== fallback)
    const latest = () => !disposed && epoch === refreshEpoch && contextCurrent(capturedContext)
    if (changed) {
      scopeInitialized = true
      activeContext = capturedContext
      fallbackFingerprint = fallback
      configScope = scope
      clearRetry()
      retries = 0
      Object.assign(state, { phase: 'not-started', startupComplete: false, mode: 'waiting-key', reason: '' })
      delete state.code
      retireActive('bridge configuration changed')
    }
    if (retirement) await retirement
    if (!latest()) return
    if (!apiKey || !target.ok) {
      clearRetry()
      retries = 0
      stopConnection('bridge not configured')
      transition('not-started', false, { mode: 'waiting-key' }, capturedContext)
      return
    }
    if (!state.startupComplete && state.phase !== 'starting') transition('starting', false, { mode: 'starting' }, capturedContext)
    if (!latest()) return
    const sc = ctx.get('sessionController')
    const wr = ctx.get('workspaceRegistry')
    state.deps = { sessionController: !!sc, workspaceRegistry: !!wr }
    if (!sc || !wr) {
      stopConnection('bridge dependencies unavailable')
      if (state.phase === 'ready') transition('fault', true, { code: BRIDGE_DEPENDENCIES, reason: '缺少本地执行依赖：sessionController/workspaceRegistry', mode: 'disabled' }, capturedContext)
      if (retries >= retryDelays.length) {
        transition('fault', true, { code: BRIDGE_DEPENDENCIES, reason: '缺少本地执行依赖：sessionController/workspaceRegistry', mode: 'disabled' }, capturedContext)
      } else {
        if (!state.startupComplete) transition('starting', false, { mode: 'starting' }, capturedContext)
        if (latest() && !retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null
            if (contextCurrent(capturedContext)) void refresh(cfg, capturedContext)
          }, retryDelays[retries++])
          retryTimer.unref?.()
        }
      }
      return
    }
    clearRetry()
    retries = 0
    if (!state.startupComplete) transition('starting', false, { mode: 'starting' }, capturedContext)
    if (!latest()) return
    let id
    try { id = await identity(ctx, cfg, sc) } catch (error) {
      if (!latest()) return
      stopConnection('bridge identity unavailable')
      transition('fault', true, { code: BRIDGE_STARTUP, reason: '宿主身份无法经官方配置保存', mode: 'disabled' }, capturedContext)
      console.error('muche dsh-bridge: host identity failed', String(error?.message || error))
      return
    }
    if (!latest()) return
    if (activeOrigin && activeOrigin.hostId !== id) {
      retireActive('bridge host identity changed')
      transition('starting', false, { mode: 'starting' }, capturedContext)
      if (retirement) await retirement
      if (!latest()) return
    }
    if (!activeOrigin) {
      const cacheKey = createHash('sha256').update(JSON.stringify([scope, id])).digest('hex')
      if (!hosts.has(cacheKey)) hosts.set(cacheKey, { hostId: id, references: 0, receipts: new Map(), tasks: new Map(), controls: new Set(), chains: new Map(), appends: new Map(), runs: new Map(), sessions: new Map(), interactions: new Map(), calls: new Map(), native: new Map(), continued: new Map() })
      activeOrigin = { context: capturedContext, hostId: id, runtime: hosts.get(cacheKey), taskConfig: { workspacePath: cfg.workspacePath }, retired: false, accepting: false, admissionEpoch: 0, transport: null }
      activeOrigin.runtime.references += 1
    } else activeOrigin.taskConfig = { workspacePath: cfg.workspacePath }
    pruneReceipts(activeOrigin)
    if (bridgeChannel.hasTransport) return
    const origin = activeOrigin
    const ticket = {}
    connectionTicket = ticket
    origin.transport = bridgeChannel.sync({ backendUrl: target.url, apiKey, handlers: transportHandlers(origin, ticket) })
  }
  function dispose() {
    if (disposed) return
    disposed = true
    refreshEpoch += 1
    fibers.delete(controller)
    clearRetry()
    for (const disposer of disposers.splice(0)) {
      try { disposer?.() } catch { console.warn('muche dsh-bridge: registration cleanup failed') }
    }
    connectionTicket = null
    const origins = new Set([...inflight.values()].map((entry) => entry.origin))
    if (activeOrigin) origins.add(activeOrigin)
    if (retiringOrigin) origins.add(retiringOrigin)
    for (const origin of origins) {
      if (!origin.retired) { origin.retired = true; origin.runtime.references -= 1 }
      interruptOrigin(origin, 'plugin disposed')
      pruneReceipts(origin)
    }
    activeOrigin = null
    retiringOrigin = null
    bridgeChannel.dispose()
    Object.assign(state, { phase: 'stopped', mode: 'stopped', reason: '' })
    delete state.code
    publish()
  }
  disposers.push(ctx.on('approval/request', (req, next) => interaction('approval', req, next), { prepend: true }))
  disposers.push(ctx.on('user-questions/request', (req, next) => interaction('question', req, next), { prepend: true }))
  disposers.push(ctx.on('session/event', (session, event) => {
    const origin = activeOrigin
    if (!usable(origin)) return
    const runtime = origin.runtime, data = event.data || {}, sid = session?.id
    if (event.type === 'user/message' && data.source?.kind === 'user-question-reply') {
      for (const [iid, entry] of runtime.native) {
        if (entry.origin !== origin || entry.sessionId !== sid || entry.payload.callId !== data.source.callId) continue
        runtime.native.delete(iid)
        cache(origin, `native:${iid}`, '', { type: 'dsh_interactive_result', run_id: entry.runId, task_id: entry.taskId, session_id: sid, interactive_id: iid, command_id: entry.commandId, stage: 'native_observed', ok: true, source: data.source })
      }
    }
    if (event.type === 'tool/call' && runtime.runs.has(sid)) runtime.calls.set(`${sid}:${data.callId}`, data)
    if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId
      for (const [iid, entry] of runtime.native) {
        if (entry.origin !== origin || entry.sessionId !== sid || entry.payload.callId !== callId || entry.phase === 'continued') continue
        runtime.native.delete(iid)
        cache(origin, `native:${iid}`, '', { type: 'dsh_interactive_result', run_id: entry.runId, task_id: entry.taskId, session_id: sid, interactive_id: iid, command_id: entry.commandId, stage: 'native_observed', ok: !data.message?.isError, result: data.message, ...(data.error ? { error: data.error } : {}) })
      }
      runtime.calls.delete(`${sid}:${callId}`)
    }
    if (event.type === 'turn/end') for (const key of runtime.calls.keys()) if (key.startsWith(`${sid}:`)) runtime.calls.delete(key)
  }))
  disposers.push(ctx.on('dispose', dispose))
  void refresh()
  return controller
}
