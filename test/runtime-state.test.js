import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeState, watchHttpReadiness } from '../lib/runtime-state.js'

const CFG = { backendUrl: 'https://example.test/custom-prefix', apiKey: 'test-only-secret' }
const tick = () => new Promise((resolve) => setImmediate(resolve))
function ready(runtime) {
  const context = runtime.context()
  runtime.observeHttp(context, { ok: true })
  runtime.setReceive(context, { status: 'open', ready: true })
  return context
}
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('saved config is distinct from authenticated readiness; snapshots omit credentials', () => {
  const runtime = createRuntimeState({ configNs: 'mkt-muche', runtimeId: 'host-test' })
  assert.equal(runtime.getSnapshot().chat.phase, 'connecting')
  runtime.configure(CFG)
  assert.equal(runtime.getSnapshot().chat.phase, 'connecting')
  assert.equal(runtime.getSnapshot().problem, null)
  assert.ok(!JSON.stringify(runtime.getSnapshot()).includes(CFG.apiKey))
  assert.ok(!JSON.stringify(runtime.getSnapshot()).includes(CFG.backendUrl))
  const context = runtime.context()
  runtime.setReceive(context, { status: 'open', ready: false })
  assert.equal(runtime.getSnapshot().chat.phase, 'connecting')
  runtime.observeHttp(context, { ok: true })
  assert.equal(runtime.getSnapshot().chat.phase, 'connecting')
  runtime.setReceive(context, { status: 'open', ready: true })
  assert.equal(runtime.getSnapshot().chat.phase, 'online')
})

test('empty/invalid config produces one generic config problem; filling fields is not authentication', () => {
  const runtime = createRuntimeState()
  runtime.configure({ backendUrl: '', apiKey: '' })
  assert.equal(runtime.getSnapshot().problem.text, '请检查配置')
  runtime.configure({ ...CFG, backendUrl: 'not-a-url' })
  assert.equal(runtime.getSnapshot().problem.text, '请检查配置')
  runtime.configure(CFG)
  const context = runtime.context()
  runtime.observeHttp(context, { ok: false, code: 'AUTH_FAILED', status: 401 })
  assert.equal(runtime.getSnapshot().problem.text, '请检查配置')
  assert.equal(runtime.configure({ ...CFG }), false)
  assert.equal(runtime.getSnapshot().problem.text, '请检查配置')
  ready(runtime)
  assert.equal(runtime.getSnapshot().problem, null)
  assert.equal(runtime.getSnapshot().chat.phase, 'online')
})

test('bridge startup is silent; settled bridge faults never make ready chat offline', () => {
  const runtime = createRuntimeState()
  runtime.configure(CFG)
  const context = ready(runtime)
  for (const phase of ['not-started', 'starting']) {
    runtime.setBridge(context, { phase, startupComplete: false })
    assert.equal(runtime.getSnapshot().problem, null)
  }
  runtime.setBridge(context, { phase: 'fault', startupComplete: false, code: 'BRIDGE_OFFLINE' })
  assert.equal(runtime.getSnapshot().problem, null)
  runtime.setBridge(context, { phase: 'fault', startupComplete: true, code: 'BRIDGE_OFFLINE' })
  assert.equal(runtime.getSnapshot().problem.kind, 'bridge')
  assert.equal(runtime.getSnapshot().chat.phase, 'online')
  runtime.setBridge(context, { phase: 'ready', startupComplete: true })
  assert.equal(runtime.getSnapshot().problem, null)
})

test('network disconnect stays failed during reconnect; actual receive readiness clears it', () => {
  const runtime = createRuntimeState()
  runtime.configure(CFG)
  const context = ready(runtime)
  runtime.setReceive(context, { status: 'closed', code: 'NETWORK' })
  assert.equal(runtime.getSnapshot().chat.phase, 'offline')
  assert.equal(runtime.getSnapshot().problem.text, '连接暂时中断，正在重连')
  runtime.setReceive(context, { status: 'connecting' })
  assert.equal(runtime.getSnapshot().chat.phase, 'offline')
  runtime.setReceive(context, { status: 'open', ready: true })
  assert.equal(runtime.getSnapshot().chat.phase, 'online')
  assert.equal(runtime.getSnapshot().problem, null)
})

