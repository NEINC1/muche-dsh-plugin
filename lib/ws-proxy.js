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

/**
 * 后端升级链路探针（排障口，不搭载业务流量）。
 *
 * 背景（实时通道排障口）：面板 WS 失败时浏览器只给不透明的
 * "WebSocket 错误"，真正的原因（Cookie 门/缺 token/后端地址错/后端拒绝/
 * 建连失败）只落在用户本机 dsh 日志里，用户找不到。探针把“Host→后端”
 * 这一跳的逐段结果变成面板可读的 JSON，一次定位。
 *
 * 实现（不造第二套到达逻辑）：复用 backendUpgradeTarget 构造目标（与代理
 * 同一函数、同一配置源），用固定哑 token 发一次 upgrade——后端鉴权必回
 * 非 101（哑 token 无效，预期 403），读到状态行即证明 DNS→TCP→TLS→HTTP
 * 全段可达，随即销毁 socket。哑 token 进不了鉴权，不占面板/桥接额度，
 * 不建连接、不订阅广播；token/key 永不进日志与回包。
 *
 * 返回（JSON-safe）：{ ok, stage, status?, error?, backend:{protocol,host,port,pathPrefix} }
 *   stage: 'backend-reached'（ok=true，status 为后端回的状态行，403=预期）|
 *          'target'（地址配错，连发都没发）| 'dns' | 'tcp' | 'tls' |
 *          'timeout' | 'upgraded-unexpectedly'（哑 token 竟被接受，须报修）。
 */
export function probeBackendUpgrade(backendUrl, { timeoutMs = 8000 } = {}) {
  let target
  try {
    // 哑 token：只求后端回状态行，不求接受。
    target = backendUpgradeTarget(backendUrl, '__muche_ws_diag_probe__')
  } catch (error) {
    return Promise.resolve({
      ok: false,
      stage: 'target',
      error: String((error && error.message) || error).slice(0, 200),
      backend: describeTarget(backendUrl),
    })
  }
  const backend = {
    protocol: target.secure ? 'https' : 'http',
    host: target.host,
    port: target.port,
    // 回包只带路径前缀形态（有没有 /api），不带 token。
    pathPrefix: target.path.split('/ws')[0] || '(根)',
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      resolve({ ...result, backend })
    }
    const transport = target.secure ? https : http
    let upReq
    try {
      upReq = transport.request({
        host: target.host,
        port: target.port,
        path: target.path,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
        timeout: timeoutMs,
      })
    } catch (error) {
      finish({ ok: false, stage: 'target', error: String((error && error.message) || error).slice(0, 200) })
      return
    }
    upReq.on('upgrade', (upRes, upSocket) => {
      try { upSocket.destroy() } catch { /* 已关 */ }
      finish({ ok: false, stage: 'upgraded-unexpectedly', error: '哑 token 被后端接受，请报修' })
    })
    upReq.on('response', (res) => {
      // 后端拒绝（哑 token 预期 403）：读掉 body 即断，状态行就是结论。
      try { res.resume() } catch { /* 忽略 */ }
      finish({ ok: true, stage: 'backend-reached', status: res.statusCode })
    })
    upReq.on('timeout', () => {
      try { upReq.destroy() } catch { /* 已关 */ }
      finish({ ok: false, stage: 'timeout', error: `${timeoutMs}ms 内后端无应答` })
    })
    upReq.on('error', (error) => {
      finish({ ok: false, stage: classifyNetError(error), error: String((error && error.message) || error).slice(0, 200) })
    })
    upReq.end()
  })
}

/** 目标描述（失败早回包用；只做形态解析，不抛）。 */
function describeTarget(backendUrl) {
  try {
    const bu = new URL(String(backendUrl || DEFAULT_BACKEND).replace(/\/+$/, ''))
    return {
      protocol: bu.protocol === 'https:' ? 'https' : 'http',
      host: bu.hostname || '(空)',
      port: bu.port || (bu.protocol === 'https:' ? 443 : 80),
      pathPrefix: (bu.pathname || '').replace(/\/+$/, '') || '(根)',
    }
  } catch {
    return { protocol: '?', host: String(backendUrl || '').slice(0, 80) || '(空)', port: '?', pathPrefix: '?' }
  }
}

/** 建连错误归段：只看 code，不碰正文。 */
function classifyNetError(error) {
  const code = String((error && error.code) || '')
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns'
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED/.test(code)) return 'tls'
  return 'tcp'
}

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
