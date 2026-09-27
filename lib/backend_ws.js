/**
 * 小沐后端 WS Owner（Host 侧到后端 WS 的一切：出站长连接＋上游面板连接＋
 * 单发探针＋目标构造。OI-078 收口：`backendUpgradeTarget` 与本模块私有的
 * `#wsUrl` 同语义两遍实现，收口为唯一导出 `buildBackendWsUrl`。）。
 *
 * 与浏览器面板同契约（ws.py）：上行 user_message/tool_result/ping；
 * 下行 reply/proactive/error。25s ping / 60s 服务端断开 / 指数退避重连（≤30s）。
 *
 * **断线缓冲（第二轮审计 N1 · P0）**：WS 未连接时 user_message 帧进内存缓冲
 * （上限 20 条 / 10 分钟），重连后按序补发；**缓冲未排空前新帧追加缓冲尾
 * （整体 FIFO，第三轮 G3）**；缓冲随游标落盘（G5：dsh 崩溃不丢，重启先补发）。
 *
 * 依赖：dsh 依赖树 ws 库（总则⑦，与 webServer 同源）。
 */
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import WebSocket from 'ws'

const PING_INTERVAL_MS = 25000
const RECONNECT_MAX_MS = 30000
const BUFFER_MAX = 20
const BUFFER_TTL_MS = 10 * 60 * 1000

/**
 * 到后端的 upgrade 目标（纯函数，唯一真源，单测守卫）。
 *
 * backendUrl 唯一形态 `<公网基址>/api`（全员远端；`/api` 由 nginx 剥掉
 * 再透传）。pathname 必须原样保留并拼在 `/ws` 之前，否则 WS 落到 SPA
 * 首页而永远握手失败；https 地址必须走 https 模块（node:http 发明文到
 * 443 必失败）。空地址抛错（未配置显式化，调用方收口）；无效地址抛错，
 * 由调用方收口。
 *
 * @param {string} backendUrl 后端基址（必填，非空）。
 * @param {string} token 凭据（探针传哑 token，只求状态行）。
 * @param {string} [channel] 通道名（空/缺省＝面板池，后端按无 channel 判面板）。
 */