test('quota, validation, waiting/degraded business outcomes do not latch chat offline', () => {
  const runtime = createRuntimeState()
  runtime.configure(CFG)
  const context = ready(runtime)
  const outcomes = [
    { ok: false, status: 429, code: 'message_quota_exhausted', reset_at: '2099-01-01T00:00:00Z' },
    { ok: false, status: 429, code: 'RATE_LIMITED' },
    { ok: false, status: 422, code: 'INPUT_INVALID' },
    { ok: false, status: 503, code: 'HTTP_ERROR' },
    { ok: true, waiting_for_decision: true }, { ok: true, superseded: true }, { ok: true, degraded: true },
  ]
  for (const outcome of outcomes) {
    runtime.observeHttp(context, outcome, { operation: 'chat' })
    assert.equal(runtime.getSnapshot().chat.phase, 'online', JSON.stringify(outcome))
    assert.equal(runtime.getSnapshot().problem, null)
  }
})

test('config generation fences old successes, failures, frames and bridge results', () => {
  const runtime = createRuntimeState()
  runtime.configure(CFG)
  const old = ready(runtime)
  runtime.configure({ ...CFG, apiKey: 'another-test-only-key' })
  const before = runtime.getSnapshot()
  assert.equal(runtime.observeHttp(old, { ok: false, code: 'AUTH_FAILED' }), false)
  assert.equal(runtime.observeHttp(old, { ok: true }), false)
  assert.equal(runtime.setReceive(old, { status: 'open', ready: true }), false)
  assert.equal(runtime.setBridge(old, { phase: 'fault', startupComplete: true }), false)
  assert.equal(runtime.getSnapshot(), before)
  assert.equal(before.chat.phase, 'connecting')
  assert.equal(before.problem, null)
  ready(runtime)
  assert.equal(runtime.getSnapshot().chat.phase, 'online')
})

test('subscriptions immediately replay full current state, dedupe unchanged facts and dispose cleanly', () => {
  const runtime = createRuntimeState()
  runtime.configure(CFG)
  const context = ready(runtime)
  const seen = []
  const off = runtime.subscribe((snapshot) => seen.push(snapshot))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].chat.phase, 'online')
  runtime.setReceive(context, { status: 'open', ready: true })
  assert.equal(seen.length, 1)
  off(); off()
  runtime.setBridge(context, { phase: 'fault', startupComplete: true })
  assert.equal(seen.length, 1)
  runtime.dispose()
  assert.equal(runtime.observeHttp(context, { ok: true }), false)
})

test('HTTP readiness is activation-driven, singleflight, failure-only retry, and cancelled on idle', async () => {
  const runtime = createRuntimeState()
  runtime.configure(CFG)
  const checks = []
  const timers = new Map()
  const stop = watchHttpReadiness({ runtime, getConfig: () => CFG, probe: (cfg, signal) => {
    const gate = deferred(); checks.push({ gate, cfg, signal }); return gate.promise
  }, setTimer: (fn) => { const key = {}; timers.set(key, fn); return key }, clearTimer: (key) => timers.delete(key) })
  assert.equal(checks.length, 0)
  runtime.setReceive(runtime.context(), { status: 'connecting' })
  await tick()
  assert.equal(checks.length, 1)
  runtime.setReceive(runtime.context(), { status: 'open', ready: true })
  assert.equal(checks.length, 1)
  checks[0].gate.resolve({ ok: false, code: 'NETWORK' })
  await tick()
  assert.equal(timers.size, 1)
  const retry = [...timers.values()][0]; timers.clear(); retry()
  await tick()
  assert.equal(checks.length, 2)
  checks[1].gate.resolve({ ok: true })
  await tick()
  assert.equal(runtime.getSnapshot().chat.phase, 'online')
  assert.equal(timers.size, 0)
  runtime.setBridge(runtime.context(), { phase: 'fault', startupComplete: true })
  await tick()
  assert.equal(checks.length, 2, 'bridge changes must not start another stable HTTP probe')
  runtime.observeHttp(runtime.context(), { ok: false, code: 'NETWORK' }, { ticket: runtime.beginHttp() })
  await tick()
  assert.equal(checks.length, 3)
  runtime.setReceive(runtime.context(), { status: 'idle' })
  assert.equal(checks[2].signal.aborted, true)
  checks[2].gate.resolve({ ok: false, code: 'AUTH_FAILED' })
  await tick()
  assert.equal(runtime.getSnapshot().configuration.code, '')
  assert.equal(timers.size, 0)
  stop(); runtime.dispose()
})

