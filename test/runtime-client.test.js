import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeClient } from '../client/src/runtime-store.js'
import { createRuntimeState } from '../lib/runtime-state.js'

const CFG = { backendUrl: 'https://example.test', apiKey: 'client-test-key' }
const tick = () => new Promise((resolve) => setImmediate(resolve))
function snapshot(runtime, { stream } = {}) {
  const current = runtime.getSnapshot()
  return stream ? current : { ...current }
}
function harness({ bootstrap = async () => ({ ok: true, snapshot }) } = {}) {
  const sources = []
  const timers = []
  const client = createRuntimeClient({
    fetchSnapshot: (signal) => { signal.onabort?.(); return bootstrap(signal) },
    createEventSource: (path) => {
      const es = { path, readyState: 0, closed: false, onopen: null, onmessage: null, onerror: null, close() { this.closed = true; this.readyState = 2 } }
      sources.push(es)
      return es
    },
    setTimer: (fn, ms) => { const key = { fn, ms }; timers.push(key); return key },
    clearTimer: (key) => { const i = timers.indexOf(key); if (i >= 0) timers.splice(i, 1) },
  })
  const fire = (es) => { es.onopen?.() }
  const message = (es, frame) => es.onmessage?.({ data: JSON.stringify(frame) })
  return { client, sources, timers, fire, message, runTimers: () => { const list = timers.splice(0); for (const t of list) t.fn() } }
}

test('startup shows connecting, then online only after a complete synchronized snapshot', async () => {
  const runtime = createRuntimeState({ configNs: 'muche', runtimeId: 'r1' })
  runtime.configure(CFG)
  const seen = []
  const { client, sources } = harness({ bootstrap: async () => ({ ok: true, snapshot: snapshot(runtime) }) })
  client.subscribe((value) => seen.push(value.label))
  assert.deepEqual(seen, ['连接中'])
  client.start()
  await tick()
  assert.equal(sources.length, 1)
  sources[0].onopen()
  await tick()
  assert.equal(client.getSnapshot().label, '连接中', 'HTTP bootstrap alone is not chat readiness')
  sources[0].onmessage({ data: JSON.stringify({ type: 'runtime', snapshot: snapshot(runtime) }) })
  assert.equal(client.getSnapshot().label, '连接中', 'receive is still idle')
  const context = runtime.context()
  runtime.observeHttp(context, { ok: true }, { ticket: runtime.beginHttp() })
  runtime.setReceive(context, { status: 'open', ready: true })
  sources[0].onmessage({ data: JSON.stringify({ type: 'runtime', snapshot: snapshot(runtime) }) })
  assert.equal(client.getSnapshot().label, '在线')
  assert.equal(client.getSnapshot().problem, null)
  client.dispose()
})

test('a silent stream that never sends a snapshot cannot present online', async () => {
  const runtime = createRuntimeState({ configNs: 'muche', runtimeId: 'r1' })
  runtime.configure(CFG)
  const context = runtime.context()
  runtime.observeHttp(context, { ok: true }, { ticket: runtime.beginHttp() })
  runtime.setReceive(context, { status: 'open', ready: true })
  const { client, sources, timers, runTimers } = harness({ bootstrap: async () => ({ ok: true, snapshot: snapshot(runtime) }) })
  client.start()
  await tick()
  sources[0].onopen()
  await tick()
  assert.equal(client.getSnapshot().label, '连接中')
  const deadline = timers.filter((t) => t.ms === 15000)
  assert.equal(deadline.length, 1)
  deadline[0].fn()
  assert.ok(timers.some((t) => t.ms === 3000), 'a dead stream schedules one bounded retry')
  assert.equal(client.getSnapshot().label, '离线')
  assert.equal(sources[0].closed, true, 'a dead stream is closed rather than polled')
  client.dispose()
})

