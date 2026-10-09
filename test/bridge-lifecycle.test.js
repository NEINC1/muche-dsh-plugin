/** Scoped startup facts are fenced separately from bridge execution/admission receipts. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRuntimeState } from '../lib/runtime-state.js'
import { BRIDGE_DEPENDENCIES, BRIDGE_STARTUP } from '../lib/errors.js'
import { registerDshBridge, getDshBridgeStatus, requestDshBridgeRefresh } from '../lib/dsh-bridge.js'

const CFG = { backendUrl: 'https://example.test/api', apiKey: 'test-key-a', workspacePath: '', bridgeId: 'test-host' }
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }

function fixture(t, { config = { ...CFG }, withDeps = true, retryDelays = [5, 10], startStates = [{ status: 'connecting', ready: false }], update = async () => {} } = {}) {
  const runtime = createRuntimeState({ configNs: 'bridge-test', runtimeId: randomUUID() })
  runtime.configure({ backendUrl: typeof config.backendUrl === 'string' ? config.backendUrl : CFG.backendUrl, apiKey: typeof config.apiKey === 'string' ? config.apiKey : CFG.apiKey })
  const listeners = new Map(), created = [], observations = [], writes = [], prompts = []
  const services = {}
  const installDeps = () => {
    services.sessionController = { create: async () => ({ sessionId: 'session' }), prompt: async (request) => { prompts.push(request) } }
    services.workspaceRegistry = { resolveByPath: async () => ({ id: 'workspace' }) }
  }
  if (withDeps) installDeps()
  const ctx = {
    get: (name) => services[name],
    settings: { update: async (...args) => { writes.push(args); return update(...args) } },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
      return () => { listeners.get(name)?.delete(listener); if (listeners.get(name)?.size === 0) listeners.delete(name) }
    },
  }
  const bridge = registerDshBridge(ctx, config, {
    getContext: runtime.context,
    onState: (state, context) => { observations.push({ state, context }); runtime.setBridge(context, state) },
    dependencyRetryDelays: retryDelays,
    createTransport: (opts) => {
      const transport = {
        opts, sent: [], disposed: false, disposeCalls: 0, state: { status: 'idle', ready: false },
        start() { for (const state of startStates) this.status(state) },
        getState() { return { ...this.state } },
        status(state) { this.state = state; opts.onStatus?.(state) },
        ack(frame = { ok: true }) { opts.onHelloAck?.(frame) },
        dispose() { this.disposed = true; this.disposeCalls += 1; this.status({ status: 'closed', ready: false }) },
        sendFrame(frame) { if (this.state.status !== 'open') throw new Error('fake transport not open'); this.sent.push(frame) },
      }
      created.push(transport)
      return transport
    },
  })
  const refresh = (next = config) => { runtime.configure(next); return bridge.refresh(next, runtime.context()) }
  t.after(() => { bridge.dispose(); runtime.dispose() })
  return { bridge, runtime, ctx, services, created, observations, writes, prompts, listeners, installDeps, refresh }
}

test('缺 key/base 或配置形态错误优先 not-started，不探依赖、不建桥', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { config: { ...CFG, apiKey: '', backendUrl: '' }, withDeps: false })
  for (const cfg of [
    { ...CFG, apiKey: '' }, { ...CFG, apiKey: '  ' },
    { ...CFG, backendUrl: '' }, { ...CFG, backendUrl: '  ' },
    { ...CFG, backendUrl: 'not a URL' }, { ...CFG, backendUrl: 'ftp://example.test/api' },
    { ...CFG, backendUrl: 'https://user:secret@example.test/api' },
    { ...CFG, backendUrl: 'https://example.test/api?query=1' },
  ]) {
    await f.refresh(cfg)
    assert.equal(f.bridge.getState().phase, 'not-started')
    assert.equal(f.bridge.getState().startupComplete, false)
    assert.equal(f.bridge.getState().code, undefined)
    t.mock.timers.tick(60000)
    assert.equal(f.bridge.getState().phase, 'not-started')
  }
  assert.equal(f.created.length, 0)
  assert.equal(f.writes.length, 0)
  assert.ok(f.observations.every(({ state }) => state.phase === 'not-started'))
})

test('缺执行依赖先静默 starting，有界等待中补齐后自动恢复；真 ACK 才 ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { withDeps: false })
  assert.equal(f.bridge.getState().phase, 'starting')
  assert.equal(f.runtime.getSnapshot().problem, null)
  t.mock.timers.tick(5)
  assert.equal(f.bridge.getState().phase, 'starting')
  assert.ok(f.observations.every(({ state }) => !state.startupComplete && !state.code && !state.reason))
  f.installDeps()
  t.mock.timers.tick(10)
  await flush()
  assert.equal(f.created.length, 1)
  const transport = f.created[0]
  transport.status({ status: 'open', ready: false })
  assert.equal(f.bridge.getState().phase, 'starting')
  assert.equal(f.bridge.getState().startupComplete, false)
  assert.equal(transport.sent.filter((frame) => frame.type === 'dsh_hello').length, 1)
  // 传输 ready 但后端尚未确认登记：保持 starting，不假装在线。
  transport.status({ status: 'open', ready: true })
  assert.equal(f.bridge.getState().phase, 'starting')
  assert.equal(f.bridge.getState().startupComplete, false)
  transport.ack({ ok: true })
  assert.equal(f.bridge.getState().phase, 'ready')
  assert.equal(f.bridge.getState().startupComplete, true)
  assert.equal(f.runtime.getSnapshot().bridge.phase, 'ready')
  assert.equal(transport.sent.filter((frame) => frame.type === 'dsh_hello').length, 1, 'ready 变化不重复协议登记')
})

test('后端拒绝登记进 fault，不靠重连自愈；换配置后新连接重新确认', async (t) => {
  const f = fixture(t)
  await f.refresh()
  const transport = f.created[0]
  transport.status({ status: 'open', ready: false })
  transport.status({ status: 'open', ready: true })
  assert.equal(f.bridge.getState().phase, 'starting')
  transport.ack({ ok: false, code: 'upgrade_required' })
  assert.equal(f.bridge.getState().phase, 'fault')
  assert.equal(f.bridge.getState().startupComplete, true)
  await f.refresh({ ...CFG, apiKey: 'test-key-b' })
  assert.equal(f.bridge.getState().phase, 'starting')
  const next = f.created[1]
  next.status({ status: 'open', ready: false })
  next.status({ status: 'open', ready: true })
  assert.equal(f.bridge.getState().phase, 'starting')
  next.ack({ ok: true })
  assert.equal(f.bridge.getState().phase, 'ready')
})

test('拒收码与后端同语义：非法登记进启动失败，缺席进离线', async (t) => {
  for (const [code, expected] of [['protocol_error', BRIDGE_STARTUP], ['bridge_unavailable', 'BRIDGE_OFFLINE']]) {
    const f = fixture(t)
    await f.refresh()
    const transport = f.created[0]
    transport.status({ status: 'open', ready: false })
    transport.status({ status: 'open', ready: true })
    assert.equal(f.bridge.getState().phase, 'starting')
    transport.ack({ ok: false, code })
    assert.equal(f.bridge.getState().phase, 'fault')
    assert.equal(f.bridge.getState().startupComplete, true)
    assert.equal(f.bridge.getState().code, expected)
    f.bridge.dispose()
    f.runtime.dispose()
  }
})

test('等待耗尽才完成启动并 fault，恢复连接期间保留失败直至真实 ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { withDeps: false })
  t.mock.timers.tick(5)
  assert.equal(f.bridge.getState().phase, 'starting')
  t.mock.timers.tick(10)
  assert.equal(f.bridge.getState().phase, 'fault')
  assert.equal(f.bridge.getState().startupComplete, true)
  assert.equal(f.bridge.getState().code, BRIDGE_DEPENDENCIES)
  assert.equal(f.runtime.getSnapshot().problem.kind, 'bridge')
  const count = f.observations.length
  t.mock.timers.tick(60000)
  assert.equal(f.observations.length, count, '耗尽后不能再挂重试')
  f.installDeps()
  await f.refresh()
  assert.equal(f.created.length, 1)
  assert.equal(f.bridge.getState().phase, 'fault')
  f.created[0].status({ status: 'open', ready: false })
  assert.equal(f.bridge.getState().phase, 'fault')
  f.created[0].status({ status: 'open', ready: true })
  assert.equal(f.bridge.getState().phase, 'fault')
  f.created[0].ack({ ok: true })
  assert.equal(f.bridge.getState().phase, 'ready')
  assert.equal(f.runtime.getSnapshot().problem, null)
})

test('同步 start 的 open/ack 状态回调可观察，协议 hello 仅发一次', async (t) => {
  const f = fixture(t, { startStates: [{ status: 'open', ready: false }, { status: 'open', ready: true }] })
  await f.refresh()
  assert.equal(f.created.length, 1)
  assert.equal(f.bridge.getState().phase, 'starting')
  f.created[0].ack({ ok: true })
  assert.equal(f.bridge.getState().phase, 'ready')
  assert.equal(f.bridge.getState().startupComplete, true)
  assert.equal(f.created[0].sent.filter((frame) => frame.type === 'dsh_hello').length, 1)
  assert.ok(f.observations.some(({ state }) => state.phase === 'starting' && !state.startupComplete))
  assert.ok(f.observations.some(({ state }) => state.phase === 'ready' && state.startupComplete))
})

test('已 ready 后依赖消失立即 fault，不退回初次启动的静默等待', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t)
  await f.refresh()
  f.created[0].status({ status: 'open', ready: false })
  f.created[0].status({ status: 'open', ready: true })
  f.created[0].ack({ ok: true })
  delete f.services.sessionController
  await f.refresh()
  assert.equal(f.created[0].disposed, true)
  assert.equal(f.bridge.getState().phase, 'fault')
  assert.equal(f.bridge.getState().startupComplete, true)
  assert.equal(f.bridge.getState().code, BRIDGE_DEPENDENCIES)
  t.mock.timers.tick(5)
  assert.equal(f.bridge.getState().phase, 'fault')
  f.installDeps()
  t.mock.timers.tick(10)
  await flush()
  assert.equal(f.created.length, 2)
  assert.equal(f.bridge.getState().phase, 'fault')
  f.created[1].status({ status: 'open', ready: true })
  assert.equal(f.bridge.getState().phase, 'fault')
  f.created[1].ack({ ok: true })
  assert.equal(f.bridge.getState().phase, 'ready')
})

test('identity 明确失败结束 startup 为 fault，不把未保存身份当成功', async (t) => {
  const f = fixture(t, { config: { ...CFG, bridgeId: '' }, update: async () => { throw new Error('fake settings rejected') } })
  assert.equal(f.bridge.getState().phase, 'starting')
  assert.equal(f.bridge.getState().startupComplete, false)
  await f.refresh()
  assert.equal(f.bridge.getState().phase, 'fault')
  assert.equal(f.bridge.getState().startupComplete, true)
  assert.equal(f.bridge.getState().code, BRIDGE_STARTUP)
  assert.equal(f.created.length, 0)
  assert.equal(f.writes.length, 1, '同宿主并发 refresh 共享身份保存')
})

for (const lateResult of ['resolve', 'reject']) {
  test(`A identity await→B 配置代际，旧 ${lateResult} 结果不回流/不换回旧 key`, async (t) => {
    let settle
    const pending = new Promise((resolve, reject) => { settle = lateResult === 'resolve' ? resolve : () => reject(new Error('late identity rejected')) })
    const f = fixture(t, { config: { ...CFG, bridgeId: '' }, update: () => pending })
    assert.equal(f.writes.length, 1)
    const oldContext = f.runtime.context()
    const next = { ...CFG, apiKey: 'test-key-b', bridgeId: 'host-b' }
    await f.refresh(next)
    assert.equal(f.created.length, 1)
    assert.equal(f.created[0].opts.apiKey, next.apiKey)
    f.created[0].status({ status: 'open', ready: false })
    f.created[0].status({ status: 'open', ready: true })
    f.created[0].ack({ ok: true })
    const offset = f.observations.length
    settle()
    await flush()
    assert.equal(f.created.length, 1)
    assert.equal(f.bridge.getState().phase, 'ready')
    assert.equal(f.created[0].sent[0].host_id, 'host-b')
    assert.ok(f.observations.slice(offset).every(({ context }) => context.generation !== oldContext.generation))
    assert.equal(f.runtime.getSnapshot().generation, oldContext.generation + 1)
  })
}

test('单次 refresh 只读一次 volatile cfg，并将全 context 穿过 identity await', async (t) => {
  const counts = {}, values = { ...CFG, bridgeId: '' }, config = {}
  for (const field of Object.keys(values)) config[field] = { get() { counts[field] = (counts[field] || 0) + 1; return values[field] } }
  let resolve
  const pending = new Promise((done) => { resolve = done })
  const f = fixture(t, { config, update: () => pending })
  const captured = f.runtime.context()
  assert.deepEqual(counts, { backendUrl: 1, apiKey: 1, workspacePath: 1, bridgeId: 1 })
  values.apiKey = 'changed-without-driver'
  values.backendUrl = 'https://other.test/api'
  resolve()
  await flush()
  assert.equal(f.created.length, 1)
  assert.equal(f.created[0].opts.apiKey, CFG.apiKey)
  assert.equal(f.created[0].opts.backendUrl, CFG.backendUrl)
  assert.deepEqual(counts, { backendUrl: 1, apiKey: 1, workspacePath: 1, bridgeId: 1 })
  assert.ok(f.observations.every(({ context }) => JSON.stringify(context) === JSON.stringify(captured)))
})

test('首连真实失败完成 startup；已 ready 后 closed/connecting 均保持 fault 直到 ack', async (t) => {
  const f = fixture(t)
  await f.refresh()
  const transport = f.created[0]
  assert.equal(f.bridge.getState().phase, 'starting')
  transport.status({ status: 'closed', ready: false, code: 'NETWORK', retryable: true })
  assert.equal(f.bridge.getState().phase, 'fault')
  assert.equal(f.bridge.getState().startupComplete, true)
  assert.equal(f.bridge.getState().code, 'NETWORK')
  transport.status({ status: 'connecting', ready: false })
  transport.status({ status: 'open', ready: false })
  assert.equal(f.bridge.getState().phase, 'fault')
  transport.status({ status: 'open', ready: true })
  assert.equal(f.bridge.getState().phase, 'fault')
  transport.ack({ ok: true })
  assert.equal(f.bridge.getState().phase, 'ready')
  transport.status({ status: 'closed', ready: false, code: 'TIMEOUT', retryable: true })
  assert.equal(f.bridge.getState().phase, 'fault')
  transport.status({ status: 'connecting', ready: false })
  assert.equal(f.bridge.getState().phase, 'fault')
  assert.equal(f.bridge.getState().code, 'TIMEOUT')
  transport.status({ status: 'open', ready: false })
  assert.equal(f.bridge.getState().phase, 'fault')
  transport.status({ status: 'open', ready: true })
  transport.ack({ ok: true })
  assert.equal(f.bridge.getState().phase, 'ready')
  assert.equal(transport.sent.filter((frame) => frame.type === 'dsh_hello').length, 2)
})

test('同配置 refresh 复用连接且不失效 callbacks/不擦除故障；换配置重置启动并拒旧 callbacks', async (t) => {
  const f = fixture(t)
  await f.refresh()
  const old = f.created[0]
  old.status({ status: 'open', ready: false })
  old.status({ status: 'open', ready: true })
  old.ack({ ok: true })
  await f.refresh()
  assert.equal(f.created.length, 1)
  assert.equal(f.bridge.getState().phase, 'ready')
  old.status({ status: 'closed', ready: false, code: 'NETWORK' })
  assert.equal(f.bridge.getState().phase, 'fault')
  await f.refresh()
  assert.equal(f.bridge.getState().phase, 'fault')
  await f.refresh({ ...CFG, apiKey: 'test-key-b' })
  assert.equal(old.disposeCalls, 1)
  assert.equal(f.created.length, 2)
  assert.equal(f.bridge.getState().phase, 'starting')
  assert.equal(f.bridge.getState().startupComplete, false)
  const count = f.observations.length, stable = f.runtime.getSnapshot()
  old.status({ status: 'closed', ready: false, code: 'AUTH_FAILED' })
  old.status({ status: 'open', ready: true })
  old.opts.onTask({ type: 'dsh_task', task_id: 'old-task', run_id: 'old-run', task: 'late task' })
  old.opts.onQuery({ type: 'dsh_session_query', task_id: 'old-task', command_id: 'old-query' })
  await flush()
  assert.equal(f.observations.length, count)
  assert.deepEqual(f.runtime.getSnapshot(), stable)
  assert.equal(f.prompts.length, 0)
  assert.equal(f.created[1].sent.length, 0)
  f.created[1].status({ status: 'open', ready: false })
  f.created[1].status({ status: 'open', ready: true })
  f.created[1].ack({ ok: true })
  assert.equal(f.bridge.getState().phase, 'ready')
})

test('dispose 清依赖 timer/事件/global fiber；迟到 identity 不接线', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const before = getDshBridgeStatus().fibers.length
  const waiting = fixture(t, { withDeps: false })
  assert.equal(waiting.listeners.size, 4)
  waiting.bridge.dispose(); waiting.bridge.dispose()
  assert.equal(waiting.listeners.size, 0)
  const count = waiting.observations.length
  t.mock.timers.tick(60000)
  assert.equal(waiting.observations.length, count)
  assert.equal(waiting.created.length, 0)
  assert.equal(waiting.bridge.getState().phase, 'stopped')
  let resolve
  const pending = fixture(t, { config: { ...CFG, bridgeId: '' }, update: () => new Promise((done) => { resolve = done }) })
  pending.bridge.dispose()
  resolve()
  await flush()
  await requestDshBridgeRefresh()
  assert.equal(pending.created.length, 0)
  assert.equal(pending.bridge.getState().phase, 'stopped')
  assert.equal(getDshBridgeStatus().fibers.length, before)
})

test('scoped onState 不取全 fibers 最坏结果，别的 fiber fault 不污染当前 runtime', async (t) => {
  const main = fixture(t)
  await main.refresh()
  main.created[0].status({ status: 'open', ready: false })
  main.created[0].status({ status: 'open', ready: true })
  main.created[0].ack({ ok: true })
  const other = fixture(t, { withDeps: false, retryDelays: [] })
  assert.equal(other.bridge.getState().phase, 'fault')
  assert.ok(getDshBridgeStatus().fibers.some((fiber) => fiber.phase === 'fault'))
  assert.equal(main.runtime.getSnapshot().bridge.phase, 'ready')
  assert.equal(main.runtime.getSnapshot().problem, null)
  const seq = main.runtime.getSnapshot().seq
  other.bridge.dispose()
  assert.equal(main.runtime.getSnapshot().seq, seq)
})
