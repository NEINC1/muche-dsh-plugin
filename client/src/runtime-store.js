/**
 * Browser mirror Owner. Host snapshots alone own config, chat readiness and bridge facts.
 * This instance owns one EventSource, browser delivery deadlines and request fencing.
 * Each source epoch binds one runtimeId/configNs; an identity conflict quarantines both
 * channels, then reboots from the current same-origin Owner. Old callbacks/results cannot
 * restore another scope. Native reconnect handles CONNECTING; only CLOSED/deadline/conflict
 * uses bounded fallback retry. Stable operation has no HTTP polling or backend health calls.
 * Dispose aborts bootstrap and clears all timers/listeners. No credentials/persistence.
 * Consumers: entry UI/request port. Tests: runtime-client.test.js, client-ui.test.js.
 */
import { apiGet } from './api.js'
import { HOST_UNAVAILABLE, STALE_RUNTIME } from '../../lib/errors.js'
import { isRuntimeSnapshot, projectClientRuntime, sameRuntimeContext } from '../../lib/runtime-contract.js'

export function createRuntimeClient({ fetchSnapshot = (signal) => apiGet('/api/muche/runtime', { signal }), createEventSource = (path) => new EventSource(path), setTimer = setTimeout, clearTimer = clearTimeout, retryBaseMs = 3000, retryMaxMs = 30000 } = {}) {
  const listeners = new Set(), frameListeners = new Set(), pendingFrames = []
  let snapshot = null, delivery = { status: 'connecting', synced: false }
  let view = projectClientRuntime(snapshot, delivery)
  let source = null, sourceEpoch = 0, sourceBinding = null, streamContext = null
  let identityPending = false, disposed = false, started = false
  let retryTimer = null, deadlineTimer = null, attempts = 0, bootstrap = null, messageSeq = 0
  const identityMatches = (a, b) => !!a && !!b && a.runtimeId === b.runtimeId && a.configNs === b.configNs
  function emit() {
    view = projectClientRuntime(snapshot, delivery)
    if (identityPending) view = { ...view, context: null }
    for (const fn of [...listeners]) {
      try { fn(view) } catch (error) { console.error('muche client: runtime subscriber failed', String(error?.name || 'Error')) }
    }
  }
  function retry() {
    if (disposed || retryTimer) return
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempts++, 4))
    retryTimer = setTimer(() => { retryTimer = null; open(); void refresh() }, delay)
  }
  function retire({ conflict = false, immediate = false, phase = 'offline' } = {}) {
    ++sourceEpoch
    bootstrap?.abort(); bootstrap = null
    if (deadlineTimer) { clearTimer(deadlineTimer); deadlineTimer = null }
    if (source) {
      const old = source; source = null
      old.onopen = old.onmessage = old.onerror = null
      try { old.close() } catch (error) { console.warn('muche client: stream close failed', String(error?.name || 'Error')) }
    }
    sourceBinding = streamContext = null
    if (conflict) { identityPending = true; pendingFrames.length = 0 }
    delivery = { status: phase, synced: false }; emit()
    if (immediate) { open(); void refresh() } else retry()
  }
  function applySnapshot(next, { stream = false } = {}) {
    if (disposed || !isRuntimeSnapshot(next)) return false
    if (snapshot && next.runtimeId === snapshot.runtimeId) {
      if (next.generation < snapshot.generation || next.seq < snapshot.seq) return false
      if (next.configNs !== snapshot.configNs) return false
    }
    if (snapshot && !sameRuntimeContext(snapshot, next)) {
      // Same-origin runtime identity changed: the host fiber restarted or another mount owns
      // the routes. HTTP facts are the newer owner truth and may move forward; a stream frame
      // may never roll the committed scope back, and any stream of the previous identity dies.
      if (stream) {
        console.warn('muche client: stale stream scope refused; resynchronizing')
        retire({ conflict: true, immediate: true })
        return false
      }
      pendingFrames.length = 0
      if (sourceBinding && !identityMatches(sourceBinding, next)) retire({ immediate: true, phase: 'connecting' })
    }
    snapshot = next
    sourceBinding = { runtimeId: next.runtimeId, configNs: next.configNs }
    identityPending = false
    if (stream) {
      delivery = { status: 'ready', synced: true }; attempts = 0
      streamContext = { runtimeId: next.runtimeId, configNs: next.configNs, generation: next.generation }
    }
    emit()
    return true
  }
  async function refresh() {
    if (disposed || bootstrap) return
    const controller = new AbortController(), before = snapshot, epoch = sourceEpoch
    bootstrap = controller
    try {
      const result = await fetchSnapshot(controller.signal)
      if (disposed || bootstrap !== controller || epoch !== sourceEpoch) return
      if (result?.ok && result.snapshot) {
        if (streamContext && source?.readyState === 1 && sameRuntimeContext(streamContext, result.snapshot)) delivery = { status: 'ready', synced: true }
        applySnapshot(result.snapshot)
      } else if ((result?.localFailure || result?.code === HOST_UNAVAILABLE) && !(snapshot !== before && delivery.synced)) {
        delivery = { status: 'offline', synced: false }; emit()
      }
    } catch (error) {
      if (!disposed && !controller.signal.aborted && bootstrap === controller) {
        console.warn('muche client: runtime bootstrap failed', String(error?.name || 'Error'))
        if (!(snapshot !== before && delivery.synced)) { delivery = { status: 'offline', synced: false }; emit() }
      }
    } finally { if (bootstrap === controller) bootstrap = null }
  }
  function open() {
    if (disposed || source) return
    const epoch = ++sourceEpoch
    // A new connection may belong to a restarted host. The first complete authoritative
    // snapshot binds its identity; competing identities require a fresh epoch, not rollback.
    sourceBinding = streamContext = null
    let es
    try { es = createEventSource('/api/muche/events') }
    catch (error) {
      console.warn('muche client: stream construction failed', String(error?.name || 'Error'))
      delivery = { status: 'offline', synced: false }; emit(); retry(); return
    }
    source = es
    const current = () => !disposed && source === es && sourceEpoch === epoch
    const armDeadline = (ms) => {
      if (deadlineTimer) clearTimer(deadlineTimer)
      deadlineTimer = setTimer(() => {
        deadlineTimer = null
        if (current()) retire()
      }, ms)
    }
    es.onopen = () => {
      if (!current()) return
      streamContext = null
      delivery = { status: 'connecting', synced: false }; emit()
      armDeadline(15000)
      void refresh()
    }
    es.onmessage = (event) => {
      if (!current()) return
      let frame
      try { frame = JSON.parse(event.data) }
      catch { console.warn('muche client: malformed event frame'); return }
      if (frame?.type === 'runtime') {
        if (applySnapshot(frame.snapshot, { stream: true })) armDeadline(60000)
        return
      }
      if (!sameRuntimeContext(frame?.context, snapshot) || !sameRuntimeContext(streamContext, snapshot)) return
      armDeadline(60000)
      if (!delivery.synced) { delivery = { status: 'ready', synced: true }; emit() }
      if (frame.type === 'heartbeat') return
      if (!frameListeners.size) { pendingFrames.push(frame); if (pendingFrames.length > 20) pendingFrames.shift(); return }
      for (const fn of [...frameListeners]) {
        try { fn(frame) } catch (error) { console.error('muche client: message subscriber failed', String(error?.name || 'Error')) }
      }
    }
    es.onerror = () => {
      if (!current()) return
      delivery = { status: 'offline', synced: false }; streamContext = null
      if (deadlineTimer) { clearTimer(deadlineTimer); deadlineTimer = null }
      emit()
      if (es.readyState === 2) retire()
      // CONNECTING uses EventSource's native backoff. onopen requires a complete snapshot.
    }
  }
  return {
    getSnapshot: () => view,
    context: () => view.context,
    accepts: (context) => !disposed && !identityPending && sameRuntimeContext(context, snapshot),
    subscribe(fn) { listeners.add(fn); fn(view); return () => listeners.delete(fn) },
    subscribeFrames(fn) {
      frameListeners.add(fn)
      for (const frame of pendingFrames.splice(0)) if (sameRuntimeContext(frame.context, snapshot)) fn(frame)
      return () => frameListeners.delete(fn)
    },
    applySnapshot,
    observeReply(context, result) {
      if (disposed || identityPending || !sameRuntimeContext(context, snapshot)) return false
      if (result?.snapshot) applySnapshot(result.snapshot)
      if (identityPending || !sameRuntimeContext(context, snapshot) || result?.code === STALE_RUNTIME) return false
      if (result?.localFailure || result?.code === HOST_UNAVAILABLE) {
        delivery = { status: 'offline', synced: false }; emit(); void refresh()
      }
      return true
    },
    newId(prefix = 'm') { return `${prefix}-${Date.now()}-${++messageSeq}` },
    start() { if (started || disposed) return; started = true; open(); void refresh() },
    ensureConnected() { if (!disposed && !source && !retryTimer) { open(); void refresh() } },
    refresh,
    dispose() {
      if (disposed) return
      disposed = true; ++sourceEpoch
      bootstrap?.abort(); bootstrap = null
      if (retryTimer) clearTimer(retryTimer)
      if (deadlineTimer) clearTimer(deadlineTimer)
      retryTimer = deadlineTimer = null
      if (source) { source.onopen = source.onmessage = source.onerror = null; source.close(); source = null }
      listeners.clear(); frameListeners.clear(); pendingFrames.length = 0
    },
  }
}