test('an HTTP-discovered new runtime retires the old stream and refuses its late frames', async () => {
  const first = createRuntimeState({ configNs: 'muche', runtimeId: 'host-a' })
  first.configure(CFG)
  const second = createRuntimeState({ configNs: 'muche', runtimeId: 'host-b' })
  second.configure({ ...CFG, apiKey: 'rotated-client-test' })
  let current = first
  const frames = []
  const { client, sources } = harness({ bootstrap: async () => ({ ok: true, snapshot: snapshot(current) }) })
  client.subscribeFrames((frame) => frames.push(frame))
  client.start()
  await tick()
  sources[0].onopen()
  await tick()
  sources[0].onmessage({ data: JSON.stringify({ type: 'runtime', snapshot: snapshot(first) }) })
  const staleOnMessage = sources[0].onmessage
  current = second
  await client.refresh()
  assert.equal(client.context().runtimeId, 'host-b')
  assert.equal(client.getSnapshot().label, '连接中', 'no synchronized receive evidence for the new identity yet')
  // The retired source is detached; replaying its captured callbacks must still be fenced.
  assert.equal(sources[0].onmessage, null, 'a retired stream is fully detached')
  staleOnMessage({ data: JSON.stringify({ type: 'reply', context: first.context(), message_id: 'm-old' }) })
  assert.deepEqual(frames, [], 'frames of the retired identity are not accepted')
  client.dispose()
})

test('structural problems persist, deduplicate one cause, and vanish on authoritative recovery', async () => {
  const runtime = createRuntimeState({ configNs: 'muche', runtimeId: 'r1' })
  runtime.configure(CFG)
  const { client, sources } = harness({ bootstrap: async () => ({ ok: true, snapshot: snapshot(runtime) }) })
  client.start()
  await tick()
  sources[0].onopen()
  await tick()
  sources[0].onmessage({ data: JSON.stringify({ type: 'runtime', snapshot: snapshot(runtime) }) })
  const context = runtime.context()
  runtime.setReceive(context, { status: 'closed', code: 'NETWORK' })
  sources[0].onmessage({ data: JSON.stringify({ type: 'runtime', snapshot: snapshot(runtime) }) })
  assert.equal(client.getSnapshot().label, '离线')
  assert.equal(client.getSnapshot().problem.text, '连接暂时中断，正在重连')
  const same = client.getSnapshot()
  sources[0].onmessage({ data: JSON.stringify({ type: 'runtime', snapshot: same.snapshot }) })
  assert.equal(client.getSnapshot().problem.text, '连接暂时中断，正在重连')
  runtime.setReceive(context, { status: 'open', ready: true })
  runtime.observeHttp(context, { ok: true }, { ticket: runtime.beginHttp() })
  sources[0].onmessage({ data: JSON.stringify({ type: 'runtime', snapshot: snapshot(runtime) }) })
  assert.equal(client.getSnapshot().problem, null)
  assert.equal(client.getSnapshot().label, '在线')
  client.dispose()
})

test('quota exhaustion keeps chat online and only starts the quota notice', async () => {
  const runtime = createRuntimeState({ configNs: 'muche', runtimeId: 'r1' })
  runtime.configure(CFG)
  const context = runtime.context()
  runtime.observeHttp(context, { ok: true }, { ticket: runtime.beginHttp() })
  runtime.setReceive(context, { status: 'open', ready: true })
  const { client, sources } = harness({ bootstrap: async () => ({ ok: true, snapshot: snapshot(runtime) }) })
  client.start()
  await tick()
  sources[0].onopen()
  await tick()
  sources[0].onmessage({ data: JSON.stringify({ type: 'runtime', snapshot: snapshot(runtime) }) })
  assert.equal(client.getSnapshot().label, '在线')
  runtime.observeHttp(context, { ok: false, status: 429, code: 'message_quota_exhausted', reset_at: '2099-01-01T00:00:00Z' }, { ticket: runtime.beginHttp(), operation: 'chat' })
  sources[0].onmessage({ data: JSON.stringify({ type: 'runtime', snapshot: snapshot(runtime) }) })
  assert.equal(client.getSnapshot().label, '在线')
  assert.equal(client.getSnapshot().problem, null)
  client.dispose()
})

test('unreachable same-origin runtime marks delivery offline without inventing config faults', async () => {
  const { client, sources } = harness({ bootstrap: async () => { const e = new TypeError('Failed to fetch'); throw e } })
  client.start()
  await tick()
  assert.equal(client.getSnapshot().label, '离线')
  assert.equal(client.getSnapshot().problem.code, 'HOST_UNAVAILABLE')
  assert.equal(sources.length, 1)
  client.dispose()
})