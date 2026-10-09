/** SSE lifecycle contracts use the same runtime projection as the host driver. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { WebSocketServer } from 'ws'
import { BackendWs } from '../lib/backend_ws.js'
import { createRuntimeState } from '../lib/runtime-state.js'
import { createPanelEventsHub, registerPanelEvents } from '../lib/panel-events.js'

const CFG = { backendUrl: 'https://example.test/api', apiKey: 'test-key-a', workspacePath: '' }

function fakeRes() {
  const res = new EventEmitter()
  Object.assign(res, {
    written: [], ended: false, code: 0, headers: null,
    writeHead(code, headers) { this.code = code; this.headers = headers },
    write(chunk) { this.written.push(String(chunk)) },
    end(chunk) { if (chunk) this.write(chunk); this.ended = true; this.emit('close') },
    fireClose() { this.emit('close') },
  })
  return res
}
const frames = (res) => res.written.filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
const snapshots = (res) => frames(res).filter((frame) => frame.type === 'runtime').map((frame) => frame.snapshot)

function harness(t, { startStates = [{ status: 'connecting', ready: false }], startFrame, initial = CFG } = {}) {
  const actual = createRuntimeState({ configNs: 'panel-test', runtimeId: 'panel-runtime' })
  let watchers = 0
  const runtime = {
    ...actual,
    subscribe(listener) {
      watchers += 1
      const off = actual.subscribe(listener)
      let stopped = false
      return () => { if (!stopped) { stopped = true; watchers -= 1; off() } }
    },
  }
  const created = []
  const hub = createPanelEventsHub({
    runtime,
    createUpstream: (opts) => {
      const up = {
        opts, started: false, disposed: false, disposeCalls: 0, state: { status: 'idle', ready: false },
        start() {
          this.started = true
          for (const state of startStates) this.status(state)
          if (startFrame) opts.onReply(startFrame)
        },
        getState() { return { ...this.state } },
        dispose() { this.disposed = true; this.disposeCalls += 1; this.status({ status: 'closed', ready: false }) },
        status(state) { this.state = state; opts.onStatus?.(state) },
        emit(kind, frame) { opts[{ reply: 'onReply', proactive: 'onProactive', dialogue_updated: 'onDialogueUpdated', error: 'onError' }[kind]]?.(frame) },
      }
      created.push(up)
      return up
    },
  })
  const configure = (cfg) => { runtime.configure(cfg); hub.configure(cfg, runtime.context()) }
  configure(initial)
  t.after(() => { hub.dispose(); runtime.dispose() })
  return { hub, runtime, created, configure, get watchers() { return watchers } }
}

function routeHarness({ rejection } = {}) {
  const handlers = {}, hooks = new Map(), cleanups = []
  const ctx = {
    connection: { requestRejection: () => rejection },
    webServer: { register: ({ path, handler }) => { handlers[path] = handler; return () => { delete handlers[path] } } },
    effect: (setup) => { const dispose = setup(); if (typeof dispose === 'function') cleanups.push(dispose) },
    on: (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name) },
    get: () => undefined,
  }
  return { ctx, handlers, hooks, cleanups, dispose: () => { for (const fn of cleanups.splice(0)) fn() } }
}

test('无 key 仍订阅完整状态，不建上游、不发旧 status/upstream/hello', (t) => {
  const f = harness(t, { initial: { ...CFG, apiKey: '' } })
  const res = fakeRes()
  assert.equal(f.hub.subscribe(res), true)
  assert.equal(f.created.length, 0)
  assert.equal(f.hub.hasUpstream, false)
  assert.equal(f.hub.subscriberCount, 1)
  assert.equal(f.watchers, 1)
  assert.deepEqual(frames(res), [{ type: 'runtime', snapshot: f.runtime.getSnapshot() }])
  assert.equal(snapshots(res)[0].configuration.code, 'NEED_KEY')
  assert.equal(JSON.stringify(frames(res)).includes(CFG.backendUrl), false)
})

test('非法 URL/query 和空白 key 消费已提交配置问题，不建立真实上游', (t) => {
  const f = harness(t, { initial: { ...CFG, backendUrl: 'not a URL' } })
  const res = fakeRes()
  f.hub.subscribe(res)
  assert.equal(snapshots(res)[0].configuration.code, 'TARGET')
  for (const cfg of [
    { ...CFG, backendUrl: 'https://example.test?query=1' },
    { ...CFG, backendUrl: 'https://example.test/api#fragment' },
    { ...CFG, apiKey: '   ' },
  ]) {
    f.configure(cfg)
    assert.ok(snapshots(res).at(-1).configuration.code)
    assert.equal(f.hub.hasUpstream, false)
  }
  assert.equal(f.created.length, 0)
  assert.equal(f.hub.subscriberCount, 1)
})

test('同代真实 HTTP 鉴权失败停上游，实际 retry 成功清问题并恢复上游', (t) => {
  const f = harness(t)
  const res = fakeRes()
  f.hub.subscribe(res)
  const old = f.created[0], context = f.runtime.context()
  old.status({ status: 'open', ready: true })
  f.runtime.setBridge(context, { phase: 'ready', startupComplete: true })
  f.runtime.observeHttp(context, { ok: false, status: 401, code: 'AUTH_FAILED' })
  assert.equal(f.hub.hasUpstream, false)
  assert.equal(old.disposed, true)
  assert.equal(f.runtime.getSnapshot().configuration.code, 'AUTH_FAILED')
  assert.equal(f.runtime.getSnapshot().bridge.phase, 'ready')
  assert.equal(f.runtime.getSnapshot().chat.receive.status, 'idle')
  const count = res.written.length
  old.emit('reply', { type: 'reply', text: 'late rejected-key message' })
  assert.equal(res.written.length, count)
  f.runtime.observeHttp(context, { ok: true })
  assert.equal(f.created.length, 2)
  assert.equal(f.hub.hasUpstream, true)
  assert.deepEqual(f.runtime.context(), context, '恢复证据不是新配置代际')
  assert.equal(f.runtime.getSnapshot().configuration.code, '')
  assert.equal(f.runtime.getSnapshot().chat.receive.status, 'connecting')
  f.created[1].status({ status: 'open', ready: true })
  assert.equal(f.runtime.getSnapshot().chat.phase, 'online')
})

test('被拒 A→B 配置清问题时不把旧 A 配置误接到新 B context', (t) => {
  const f = harness(t)
  f.hub.subscribe(fakeRes())
  f.runtime.observeHttp(f.runtime.context(), { ok: false, status: 401, code: 'AUTH_FAILED' })
  const next = { ...CFG, apiKey: 'test-key-b' }
  f.runtime.configure(next)
  assert.equal(f.created.length, 1, 'driver 尚未提交 B cfg 时不可用旧 cfg 建连')
  f.hub.configure(next, f.runtime.context())
  assert.deepEqual(f.created.map((transport) => transport.opts.apiKey), [CFG.apiKey, next.apiKey])
})

test('格式等价配置复用同连接且状态 callbacks 保持有效', (t) => {
  const f = harness(t)
  f.hub.subscribe(fakeRes())
  const context = f.runtime.context()
  f.configure({ ...CFG, backendUrl: ` ${CFG.backendUrl}/ `, apiKey: ` ${CFG.apiKey} ` })
  assert.deepEqual(f.runtime.context(), context)
  assert.equal(f.created.length, 1)
  f.created[0].status({ status: 'closed', ready: false, code: 'NETWORK' })
  assert.equal(f.runtime.getSnapshot().chat.receive.code, 'NETWORK')
})

test('先登记并写完整快照，同步 start 状态/业务帧不丢；上游保持面板池', (t) => {
  const f = harness(t, { startStates: [{ status: 'connecting', ready: false }, { status: 'open', ready: true }], startFrame: { type: 'reply', message_id: 'sync', text: 'reply' } })
  const res = fakeRes()
  const before = f.runtime.getSnapshot()
  assert.equal(f.hub.subscribe(res), true)
  assert.equal(f.created.length, 1)
  assert.equal(f.created[0].opts.channel, '')
  assert.equal(f.created[0].opts.backendUrl, CFG.backendUrl)
  assert.equal(f.created[0].opts.apiKey, CFG.apiKey)
  assert.deepEqual(frames(res)[0], { type: 'runtime', snapshot: before })
  assert.deepEqual(snapshots(res).map((s) => s.chat.receive.status), ['idle', 'connecting', 'open'])
  assert.deepEqual(frames(res).at(-1), { type: 'reply', message_id: 'sync', text: 'reply', context: f.runtime.context() })
})

test('已 open 新订阅/重连首帧是当前完整快照，随后实时收变化', (t) => {
  const f = harness(t)
  const a = fakeRes()
  f.hub.subscribe(a)
  f.created[0].status({ status: 'open', ready: true })
  f.runtime.setBridge(f.runtime.context(), { phase: 'ready', startupComplete: true })
  f.runtime.observeHttp(f.runtime.context(), { ok: true })
  for (const res of [fakeRes(), fakeRes()]) {
    f.hub.subscribe(res)
    assert.deepEqual(frames(res)[0], { type: 'runtime', snapshot: f.runtime.getSnapshot() })
    assert.equal(snapshots(res)[0].chat.phase, 'online')
    assert.equal(snapshots(res)[0].bridge.phase, 'ready')
    res.fireClose()
    assert.equal(res.listenerCount('close'), 0)
  }
  assert.equal(f.created.length, 1)
  f.created[0].status({ status: 'closed', ready: false, code: 'NETWORK', retryable: true })
  assert.equal(snapshots(a).at(-1).chat.receive.code, 'NETWORK')
})

test('业务帧扇出均带建连 context，绝不把上游自带旧 context 当真', (t) => {
  const f = harness(t)
  const a = fakeRes(), b = fakeRes()
  f.hub.subscribe(a); f.hub.subscribe(b)
  for (const kind of ['reply', 'proactive', 'dialogue_updated', 'error']) {
    const frame = { type: kind, text: 'message', context: { runtimeId: 'forged' } }
    f.created[0].emit(kind, frame)
    for (const res of [a, b]) assert.deepEqual(frames(res).at(-1), { ...frame, context: f.runtime.context() })
  }
})

test('A→B 无新增 SSE 即换连，旧 callbacks 不污染快照或业务下行', (t) => {
  const f = harness(t)
  const a = fakeRes(), b = fakeRes()
  f.hub.subscribe(a); f.hub.subscribe(b)
  const oldContext = f.runtime.context(), old = f.created[0]
  old.status({ status: 'open', ready: true })
  const offset = frames(a).length
  f.configure({ ...CFG, apiKey: 'test-key-b' })
  assert.equal(f.created.length, 2)
  assert.equal(old.disposed, true)
  assert.equal(f.created[1].opts.apiKey, 'test-key-b')
  const firstNew = frames(a).slice(offset).find((frame) => frame.type === 'runtime')
  assert.equal(firstNew.snapshot.generation, oldContext.generation + 1)
  assert.equal(firstNew.snapshot.chat.receive.status, 'idle')
  const stable = f.runtime.getSnapshot(), counts = [a.written.length, b.written.length]
  old.emit('reply', { type: 'reply', text: 'late-a' })
  old.emit('dialogue_updated', { type: 'dialogue_updated', message_ids: ['late-history-a'] })
  old.status({ status: 'open', ready: true })
  old.status({ status: 'closed', ready: false, code: 'AUTH_FAILED' })
  assert.deepEqual(f.runtime.getSnapshot(), stable)
  assert.deepEqual([a.written.length, b.written.length], counts)
  f.created[1].emit('reply', { type: 'reply', text: 'new-b' })
  for (const res of [a, b]) assert.deepEqual(frames(res).at(-1).context, f.runtime.context())
  f.configure({ ...CFG, apiKey: '' })
  assert.equal(f.hub.hasUpstream, false)
  assert.equal(f.created[1].disposed, true)
  assert.equal(f.hub.subscriberCount, 2)
  assert.equal(snapshots(a).at(-1).configuration.code, 'NEED_KEY')
})

test('末位退订清 runtime监听/close监听/心跳并释上游，桥接保持独立', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = harness(t)
  const a = fakeRes(), b = fakeRes()
  f.hub.subscribe(a); f.hub.subscribe(b)
  f.runtime.setBridge(f.runtime.context(), { phase: 'ready', startupComplete: true })
  t.mock.timers.tick(25000)
  assert.deepEqual(frames(a).at(-1), { type: 'heartbeat', context: f.runtime.context() })
  a.fireClose()
  assert.equal(f.hub.hasUpstream, true)
  b.fireClose()
  b.fireClose()
  assert.equal(f.hub.hasUpstream, false)
  assert.equal(f.created[0].disposeCalls, 1)
  assert.equal(f.watchers, 0)
  assert.equal(f.hub.subscriberCount, 0)
  assert.equal(a.listenerCount('close'), 0)
  assert.equal(b.listenerCount('close'), 0)
  assert.equal(f.runtime.getSnapshot().chat.receive.status, 'idle')
  assert.equal(f.runtime.getSnapshot().bridge.phase, 'ready')
  const counts = [a.written.length, b.written.length]
  t.mock.timers.tick(75000)
  f.runtime.setBridge(f.runtime.context(), { phase: 'fault', startupComplete: true })
  assert.deepEqual([a.written.length, b.written.length], counts)
})

test('首帧/心跳写失败也清订阅监听，无孤儿连接或计时器', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = harness(t)
  const bad = fakeRes()
  bad.write = () => { throw new Error('response closed') }
  assert.equal(f.hub.subscribe(bad), false)
  assert.equal(f.watchers, 0)
  assert.equal(bad.listenerCount('close'), 0)
  assert.equal(f.created.length, 0)
  const later = fakeRes()
  f.hub.subscribe(later)
  later.write = bad.write
  t.mock.timers.tick(25000)
  assert.equal(f.watchers, 0)
  assert.equal(f.hub.subscriberCount, 0)
  assert.equal(f.hub.hasUpstream, false)
  assert.equal(later.listenerCount('close'), 0)
})

test('dispose 幂等地结束所有 SSE，停上游且旧帧/新订阅均不可复活', (t) => {
  const f = harness(t)
  const a = fakeRes(), b = fakeRes()
  f.hub.subscribe(a); f.hub.subscribe(b)
  const old = f.created[0]
  old.status({ status: 'open', ready: true })
  f.hub.dispose(); f.hub.dispose()
  assert.ok(a.ended && b.ended)
  assert.equal(a.listenerCount('close') + b.listenerCount('close'), 0)
  assert.equal(f.watchers, 0)
  assert.equal(f.hub.subscriberCount, 0)
  assert.equal(f.hub.hasUpstream, false)
  assert.equal(old.disposeCalls, 1)
  assert.equal(f.runtime.getSnapshot().chat.receive.status, 'idle')
  const counts = [a.written.length, b.written.length]
  old.emit('reply', { type: 'reply', text: 'late' })
  old.status({ status: 'open', ready: true })
  assert.deepEqual([a.written.length, b.written.length], counts)
  assert.equal(f.hub.subscribe(fakeRes()), false)
})

test('fallback hub 复用同一 runtime 实现且支持显式 configure', (t) => {
  const created = []
  const hub = createPanelEventsHub({ createUpstream: (opts) => { const up = { start() { opts.onStatus({ status: 'connecting', ready: false }) }, dispose() {} }; created.push(up); return up } })
  t.after(() => hub.dispose())
  hub.configure({ ...CFG, apiKey: '' })
  const res = fakeRes()
  hub.subscribe(res)
  assert.equal(snapshots(res)[0].configuration.code, 'NEED_KEY')
  hub.configure(CFG)
  assert.equal(created.length, 1)
  assert.equal(snapshots(res).at(-1).chat.receive.status, 'connecting')
})

test('路由缺配置仍返回200 SSE可诊断；DSH鉴权门和方法门保持原样', (t) => {
  const f = harness(t, { initial: { backendUrl: '', apiKey: '' } })
  const route = routeHarness()
  t.after(route.dispose)
  assert.equal(registerPanelEvents(route.ctx, {}, undefined, { runtime: f.runtime, hub: f.hub }), false)
  assert.equal(route.hooks.has('loader/volatile-update'), false, 'supplied hub/runtime 禁止第二配置监听')
  const res = fakeRes()
  route.handlers['/api/muche/events']({ method: 'GET' }, res)
  assert.equal(res.code, 200)
  assert.equal(res.headers['Content-Type'], 'text/event-stream')
  assert.equal(snapshots(res)[0].problem.kind, 'config')
  assert.equal(f.created.length, 0)
  const wrongMethod = fakeRes()
  route.handlers['/api/muche/events']({ method: 'POST' }, wrongMethod)
  assert.equal(wrongMethod.code, 405)
  assert.equal(f.hub.subscriberCount, 1)
  for (const rejection of [401, 403]) {
    const denied = routeHarness({ rejection })
    t.after(denied.dispose)
    registerPanelEvents(denied.ctx, {}, undefined, { runtime: f.runtime, hub: f.hub })
    const response = fakeRes()
    denied.handlers['/api/muche/events']({ method: 'GET' }, response)
    assert.equal(response.code, rejection)
    assert.equal(response.ended, true)
    assert.equal(f.hub.subscriberCount, 1)
  }
})

test('standalone 路由由官方 volatile 事件更新现有 SSE，dispose 清该监听', (t) => {
  const route = routeHarness()
  t.after(route.dispose)
  const config = { backendUrl: '', apiKey: '' }
  registerPanelEvents(route.ctx, config)
  const res = fakeRes()
  route.handlers['/api/muche/events']({ method: 'GET' }, res)
  const first = snapshots(res).at(-1)
  config.backendUrl = CFG.backendUrl
  route.hooks.get('loader/volatile-update')()
  assert.equal(snapshots(res).at(-1).generation, first.generation + 1)
  route.dispose()
  assert.equal(route.hooks.size, 0)
  assert.equal(res.listenerCount('close'), 0)
  assert.equal(res.ended, true)
})

test('空 channel 真实建连 URL 不带 channel 参数，默认桥接通道不改变', async () => {
  const seen = []
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  let done
  const complete = new Promise((resolve) => { done = resolve })
  server.on('connection', (sock, req) => {
    seen.push(req.url)
    sock.send(JSON.stringify({ type: 'hello' }))
    if (seen.length === 2) done()
  })
  const backendUrl = `http://127.0.0.1:${server.address().port}`
  const panel = new BackendWs({ backendUrl, apiKey: 'test-key', channel: '' })
  const bridge = new BackendWs({ backendUrl, apiKey: 'test-key' })
  let timeout
  try {
    panel.start(); bridge.start()
    await Promise.race([complete, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('两条上游未到达假后端')), 3000) })])
    assert.ok(seen.some((url) => !url.includes('channel=') && url.includes('/ws?token=')))
    assert.ok(seen.some((url) => url.includes('channel=dsh-bridge')))
  } finally {
    clearTimeout(timeout)
    panel.dispose(); bridge.dispose()
    await new Promise((resolve) => server.close(resolve))
  }
})
