/**
 * Saved-config runtime projection Owner, scoped to the fiber which owns the routes.
 * Config remains in official settings; only a private connection fingerprint is retained.
 * Consumers use context/getSnapshot/subscribe and submit transport or HTTP observations.
 * Every observation is fenced by runtimeId + configNs + generation. Snapshots contain no
 * credentials or target URLs. Startup, operation failures and quota are distinct dimensions.
 * No persistence or tenant-global singleton; subscribe/dispose are idempotent. Listener
 * failures are logged and isolated. Tests: test/runtime-state.test.js and runtime-client.test.js.
 */
import { randomUUID } from 'node:crypto'
import { normalizeBackendUrl } from './backend.js'
import { fingerprint } from './connections.js'
import { classifyFailure, AUTH_FAILED, NEED_KEY, NEED_SETUP, TARGET, NETWORK, TIMEOUT, FORBIDDEN } from './errors.js'
import { sameRuntimeContext } from './runtime-contract.js'

const configCodes = new Set([NEED_KEY, NEED_SETUP, TARGET, AUTH_FAILED, 'NOT_API'])
const transportCodes = new Set([NETWORK, TIMEOUT, 'UPSTREAM_HTML', 'INVALID_RESPONSE'])
export { sameRuntimeContext } from './runtime-contract.js'

export function createRuntimeState({ configNs = 'muche', runtimeId = randomUUID() } = {}) {
  let generation = 0
  let seq = 0
  let key
  let disposed = false
  const listeners = new Set()
  let configuration = { status: 'loading', code: '' }
  let send = { status: 'checking', code: '', retryable: true }
  let receive = { status: 'idle', ready: false, code: '', retryable: true }
  let bridge = { phase: 'not-started', startupComplete: false, code: '' }
  let snapshot
  let lastJson = ''
  let httpTicket = 0
  let latestHttpTicket = 0

  const context = () => Object.freeze({ runtimeId, configNs, generation })
  const accepts = (candidate) => !disposed && sameRuntimeContext(candidate, context())
  function project() {
    let problem = null
    if (configuration.code) problem = classifyFailure({ code: configuration.code })
    else if (send.status === 'unavailable') problem = classifyFailure({ code: send.code || NETWORK })
    else if (receive.code && !receive.ready) problem = classifyFailure({ code: receive.code, kind: receive.code === 'FORBIDDEN' ? 'access' : 'connection' })
    else if (bridge.phase === 'fault' && bridge.startupComplete) problem = classifyFailure({ kind: 'bridge', code: bridge.code })
    const failed = !!configuration.code || send.status === 'unavailable' || !!receive.code
    const phase = send.status === 'ready' && receive.ready
      ? 'online'
      : failed ? 'offline' : 'connecting'
    return {
      schema: 1, ...context(),
      configuration: Object.freeze({ ...configuration }),
      chat: Object.freeze({ phase, send: Object.freeze({ ...send }), receive: Object.freeze({ ...receive }) }),
      bridge: Object.freeze({ ...bridge }),
      problem: problem ? Object.freeze(problem) : null,
    }
  }
  function commit() {
    const next = project()
    const json = JSON.stringify(next)
    if (json === lastJson) return false
    lastJson = json
    snapshot = Object.freeze({ ...next, seq: ++seq })
    for (const fn of [...listeners]) {
      try { fn(snapshot) } catch (error) { console.error('muche runtime: subscriber failed', String(error?.message || error)) }
    }
    return true
  }
  commit()
  return {
    context,
    accepts,
    getSnapshot: () => snapshot,
    /** Reserve an observation order before any HTTP work starts. */
    beginHttp: () => ++httpTicket,
    subscribe(fn) {
      if (disposed) return () => {}
      listeners.add(fn)
      try { fn(snapshot) } catch (error) { console.error('muche runtime: subscriber failed', String(error?.message || error)) }
      return () => { listeners.delete(fn) }
    },
    configure(cfg = {}) {
      if (disposed) return false
      const base = String(cfg.backendUrl || '').trim()
      const apiKey = String(cfg.apiKey || '').trim()
      const normalized = normalizeBackendUrl(base)
      const nextKey = fingerprint('', normalized.ok ? normalized.url : base, apiKey)
      if (key === nextKey) return false
      key = nextKey
      generation += 1
      const code = !apiKey ? NEED_KEY : !base ? NEED_SETUP : !normalized.ok ? normalized.code : ''
      configuration = { status: code ? 'missing' : 'ready', code }
      send = { status: code ? 'unavailable' : 'checking', code: '', retryable: !code }
      httpTicket = latestHttpTicket = 0
      receive = { status: 'idle', ready: false, code: '', retryable: true }
      bridge = { phase: 'not-started', startupComplete: false, code: '' }
      commit()
      return true
    },
    setReceive(candidate, state = {}) {
      if (!accepts(candidate)) return false
      const status = state.status || 'idle'
      const ready = status === 'open' && state.ready === true
      const code = ready || status === 'idle' ? ''
        : state.code || (status === 'closed' ? receive.code || NETWORK : receive.code)
      receive = { status, ready, code, retryable: state.retryable !== false }
      return commit()
    },
    setBridge(candidate, state = {}) {
      if (!accepts(candidate)) return false
      bridge = {
        phase: state.phase || 'not-started',
        startupComplete: state.startupComplete === true,
        code: state.phase === 'fault' ? String(state.code || 'bridge_unavailable') : '',
      }
      return commit()
    },
    /**
     * HTTP facts arrive from concurrent operations and the readiness probe. Observed-at
     * order is authoritative within one generation: a slower earlier request never
     * overwrites a newer committed fact, and a credential rejection is not cleared by an
     * older success. Only the projection is fenced this way; each operation still returns
     * its own business result to its caller.
     */
    observeHttp(candidate, result = {}, { operation = 'request', ticket = 0 } = {}) {
      if (!accepts(candidate) || result.code === 'STALE_RUNTIME') return false
      if (ticket < latestHttpTicket) return false
      latestHttpTicket = Math.max(latestHttpTicket, ticket)
      const code = String(result.code || '')
      const status = Number(result.status || 0)
      // Validation/rate/quota responses prove an authenticated HTTP path, not a failed socket.
      if (result.ok === true || status === 422 || status === 429 || code === 'message_quota_exhausted') {
        if (configuration.status === 'rejected') configuration = { status: 'ready', code: '' }
        send = { status: 'ready', code: '', retryable: true }
      } else if (configCodes.has(code) || status === 401) {
        configuration = { status: 'rejected', code: code || AUTH_FAILED }
        send = { status: 'unavailable', code: '', retryable: false }
      } else if (transportCodes.has(code) || status === 403 || operation === 'probe') {
        const failure = classifyFailure({ ...result, code: status === 403 ? FORBIDDEN : code || NETWORK })
        send = { status: 'unavailable', code: failure.code || NETWORK, retryable: failure.retryable }
      }
      // Business generation/service failures stay attached to their operation. They do not
      // erase independently observed HTTP/receive readiness or latch the user offline.
      return commit()
    },
    dispose() { disposed = true; listeners.clear() },
  }
}

