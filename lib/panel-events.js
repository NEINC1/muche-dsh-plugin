/**
 * 面板事件下行（SSE 替代通道）Owner。
 *
 * 根因：桌面端把插件 UI 搬到 `dsh-app://` 自定义协议后，浏览器原生
 * WebSocket 结构上不可用（`ws://app/...` 无 DNS，跨源还会被官方
 * Host/Origin 门拦），而同源相对地址 fetch 走 Electron 协议拦截正常。
 * 治本：Host 侧替浏览器持有真正的后端 WS（面板池，与直连同额度语义），
 * 浏览器侧经同源 SSE 收下行；上行走既有 HTTP 降级通道（已实现，不动）。
 *
 * 真源：本模块 hub（上游单例＋订阅者集合）， per 进程一份。
 * 公开 interface：createPanelEventsHub（纯逻辑，可注 fake 上游）、
 *   registerPanelEvents(ctx, config, guard)（路由装配）。
 * 状态与转换：idle → active（首个订阅者建上游）→ idle（末位退订拆上游，
 *   额度即时释放）；配置指纹变化重建上游；均为显式幂等转换。
 * 策略归属：上游 25s 自 ping 用 BackendWs 内建；SSE 25s 注释心跳；上游
 *   只收不发（user_message 走 HTTP，本模块禁发业务帧）。
 * 消费者：GET /api/muche/events 浏览器订阅者（非 http(s) 页）；排障经
 *   /api/muche/health（上游段，ws 段）＋面板自诊断。
 * 失败降级：上游断开 → BackendWs 指数退避重连，订阅者无感（不断 SSE）；
 *   订阅者断开 → 引用计数减，末位拆上游。
 * 租户/CAS/幂等：只读配置（每次现读）；无持久状态；订阅/退订幂等。
 * 测试入口：dsh/test/panel-events.test.js。
 */
import { BackendWs } from './backend_ws.js'
import { ChannelConnection } from './connections.js'
import { readConfig } from './config.js'
import { createRegistrationGuard } from './register-guard.js'

const SSE_HEARTBEAT_MS = 25000

/** 上游帧转 SSE 行（pong 不下行，其余原样；未知类型由客户端忽略）。 */
function toSseLine(frame) {
  return `data: ${JSON.stringify(frame)}\n\n`
}

export function createPanelEventsHub({ createUpstream } = {}) {
  const newUpstream = createUpstream || ((opts) => new BackendWs(opts))
  // 上游生命周期归 ChannelConnection（0.6.0 WP3a）：指纹换连语义与旧 ensureUpstream
  // 一致（无 key 不建、同纹复用、变纹重建），订阅扇出与心跳仍归 hub。
  const channel = new ChannelConnection({ channel: '', createTransport: newUpstream })
  const subs = new Set()
  let upstreamKey = '' // 排障指纹（换连判定在 ChannelConnection，不做第二套比对）
  let heartbeatTimer = null

  function broadcast(frame) {
    if (subs.size === 0) return
    const line = toSseLine(frame)
    for (const res of [...subs]) {
      try {
        res.write(line)
      } catch {
        subs.delete(res)
      }
    }
    if (subs.size === 0) tearDown()
  }

  function startHeartbeat() {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(() => {
      for (const res of [...subs]) {
        try {
          res.write(':hb\n\n')
        } catch {
          subs.delete(res)
        }
      }
      if (subs.size === 0) tearDown()
    }, SSE_HEARTBEAT_MS)
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  }

  function tearDown() {
    stopHeartbeat()
    channel.stop()
    upstreamKey = ''
  }

  function ensureUpstream(cfg) {
    const up = channel.sync({
      backendUrl: cfg.backendUrl,
      apiKey: cfg.apiKey,
      handlers: {
        onReply: (frame) => broadcast(frame),
        onProactive: (frame) => broadcast(frame),
        onError: (frame) => broadcast(frame),
        onStatus: () => { /* 状态经 statusOf 按需读，不推 */ },
      },
    })
    // 面板池断言（测试锁死）：channel 空串由 ChannelConnection 构造时固定，
    // 此处只记指纹供排障，不做第二套比对。
    if (up) upstreamKey = `${cfg.backendUrl}|${cfg.apiKey}`
    return up
  }

  return {
    get subscriberCount() { return subs.size },
    get hasUpstream() { return channel.hasTransport },
    statusOf() {
      return {
        subscribers: subs.size,
        upstreamKeyed: channel.hasTransport,
        upstream: channel.hasTransport ? channel.getState() : null,
      }
    },
    subscribe(res, cfg) {
      const up = ensureUpstream(cfg)
      if (!up) return false
      subs.add(res)
      startHeartbeat()
      try {
        res.write(toSseLine({ type: 'hello', via: 'sse' }))
      } catch {
        subs.delete(res)
        if (subs.size === 0) tearDown()
        return true
      }
      res.on('close', () => {
        subs.delete(res)
        if (subs.size === 0) tearDown()
      })
      return true
    },
    dispose() {
      for (const res of [...subs]) {
        try {
          res.end()
        } catch { /* 已关 */ }
      }
      subs.clear()
      tearDown()
    },
  }
}

export function registerPanelEvents(ctx, config, guard) {
  // 与 registerRoutes/registerWsProxy 同一守卫语义：双挂载撞重复降级不抛。
  const g = guard || createRegistrationGuard()
  const hub = createPanelEventsHub()
  const disposes = []
  const cleanup = () => {
    while (disposes.length > 0) {
      const dispose = disposes.pop()
      try {
        dispose()
      } catch { /* 已卸载/重复清理，直接忽略 */ }
    }
    hub.dispose()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)
  g.run(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/api/muche/events',
      handler: (req, res) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '仅支持 GET' }))
          return
        }
        const cfg = readConfig(config)
        if (!cfg.apiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '还没配 API key' }))
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        hub.subscribe(res, cfg)
      },
    })
    if (typeof dispose === 'function') disposes.push(dispose)
  })
  return g.degraded
}
