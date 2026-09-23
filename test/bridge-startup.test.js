/**
 * bridge-startup.test.js — 0.4.3 启动根治回归（2026-09-23 桌面端事故）。
 *
 * 根因两条（同进程内）：
 * ① 双挂载（bundles #muche + 市场 #mkt-muche）第二份 apply 撞
 *    `duplicate exact route` 直接抛 → 后继 registerDshBridge 永不执行 →
 *    面板走孤儿路由、桥不存在。治本：撞车降级（副纤程跳过桥接），
 *    主纤程唯一执行，非撞车错误照常抛。
 * ② 依赖检查在 apply 时刻一判终身：宿主行异步挂载，桌面端启动顺序竞态
 *    致静默丢桥（仅 console.warn 到虚空）。治本：检查推迟到每次 refresh，
 *    缺失时有界自愈（5s/15s/30s，unref），状态经 getDshBridgeStatus 可见。
 *
 * 覆盖：
 *  - guard：撞重复吞掉记降级；非撞车原样抛；成功 true；
 *  - 双 apply：第二份不抛、degraded=true、首份路由保留、升级入口同样；
 *  - /api/muche/status：返回 fibers 数组形状；
 *  - 缺依赖启动：不起连接、状态 disabled 含缺失项；补依赖 + refresh 即上线；
 *  - 缺依赖且永不补：有界重试不 hanging（unref），dispose 干净。
 *
 * 用本地 WebSocketServer 做后端，全程无真实 dsh。
 * 启停顺序：先停客户端（dispose）再关 server，反之互相等死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { createRegistrationGuard } from '../lib/register-guard.js'
import { registerRoutes } from '../lib/routes.js'
import { registerWsProxy } from '../lib/ws-proxy.js'
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
  const stored = { backendUrl: 'http://127.0.0.1:8000', apiKey: 'k-route' }
  return {
    ctx: {
      settings: { get: () => stored, update: async () => {} },
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
      ...overrides,
    },
    handlers,
    stored,
  }
}

function bridgeCtx({ backendUrl = '', apiKey = 'k-test', withDeps = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'muche-startup-'))
  const settings = { muche: { backendUrl, apiKey, workspacePath: tmp } }
  const sessionEvents = []
  const disposeFns = []
  const ctx = {
    settings: {
      register() {},
      get: (ns) => settings[ns],
      update: async (ns, patch) => Object.assign(settings[ns], patch),
    },
    on: (ev, fn) => {
      if (ev === 'dispose') disposeFns.push(fn)
      return () => {}
    },
    get: (name) => ctx[name],
    _settings: settings,
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
  wss.on('connection', (sock, req) => conns.push({ sock, url: req.url || '' }))
  return {
    url: `http://127.0.0.1:${wss.address().port}`,
    conns,
    waitConn(ms = 5000) {
      if (conns.length) return Promise.resolve(conns[conns.length - 1])
      return new Promise((resolve, reject) => {
        const iv = setInterval(() => {
          if (conns.length) { clearInterval(iv); resolve(conns[conns.length - 1]) }
        }, 20)
        setTimeout(() => { clearInterval(iv); reject(new Error('桥接未上线')) }, ms)
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
  const mk = () => ({
    settings: { get: () => ({ backendUrl: '', apiKey: '' }), update: async () => {} },
    connection: { requestRejection: () => undefined },
    webServer: table,
    get: () => undefined,
    on: () => () => {},
  })
  const g1 = createRegistrationGuard()
  assert.equal(registerRoutes(mk(), g1), false)
  const before = table.routes.size
  assert.ok(before >= 6, `首份应注册 chat/image/history/config/test/status，共 ${before} 条`)
  const g2 = createRegistrationGuard()
  assert.equal(registerRoutes(mk(), g2), true)
  assert.equal(table.routes.size, before)
})

test('index 接线：副纤程跳过桥接，主纤程唯一执行', () => {
  assert.ok(/guard\.degraded/.test(INDEX_SRC), 'index 未凭 guard.degraded 分流主副纤程')
  assert.ok(/registerDshBridge\(ctx\)/.test(INDEX_SRC), 'index 未注册桥接')
  assert.ok(INDEX_SRC.indexOf('guard.degraded') < INDEX_SRC.indexOf('registerDshBridge(ctx)'),
    '桥接注册应在降级判断之后')
})

test('/api/muche/status：返回 fibers 数组形状', async () => {
  const { ctx, handlers } = routeCtx()
  registerRoutes(ctx)
  const handler = handlers['/api/muche/status']
  assert.ok(handler, '缺少 /api/muche/status 路由')
  let code = 0
  let payload = ''
  await handler({ method: 'GET', url: '/' }, {
    writeHead: (c) => { code = c },
    end: (s) => { payload = String(s) },
  })
  assert.equal(code, 200)
  const body = JSON.parse(payload)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.status.fibers), 'status.fibers 不是数组')
})

test('缺依赖启动：不起连接、状态 disabled 含缺失项；补依赖+refresh 即上线', async () => {
  const backend = await startFakeBackend()
  const ctx = bridgeCtx({ backendUrl: backend.url, withDeps: false })
  try {
    registerDshBridge(ctx)
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(backend.conns.length, 0)
    let st = getDshBridgeStatus()
    let mine = st.fibers[st.fibers.length - 1]
    assert.equal(mine.mode, 'disabled')
    assert.match(mine.reason, /sessionController/)
    // 宿主行随后挂载（桌面端异步挂载窗口）：补上 + 重存配置即自愈。
    ctx.workspaceRegistry = {
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'ws-1' }),
    }
    ctx.sessionController = { create: async () => ({ sessionId: 's' }), prompt: async () => {} }
    await requestDshBridgeRefresh()
    const conn = await backend.waitConn()
    assert.match(conn.url, /channel=dsh-bridge/)
    st = getDshBridgeStatus()
    mine = st.fibers[st.fibers.length - 1]
    assert.equal(mine.mode, 'active')
  } finally {
    await shutdownBridge(ctx, backend)
  }
})

test('缺依赖且永不补：有界重试后安静，dispose 干净无残留', async () => {
  const backend = await startFakeBackend()
  const ctx = bridgeCtx({ backendUrl: backend.url, apiKey: 'k-nodeps', withDeps: false })
  registerDshBridge(ctx)
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(backend.conns.length, 0)
  const mine = getDshBridgeStatus().fibers.length
  await shutdownBridge(ctx, backend)
  assert.equal(getDshBridgeStatus().fibers.length, mine - 1)
})

test('卸载清理：live-remove 后路由/升级入口释放，重装不再撞车', () => {
  // 复现 2026-09-23 桌面端开关事故：关（dispose）不清路由 → 开（重 apply）必撞。
  // 官方契约：register 返回 disposer；桌面端官方写法 ctx.effect(() => register(...))。
  const table = sharedWebServer()
  const cleanups = []
  const mk = () => ({
    settings: { get: () => ({ backendUrl: '', apiKey: '' }), update: async () => {} },
    connection: { requestRejection: () => undefined },
    webServer: table,
    get: () => undefined,
    effect: (setup) => {
      const dispose = setup()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
  })
  assert.equal(registerRoutes(mk()), false)
  assert.equal(registerWsProxy(mk()), false)
  const used = table.routes.size
  assert.ok(used >= 7, `路由+升级入口应注册，实际 ${used} 条`)
  // 模拟卸载：纤程 dispose 跑 effect 清理。
  for (const dispose of cleanups.splice(0)) dispose()
  assert.equal(table.routes.size, 0)
  // 重装：同一张表全新 apply，不抛且非降级（主纤程）。
  assert.equal(registerRoutes(mk()), false)
  assert.equal(registerWsProxy(mk()), false)
  assert.equal(table.routes.size, used)
})