/**
 * Runtime's HTTP readiness boundary. One auth request on activation/config switch/recovery;
 * failure-only exponential retry, never stable-state health polling. Requests and timers
 * stop when no chat receiver is active. A cancelled/old generation cannot commit results.
 * The existing auth endpoint proves authenticated HTTP reachability, not guaranteed future
 * /chat admission or model replies; stricter per-route capability needs a backend contract.
 */
export function watchHttpReadiness({ runtime, getConfig, probe, retryBaseMs = 3000, retryMaxMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let disposed = false
  let activeRequest = null
  let retryTimer = null
  let attempts = 0
  let boundContext = runtime.context()
  let off = () => {}
  const cancel = () => {
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null }
    if (activeRequest) { activeRequest.controller.abort(); activeRequest = null }
  }
  function reconcile(snapshot) {
    if (disposed) return
    if (!sameRuntimeContext(boundContext, snapshot)) {
      cancel(); boundContext = runtime.context(); attempts = 0
    }
    const active = snapshot.chat.receive.status !== 'idle'
    if (!active || snapshot.configuration.code || snapshot.chat.send.status === 'ready' || !snapshot.chat.send.retryable) {
      cancel()
      return
    }
    if (activeRequest || retryTimer) return
    const candidate = runtime.context()
    const ticket = runtime.beginHttp()
    let probeFailed = false
    const request = { controller: new AbortController(), context: candidate }
    activeRequest = request
    const cfg = getConfig()
    Promise.resolve().then(() => {
      if (disposed || activeRequest !== request || request.controller.signal.aborted) return null
      return probe(cfg, request.controller.signal)
    }).then((result) => {
      if (disposed || activeRequest !== request || !runtime.accepts(candidate)) return
      runtime.observeHttp(candidate, result, { operation: 'probe', ticket })
    }).catch((error) => {
      // A thrown probe is a host/plugin defect, not evidence about the backend. Logging it
      // keeps fail-loud; committing it would invent a network fact and latch the user offline.
      if (disposed || activeRequest !== request || request.controller.signal.aborted) return
      console.warn('muche runtime: HTTP readiness check threw', String(error?.message || error))
      probeFailed = true
    }).finally(() => {
      if (activeRequest !== request || disposed) return
      activeRequest = null
      if (probeFailed) return
      const current = runtime.getSnapshot()
      if (!runtime.accepts(candidate) || current.configuration.code || current.chat.send.status === 'ready' || !current.chat.send.retryable || current.chat.receive.status === 'idle') return
      const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempts++, 4))
      retryTimer = setTimer(() => { retryTimer = null; reconcile(runtime.getSnapshot()) }, delay)
      retryTimer?.unref?.()
    })
  }
  off = runtime.subscribe(reconcile)
  return () => { disposed = true; off(); cancel() }
}
