/** Browser receipt retries; each key is an already-received message, never its content. */
export function createMessageReceiptQueue({
  scope, owner, storage, isCurrent, send, onError = console.warn,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  if (!scope || !owner) throw new Error('message receipt scope and owner are required')
  const prefix = `muche-receipt-v1:${encodeURIComponent(scope)}:`
  const memory = new Set()
  let timer = null, running = false, disposed = false, failures = 0

  function pending() {
    const ids = new Set(memory)
    try {
      const store = storage()
      if (!store) throw new Error('persistent storage unavailable')
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        if (key?.startsWith(prefix)) ids.add(key.slice(prefix.length))
      }
    } catch (error) { onError('message receipt storage unavailable', error) }
    return [...ids].filter(Boolean).sort().slice(0, 200)
  }

  function schedule(delay) {
    if (disposed || timer !== null) return
    timer = setTimer(() => { timer = null; void flush() }, delay)
  }

  function retry() {
    const delay = Math.min(30000, 3000 * 2 ** Math.min(failures++, 4))
    schedule(delay)
  }

  async function flush() {
    if (disposed || running || !isCurrent()) return
    const ids = pending()
    if (!ids.length) return
    running = true
    let succeeded = false
    try {
      const result = await send(ids, owner)
      if (disposed || !isCurrent()) return
      const accepted = result?.accepted_message_ids
      const unavailable = result?.unavailable_message_ids
      const checked = Array.isArray(accepted) && Array.isArray(unavailable)
        ? [...accepted, ...unavailable] : []
      if (result?.receipt_owner !== owner || checked.length !== ids.length
        || new Set(checked).size !== ids.length || checked.some(id => !ids.includes(id))) {
        throw new Error('message receipt response is incomplete or from another account')
      }
      if (unavailable.length) onError('message receipt source unavailable', unavailable.length)
      let store
      try { store = storage() } catch { store = null }
      for (const id of checked) {
        if (store) store.removeItem(prefix + id)
        memory.delete(id)
      }
      failures = 0
      succeeded = true
    } catch (error) {
      onError('message receipt deferred', error)
      retry()
    } finally {
      running = false
    }
    if (succeeded && pending().length) schedule(0)
  }

  return {
    enqueue(ids) {
      if (disposed || !isCurrent()) return
      for (const id of new Set(ids)) {
        if (typeof id !== 'string' || !id) continue
        memory.add(id)
        try {
          const store = storage()
          if (!store) throw new Error('persistent storage unavailable')
          store.setItem(prefix + id, '1')
        } catch (error) { onError('message receipt storage unavailable', error) }
      }
      schedule(0)
    },
    retryNow() {
      if (disposed) return
      if (timer !== null) { clearTimer(timer); timer = null }
      schedule(0)
    },
    flush,
    dispose() {
      disposed = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}
