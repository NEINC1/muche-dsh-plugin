/** Route ownership and bridge startup use a fake host/local backend, never live configuration. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { createRegistrationGuard } from '../lib/register-guard.js'
import { BRIDGE_DEPENDENCIES } from '../lib/errors.js'
import { registerRoutes } from '../lib/routes.js'
import { registerPanelEvents } from '../lib/panel-events.js'
import { registerDshBridge, requestDshBridgeRefresh, getDshBridgeStatus } from '../lib/dsh-bridge.js'

const INDEX_SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

function sharedWebServer() {
  // 与官方实现同契约（dsh-host-webserver）：撞重复抛；成功返回注销函数。
  const routes = new Map()
  const table = {
    routes,
    register({ path }) {
      if (routes.has(path)) throw new Error(`webserver: duplicate exact route "${path}"`)
      routes.set(path, true)
      return () => { routes.delete(path) }
    },
    registerUpgrade({ path }) {
      const key = 'upgrade:' + path
      if (routes.has(key)) throw new Error(`webserver: duplicate upgrade route "${path}"`)
      routes.set(key, true)
      return () => { routes.delete(key) }
    },
  }
  return table
}

function routeCtx(overrides = {}) {
  const handlers = {}
  const config = { backendUrl: 'http://127.0.0.1:8000', apiKey: 'k-route', workspacePath: '' }
  return {
    ctx: {
      connection: { requestRejection: () => undefined },
      webServer: {
        register: ({ path, handler }) => {
          if (handlers[path]) throw new Error(`webserver: duplicate exact route "${path}"`)
          handlers[path] = handler
        },
        registerUpgrade: ({ path, handler }) => {
          const key = 'upgrade:' + path
          if (handlers[key]) throw new Error(`webserver: duplicate upgrade route "${path}"`)
          handlers[key] = handler
        },
      },
      get: () => undefined,
      ...overrides,
    },
    handlers,
    config,
  }
}

function bridgeCtx({ backendUrl = '', apiKey = 'k-test', withDeps = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'muche-startup-'))
  const config = { backendUrl, apiKey, workspacePath: tmp, bridgeId: tmp }
  const sessionEvents = []
  const disposeFns = []
  const ctx = {
    on: (ev, fn) => {
      if (ev === 'dispose') disposeFns.push(fn)
      return () => {}
    },
    get: (name) => ctx[name],
    _config: config,
    _dispose: disposeFns,
  }
  if (withDeps) {
    ctx.workspaceRegistry = {
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'ws-1' }),
    }
    ctx.sessionController = {
      create: async () => ({ sessionId: 'sess-1' }),
      prompt: async () => {
        setImmediate(() => {
          for (const fn of [...sessionEvents]) {
            fn({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          }
        })
      },
    }
    ctx.on = ((orig) => (ev, fn) => {
      if (ev === 'session/event') {
        sessionEvents.push(fn)
        return () => {
          const i = sessionEvents.indexOf(fn)
          if (i >= 0) sessionEvents.splice(i, 1)
        }
      }
      return orig(ev, fn)
    })(ctx.on)
  }
  return ctx
}

async function startFakeBackend() {
  const conns = []
  const wss = new WebSocketServer({ port: 0 })
  await new Promise((resolve) => wss.on('listening', resolve))
  wss.on('connection', (sock, req) => {
    conns.push({ sock, url: req.url || '' })
    sock.send(JSON.stringify({ type: 'hello' }))
    // 真实后端行为：收到 dsh_hello 即回登记确认。
    sock.on('message', (raw) => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (frame?.type === 'dsh_hello') {
        sock.send(JSON.stringify({ type: 'dsh_hello_ack', ok: true, host_id: frame.host_id, protocol: frame.protocol }))
      }
    })
  })
  return {
    url: `http://127.0.0.1:${wss.address().port}`,
    conns,
    waitConn(ms = 5000) {
      if (conns.length) return Promise.resolve(conns[conns.length - 1])
      return new Promise((resolve, reject) => {
        const connected = () => { clearTimeout(timeout); resolve(conns[conns.length - 1]) }
        const timeout = setTimeout(() => { wss.off('connection', connected); reject(new Error('桥接未上线')) }, ms)
        wss.once('connection', connected)
      })
    },
    async close() { await new Promise((resolve) => wss.close(resolve)) },
  }
}

async function shutdownBridge(ctx, backend) {
  for (const fn of ctx._dispose) { try { await fn() } catch { /* 忽略 */ } }
  if (backend) {
    for (const c of backend.conns) { try { c.sock.close() } catch { /* 忽略 */ } }
    await backend.close()
  }
}

test('guard：撞重复吞掉记降级；非撞车原样抛', () => {
  const g = createRegistrationGuard()
  assert.equal(g.degraded, false)
  assert.equal(g.run(() => {}), true)
  assert.equal(g.degraded, false)
  assert.equal(g.run(() => { throw new Error('webserver: duplicate exact route "/x"') }), false)
  assert.equal(g.degraded, true)
  assert.throws(() => g.run(() => { throw new Error('钢丝上的真错误') }), /钢丝上的真错误/)
})

test('双 apply：第二份不抛、degraded=true、首份路由保留', () => {
  const table = sharedWebServer()
  const config = { backendUrl: '', apiKey: '', workspacePath: '' }
  const mk = () => ({
    connection: { requestRejection: () => undefined },
    webServer: table,
    get: () => undefined,
    on: () => () => {},
  })
  const g1 = createRegistrationGuard()
  assert.equal(registerRoutes(mk(), config, g1), false)
  const before = table.routes.size
  assert.ok(before >= 4, `首份应注册 chat/image/history/health，共 ${before} 条`)
  const g2 = createRegistrationGuard()
  assert.equal(registerRoutes(mk(), config, g2), true)
  assert.equal(table.routes.size, before)
})

