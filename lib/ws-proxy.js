/**
 * WS 同源代理——浏览器只连同源，Host 进程内代理到后端。
 *
 * 背景：面板 wsStore 原以配置的 backendUrl（如 http://127.0.0.1:8000）构造
 * WS 地址，浏览器直连。用户经隧道访问 dsh 时，127.0.0.1 在浏览器里是
 * 用户电脑——连接失败（"WebSocket 错误"，服务器日志永远无记录）。
 *
 * 治本：浏览器只连**同源** `ws(s)://<页面主机>/api/muche/ws?token=...`
 * （经隧道到达本 dsh），本路由把升级请求代理到后端 ` [<backendUrl 的 path>/]ws?token=...`
 * （Host 进程在服务器上，127.0.0.1:8000 可达）。backendUrl 的 path 必须原样保留：
 * 远端经 nginx 反代时地址形如 `http://<公网>/api`（/api 由 nginx 剥掉），丢掉它就会
 * 打到 SPA 首页而永远握手失败（裸路径落到 SPA，带前缀的路径才到达后端）。HTTP 聊天走同源代理（/api/muche/*），WS 与其同构——
 * 零跨机地址。
 *
 * 实现：原生 node:http(s) 双向管道（零新依赖）：
 *   浏览器握手 → 本路由代算 Sec-WebSocket-Accept 回 101
 *   同时 http.request 向后端发起 upgrade → 后端 101 后两 socket pipe
 *   两端附加缓冲（head）互喂
 *
 * 鉴权（公网化后）：先过 dsh Cookie 门（requestRejection），再由后端以 token
 * 鉴权。面板经同源连本路由，带 Cookie；无 Cookie 的公网 upgrade 直接断开。
 */
import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

import { readConfig, DEFAULT_BACKEND } from './config.js'

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function acceptKey(key) {
  return createHash('sha1').update((key || '') + WS_MAGIC).digest('base64')
}

/** 双向管道:任一端错误/关闭即拆另一端;升级缓冲按来源先互喂。 */
export function pipeBoth(a, b, headToB, headToA) {
  const kill = (victim) => { try { victim.destroy() } catch { /* 已关 */ } }
  a.on('error', () => kill(b))
  b.on('error', () => kill(a))
  a.on('close', () => kill(b))
  b.on('close', () => kill(a))
  if (headToB && headToB.length) b.write(headToB)
  if (headToA && headToA.length) a.write(headToA)
  a.pipe(b)
  b.pipe(a)
}

/**
 * 由配置的 backendUrl 构造到后端的 upgrade 目标（纯函数，单测守卫）。
 *
 * backendUrl 可能是同机直连（`http://127.0.0.1:8000`）或经 nginx 反代的公网地址
 * （`http://<公网>/api`，`/api` 由 nginx 剥掉再透传）。pathname 必须原样保留并拼在
 * `/ws` 之前，否则远端 WS 落到 SPA 首页而永远握手失败；https 地址必须走 https
 * 模块（node:http 发明文到 443 必失败）。无效地址抛错，由调用方收口。
 */
export function backendUpgradeTarget(backendUrl, token) {
  const backend = String(backendUrl || DEFAULT_BACKEND).replace(/\/+$/, '')
  const bu = new URL(backend)
  const basePath = bu.pathname.replace(/\/+$/, '')
  const secure = bu.protocol === 'https:'
  return {
    secure,
    host: bu.hostname,
    port: bu.port || (secure ? 443 : 80),
    path: `${basePath}/ws?token=${encodeURIComponent(token)}`,
  }
}

import { createRegistrationGuard } from './register-guard.js'

export function registerWsProxy(ctx, config, guard) {
  // 与 registerRoutes 同一守卫：双挂载时升级入口撞重复同样降级不抛。
  // 卸载清理同理：registerUpgrade 同样返回 disposer，必须绑纤程，
  // 否则 live-remove 后升级入口泄漏。
  const g = guard || createRegistrationGuard()
  const disposes = []
  const cleanup = () => {
    while (disposes.length > 0) {
      const dispose = disposes.pop()
      try {
        dispose()
      } catch { /* 已卸载/重复清理，直接忽略 */ }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)
  g.run(() => {
    const dispose = ctx.webServer.registerUpgrade({
    path: '/api/muche/ws',
    handler: (req, socket, head) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { socket.destroy(); return }
      let url
      try { url = new URL(req.url || '/', 'http://localhost') } catch { socket.destroy(); return }
      const token = url.searchParams.get('token') || ''
      if (!token) {
        console.error('muche ws-proxy: 缺少 token')
        socket.destroy()
        return
      }
      const cfg = readConfig(config)
      let target
      try {
        target = backendUpgradeTarget(cfg.backendUrl, token)
      } catch {
        console.error('muche ws-proxy: 后端地址无效', String(cfg.backendUrl || DEFAULT_BACKEND))
        socket.destroy()
        return
      }
      // 后端 upgrade(校验 head 里的子协议等保持原样透传最小集)
      const transport = target.secure ? https : http
      const upReq = transport.request({
        host: target.host,
        port: target.port,
        path: target.path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': req.headers['sec-websocket-key'] || '',
          'Sec-WebSocket-Version': req.headers['sec-websocket-version'] || '13',
        },
      })
      upReq.on('upgrade', (upRes, upSocket, upHead) => {
        // 后端接受:向浏览器回 101(代算 accept)
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' + acceptKey(req.headers['sec-websocket-key']) + '\r\n\r\n',
        )
        // Node upgrade 的 head 属于浏览器→后端方向；upHead 属于后端→浏览器。
        // 方向写反会把一端的首个 WebSocket frame 注入另一端，后端随后报
        // incorrect masking，表现为握手成功但第一条消息永远收不到。
        pipeBoth(socket, upSocket, head, upHead)
      })
      upReq.on('response', (res) => {
        // 后端拒绝(如 403 close 1008):读掉 body 后断开浏览器
        console.error('muche ws-proxy: 后端拒绝 upgrade status=%s', res.statusCode)
        res.resume()
        socket.destroy()
      })
      upReq.on('error', (err) => {
        console.error('muche ws-proxy: 后端连接失败', String(err && err.message ? err.message : err))
        socket.destroy()
      })
      upReq.end()
    },
  })
    if (typeof dispose === 'function') disposes.push(dispose)
  })
  return g.degraded
}