test('concurrent same-generation HTTP operations settle by observation order, not completion', () => {
  const runtime = createRuntimeState()
  runtime.configure(CFG)
  const context = runtime.context()
  runtime.setReceive(context, { status: 'open', ready: true })
  const early = runtime.beginHttp()
  const late = runtime.beginHttp()
  runtime.observeHttp(context, { ok: true }, { operation: 'history', ticket: late })
  assert.equal(runtime.getSnapshot().chat.send.status, 'ready')
  runtime.observeHttp(context, { ok: false, code: 'AUTH_FAILED', status: 401 }, { operation: 'history', ticket: early })
  assert.equal(runtime.getSnapshot().chat.send.status, 'ready', 'a slower earlier 401 must not unseat newer readiness')
  assert.equal(runtime.getSnapshot().problem, null)
  const rejected = runtime.beginHttp()
  const older = rejected - 1
  runtime.observeHttp(context, { ok: false, code: 'AUTH_FAILED', status: 401 }, { operation: 'history', ticket: rejected })
  assert.equal(runtime.getSnapshot().configuration.code, 'AUTH_FAILED')
  runtime.observeHttp(context, { ok: true }, { operation: 'history', ticket: older })
  assert.equal(runtime.getSnapshot().configuration.code, 'AUTH_FAILED', 'an older success must not clear a credential rejection')
  runtime.observeHttp(context, { ok: true }, { operation: 'history', ticket: runtime.beginHttp() })
  assert.equal(runtime.getSnapshot().configuration.code, '')
  assert.equal(runtime.getSnapshot().chat.phase, 'online')
})

test('a thrown readiness probe is not treated as network failure evidence', async () => {
  const runtime = createRuntimeState()
  runtime.configure(CFG)
  const timers = new Map()
  watchHttpReadiness({
    runtime,
    getConfig: () => CFG,
    probe: () => { const error = new TypeError('internal programming error'); throw error },
    setTimer: (fn) => { const key = {}; timers.set(key, fn); return key },
    clearTimer: (key) => timers.delete(key),
  })
  runtime.setReceive(runtime.context(), { status: 'connecting' })
  await tick()
  const snapshot = runtime.getSnapshot()
  assert.equal(snapshot.chat.send.status, 'checking')
  assert.notEqual(snapshot.chat.send.code, 'NETWORK')
  assert.equal(timers.size, 0)
  runtime.dispose()
})

test('late HTTP bootstrap after config change cannot revive or poison the new config', async () => {
  const runtime = createRuntimeState()
  let cfg = CFG
  runtime.configure(cfg)
  const gates = []
  const stop = watchHttpReadiness({ runtime, getConfig: () => cfg, probe: () => { const gate = deferred(); gates.push(gate); return gate.promise } })
  runtime.setReceive(runtime.context(), { status: 'connecting' })
  await tick()
  cfg = { ...CFG, apiKey: 'new-test-only' }
  runtime.configure(cfg)
  runtime.setReceive(runtime.context(), { status: 'open', ready: true })
  await tick()
  assert.equal(gates.length, 2)
  gates[1].resolve({ ok: true })
  await tick()
  gates[0].resolve({ ok: false, code: 'AUTH_FAILED' })
  await tick()
  assert.equal(runtime.getSnapshot().chat.phase, 'online')
  assert.equal(runtime.getSnapshot().problem, null)
  stop(); runtime.dispose()
})