test('index 接线：副纤程跳过桥接，主纤程唯一执行', () => {
  assert.ok(/guard\.degraded/.test(INDEX_SRC), 'index 未凭 guard.degraded 分流主副纤程')
  assert.ok(/registerDshBridge\(ctx, config(?:,|\))/.test(INDEX_SRC), 'index 未注册桥接')
  assert.ok(INDEX_SRC.indexOf('guard.degraded') < INDEX_SRC.indexOf('registerDshBridge(ctx, config'),
    '桥接注册应在降级判断之后')
})

test('/api/muche/health：含 configNs＋桥 fibers 数组形状（旧 /status 已删）', async () => {
  const { ctx, handlers, config } = routeCtx()
  registerRoutes(ctx, config)
  const handler = handlers['/api/muche/health']
  assert.ok(handler, '缺少 /api/muche/health 路由')
  assert.ok(!handlers['/api/muche/status'], '旧 /api/muche/status 未删')
  assert.ok(!handlers['/api/muche/test'], '旧 /api/muche/test 未删')
  assert.ok(!handlers['/api/muche/ws-diag'], '旧 /api/muche/ws-diag 未删')
  let code = 0
  let payload = ''
  await handler({ method: 'GET', url: '/' }, {
    writeHead: (c) => { code = c },
    end: (s) => { payload = String(s) },
  })
  assert.equal(code, 200)
  const body = JSON.parse(payload)
  assert.equal(body.ok, true)
  assert.equal(typeof body.configNs, 'string')
  assert.ok(Array.isArray(body.status.fibers), 'health.status.fibers 不是数组')
})

test('缺依赖启动保持 starting 静默；补依赖+全局诊断 refresh 即上线', async () => {
  const backend = await startFakeBackend()
  const ctx = bridgeCtx({ backendUrl: backend.url, withDeps: false })
  let timeout
  try {
    let ready
    const readiness = new Promise((resolve) => { ready = resolve })
    const bridge = registerDshBridge(ctx, ctx._config, {
      dependencyRetryDelays: [10, 20],
      onState: (state) => { if (state.phase === 'ready') ready() },
    })
    assert.equal(backend.conns.length, 0)
    const initial = bridge.getState()
    assert.equal(initial.phase, 'starting')
    assert.equal(initial.startupComplete, false)
    assert.equal(initial.reason, '')
    assert.equal(initial.deps.sessionController, false)
    ctx.workspaceRegistry = {
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'ws-1' }),
    }
    ctx.sessionController = { create: async () => ({ sessionId: 's' }), prompt: async () => {} }
    await requestDshBridgeRefresh()
    const conn = await backend.waitConn()
    assert.match(conn.url, /channel=dsh-bridge/)
    await Promise.race([readiness, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('未收到真实 hello')), 2000) })])
    assert.equal(bridge.getState().phase, 'ready')
    assert.equal(bridge.getState().startupComplete, true)
    assert.ok(getDshBridgeStatus().fibers.some((fiber) => fiber.phase === 'ready'))
  } finally {
    clearTimeout(timeout)
    await shutdownBridge(ctx, backend)
  }
})

test('缺依赖且永不补：有界等待耗尽才 fault，dispose 干净无残留', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = bridgeCtx({ backendUrl: 'http://example.test/api', apiKey: 'test-nodeps', withDeps: false })
  const bridge = registerDshBridge(ctx, ctx._config, { dependencyRetryDelays: [5, 10, 20] })
  assert.equal(bridge.getState().phase, 'starting')
  for (const delay of [5, 10, 20]) t.mock.timers.tick(delay)
  assert.equal(bridge.getState().phase, 'fault')
  assert.equal(bridge.getState().startupComplete, true)
  assert.equal(bridge.getState().code, BRIDGE_DEPENDENCIES)
  const count = getDshBridgeStatus().fibers.length
  await shutdownBridge(ctx)
  assert.equal(getDshBridgeStatus().fibers.length, count - 1)
  t.mock.timers.tick(60000)
  assert.equal(bridge.getState().phase, 'stopped')
})

test('卸载清理：live-remove 后路由释放，重装不再撞车', () => {
  // 复现 2026-09-23 桌面端开关事故：关（dispose）不清路由 → 开（重 apply）必撞。
  // 官方契约：register 返回 disposer；桌面端官方写法 ctx.effect(() => register(...))。
  const table = sharedWebServer()
  const cleanups = []
  const config = { backendUrl: '', apiKey: '', workspacePath: '' }
  const mk = () => ({
    connection: { requestRejection: () => undefined },
    webServer: table,
    get: () => undefined,
    effect: (setup) => {
      const dispose = setup()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
  })
  assert.equal(registerRoutes(mk(), config), false)
  assert.equal(registerPanelEvents(mk(), config), false)
  const used = table.routes.size
  assert.ok(used >= 5, `路由（含 events）应注册，实际 ${used} 条`)
  // 模拟卸载：纤程 dispose 跑 effect 清理。
  for (const dispose of cleanups.splice(0)) dispose()
  assert.equal(table.routes.size, 0)
  // 重装：同一张表全新 apply，不抛且非降级（主纤程）。
  assert.equal(registerRoutes(mk(), config), false)
  assert.equal(registerPanelEvents(mk(), config), false)
  assert.equal(table.routes.size, used)
})