export function buildBackendWsUrl(backendUrl, token, channel = '') {
  const base = String(backendUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('未配后端地址')
  const bu = new URL(base)
  const basePath = bu.pathname.replace(/\/+$/, '')
  const secure = bu.protocol === 'https:'
  // 面板池无 channel 参数（与直连同额度语义，不挤占桥接池）。
  const query = `token=${encodeURIComponent(token)}` + (channel ? `&channel=${encodeURIComponent(channel)}` : '')
  const wsBase = (secure ? 'wss' : 'ws') + '://' + bu.host
  return {
    secure,
    host: bu.hostname,
    port: bu.port || (secure ? 443 : 80),
    path: `${basePath}/ws?${query}`,
    url: `${wsBase}${basePath}/ws?${query}`,
  }
}

/**
 * 后端升级链路探针（排障口，不搭载业务流量）。
 *
 * 面板 WS/SSE 失败时浏览器侧是不透明错误，真正原因只落本机 dsh 日志。
 * 探针用同一目标构造发一次哑-token upgrade，把"Host→后端"逐段结果变成
 * 面板可读的 JSON，一次定位。哑 token 进不了鉴权（预期 403），不占面板/
 * 桥接额度，不建连接；token/key 永不进日志与回包。
 *
 * 返回（JSON-safe）：{ ok, stage, status?, error?, backend:{protocol,host,port,pathPrefix} }
 *   stage: 'backend-reached'（ok=true，status 为后端回的状态行，403=预期）|
 *          'target'（地址配错/未配，连发都没发）| 'dns' | 'tcp' | 'tls' |
 *          'timeout' | 'upgraded-unexpectedly'（哑 token 竟被接受，须报修）。
 */
export function probeBackendUpgrade(backendUrl, { timeoutMs = 8000 } = {}) {
  let target
  try {
    // 哑 token：只求后端回状态行，不求接受。
    target = buildBackendWsUrl(backendUrl, '__muche_ws_diag_probe__')
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
    const bu = new URL(String(backendUrl || '').replace(/\/+$/, ''))
    if (!bu.hostname) throw new Error('空地址')
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

export class BackendWs {
  /**
   * @param {object} opts
   * @param {string} opts.backendUrl
   * @param {string} opts.apiKey
   * @param {string} [opts.channel]
   *   后端通道名：dsh 反向桥接传 `dsh-bridge`；显式空串＝面板池（面板下行复用）。
   *   通道决定后端侧的连接池与额度归属，ping/重连/缓冲语义两者一致。
   * @param {(frame: object) => void} opts.onReply
   * @param {(frame: object) => void} opts.onProactive
   * @param {(frame: object) => void} opts.onError
   * @param {(frame: object) => void} [opts.onTask]
   *   桥接任务回调（仅 `dsh-bridge` 通道）：收到 `dsh_task` 帧时调用，
   *   由调用方执行并经 `sendFrame` 回传 `dsh_result`。
   * @param {(frame: object) => void} [opts.onAppend]
   *   追单回调（仅 `dsh-bridge` 通道）：收到 `dsh_append` 帧时调用，
   *   向同一会话 steer 追消息，最终只出一个结果（不另起 waiter）。
   * @param {(frame: object) => void} [opts.onDecide]
   *   决议回调（仅 `dsh-bridge` 通道）：收到 `dsh_decide` 帧时调用，
   *   按 interactive_id 终结一次在途交互等待（批准/问答二选一）。
   * @param {(patch: object) => void} opts.onStatus
   * @param {() => Array} opts.readBuffer     启动时读持久化缓冲（settings）
   * @param {(frames: Array) => Promise<void>} opts.persistBuffer  缓冲落盘
   */
  constructor(opts = {}) {
    this.backendUrl = String(opts.backendUrl || '').replace(/\/+$/, '')
    this.apiKey = opts.apiKey || ''
    // channel 传显式空串＝面板池（面板下行复用）；undefined/缺省＝dsh-bridge。
    this.channel = opts.channel === undefined ? 'dsh-bridge' : String(opts.channel || '')
    this.onReply = opts.onReply
    this.onProactive = opts.onProactive
    this.onError = opts.onError
    this.onTask = opts.onTask
    this.onAppend = opts.onAppend
    this.onDecide = opts.onDecide
    this.onStatus = opts.onStatus
    this.readBuffer = opts.readBuffer
    this.persistBuffer = opts.persistBuffer
    this.sock = null
    this.pingTimer = null
    this.reconnectTimer = null
    this.attempts = 0
    this.status = 'idle' // idle | connecting | open | closed
    this.lastError = ''
    this.buffer = [] // [{ messageId, message, ts }]
    this.disposed = false // 进程退出终态（只由 dispose 置起，拦截一切重连）
    this.stopped = true // 用户态停止（stop 置起：迟到事件不自复活；start 清掉）
    this.flushChain = Promise.resolve()
  }

  getState() {
    return {
      status: this.status,
      lastError: this.lastError,
      buffered: this.buffer.length,
      // 最老缓冲条目的时间戳（状态聚合判断积压用；无缓冲为 0）。
      oldestTs: this.buffer.length > 0 ? this.buffer[0].ts : 0,
    }
  }

  start() {
    // 可重启语义（OI-025）：临时停后再次 start 必须能拉起；只有 dispose
    // （进程退出）才是真释放。旧语义里 stop 置 disposed 后 start 永远调不动，
    // 开关/重登录/换 key 都救不回来——本次拆开。
    this.disposed = false
    this.stopped = false
    // OI-078：空地址禁建连（未配置指引在面板，不静默打黑洞、不进重连循环）。
    if (!this.backendUrl) {
      this.lastError = '未配后端地址：去 设置 → 小沐 填写保存。'
      this.#setStatus('closed')
      return
    }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.sock) return // 已有连接：只刷新配置，不重建
    if (this.readBuffer) {
      const saved = this.readBuffer()
      if (Array.isArray(saved)) {
        this.buffer = saved
          .filter((f) => f && f.messageId && f.message)
          .map((f) => ({ ...f, ts: f.ts || Date.now() }))
      }
    }
    this.#open()
  }

  /**
   * 临时停（OI-025）：停连接与定时器，但不清 disposed 终态之外的状态，
   * 之后 start() 可重起。进程退出走 dispose()。
   */
  stop() {
    this.#stopTransports('stop')
  }

  /**
   * 进程退出释放（OI-025）：与 stop 同部件，但额外置 disposed 终态，
   * 拦截后续一切重连。只在 ctx.on('dispose') 调用。
   */
  dispose() {
    this.#stopTransports('dispose')
    this.disposed = true
  }

  #stopTransports(reason) {
    console.log(`muche backend-ws: ${reason === 'dispose' ? 'dispose()' : 'stop()'} 被调用（退出/禁用/dispose）`)
    if (reason !== 'dispose') this.disposed = false
    // 临时停也要先停事件语义：关闭中 socket 的迟到 close/error 不得再排重连
    // 定时器——否则临时停永远拖住事件循环（OI-025 全量测试 hang 根因）。
    this.stopped = true
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.sock) {
      const old = this.sock
      this.sock = null
      try { old.onclose = null; old.close() } catch { /* 已关 */ }
    }
    this.#setStatus('closed')
  }

  #setStatus(status) {
    this.status = status
    if (this.onStatus) this.onStatus({ status, lastError: this.lastError, buffered: this.buffer.length })
  }

  #wsUrl() {
    // 目标构造唯一真源（与探针同函数；path 前缀原样保留：远端
    // `http(s)://<公网>/api` 拼出 `/api/ws`，经 nginx 反代到达后端）。
    return buildBackendWsUrl(this.backendUrl, this.apiKey, this.channel).url
  }

  #open() {
    if (this.disposed || this.stopped || this.sock) return
    this.#setStatus('connecting')
    let sock
    try {
      sock = new WebSocket(this.#wsUrl())
    } catch (e) {
      this.lastError = `连接被拒绝: ${String(e && e.message ? e.message : e).slice(0, 120)}`
      this.#setStatus('closed')
      this.#scheduleReconnect()
      return
    }
    this.sock = sock
    const openTimer = setTimeout(() => {
      if (sock.readyState !== WebSocket.OPEN) {
        this.lastError = '连接超时（10s 未建立）'
        try { sock.close() } catch { /* onclose 收尾 */ }
      }
    }, 10000)

    sock.on('open', () => {
      clearTimeout(openTimer)
      this.attempts = 0
      this.lastError = ''
      console.log('muche backend-ws: 已连接（重连次数=' + this.attempts + '）')
      this.#setStatus('open')
      this.pingTimer = setInterval(() => {
        try { if (this.sock && this.sock.readyState === WebSocket.OPEN) this.sock.send(JSON.stringify({ type: 'ping' })) } catch { /* 断连由 close 收尾 */ }
      }, PING_INTERVAL_MS)
      // 重连成功：先补发缓冲（FIFO），排空前新帧追加缓冲尾（G3）
      void this.#flushBuffer()
    })

    sock.on('message', (raw) => {
      let frame = null
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (!frame || typeof frame.type !== 'string') return
      if (frame.type === 'reply' && this.onReply) this.onReply(frame)
      else if (frame.type === 'proactive' && this.onProactive) this.onProactive(frame)
      else if (frame.type === 'error' && this.onError) this.onError(frame)
      else if (frame.type === 'dsh_task' && this.onTask) this.onTask(frame)
      else if (frame.type === 'dsh_append' && this.onAppend) this.onAppend(frame)
      else if (frame.type === 'dsh_decide' && this.onDecide) this.onDecide(frame)
      // hello/snapshot/pong 等帧：后台通道不消费（面板才用）
    })

    sock.on('close', (code, reason) => {
      clearTimeout(openTimer)
      console.warn('muche backend-ws: 断开 code=' + code + ' reason=' + String(reason || '').slice(0, 80) + '（disposed=' + this.disposed + '）')
      this.#teardown()
      if (!this.disposed && !this.stopped) this.#scheduleReconnect()
    })

    sock.on('error', (err) => {
      this.lastError = `WebSocket 错误: ${String(err && err.message ? err.message : err).slice(0, 120)}`
      console.warn('muche backend-ws: 错误: ' + this.lastError)
      try { sock.close() } catch { /* onclose 收尾 */ }
    })
  }

  #teardown() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    this.sock = null
    this.#setStatus('closed')
  }

  #scheduleReconnect() {
    if (this.reconnectTimer || this.disposed || this.stopped) return
    const delay = Math.min(RECONNECT_MAX_MS, 3000 * 2 ** Math.min(this.attempts, 4))
    this.attempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.#open()
    }, delay)
  }

  /**
   * 发送 user_message。WS 未连接 → 进缓冲（N1）；连接 → 直发。
   * 缓冲未排空前，新帧追加缓冲尾（G3 FIFO）。
   */
  sendUserMessage(messageId, message) {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN || this.buffer.length > 0) {
      this.#enqueue({ messageId, message })
      return
    }
    try {
      this.sock.send(JSON.stringify({ type: 'user_message', message_id: messageId, message }))
    } catch {
      this.#enqueue({ messageId, message })
    }
  }

  /**
   * 通用帧直发（桥接 `dsh_result` 回传用）：连接不在 OPEN 即抛错，
   * 由调用方决策（任务结果不进离线缓冲——断连的在途任务由后端终结）。
   */
  sendFrame(frame) {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) {
      throw new Error('后端 WS 未连接')
    }
    this.sock.send(JSON.stringify(frame))
  }

  #enqueue(frame) {
    const now = Date.now()
    this.buffer.push({ messageId: frame.messageId, message: frame.message, ts: now })
    // 过期裁剪 + 上限（超限丢弃最旧的，上层已有提示语义）
    this.buffer = this.buffer.filter((f) => now - f.ts < BUFFER_TTL_MS).slice(-BUFFER_MAX)
    if (this.persistBuffer) void this.persistBuffer(this.buffer)
  }

  #flushBuffer() {
    const job = async () => {
      while (this.buffer.length > 0 && this.sock && this.sock.readyState === WebSocket.OPEN) {
        const frame = this.buffer[0]
        try {
          this.sock.send(JSON.stringify({ type: 'user_message', message_id: frame.messageId, message: frame.message }))
          this.buffer.shift()
          if (this.persistBuffer) await this.persistBuffer(this.buffer)
        } catch {
          break // 发送失败：保留缓冲，等下次重连
        }
      }
      if (this.persistBuffer) await this.persistBuffer(this.buffer)
    }
    const run = this.flushChain.then(job)
    this.flushChain = run.catch(() => {})
    return run
  }
}
