/**
 * 小沐后端 WS 客户端（Host 侧常驻：dsh 反向桥接通道）。
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
import WebSocket from 'ws'

const PING_INTERVAL_MS = 25000
const RECONNECT_MAX_MS = 30000
const BUFFER_MAX = 20
const BUFFER_TTL_MS = 10 * 60 * 1000

export class BackendWs {
  /**
   * @param {object} opts
   * @param {string} opts.backendUrl
   * @param {string} opts.apiKey
   * @param {string} [opts.channel]
   *   后端通道名：dsh 反向桥接传 `dsh-bridge`。
   *   通道决定后端侧的连接池与额度归属，ping/重连/缓冲语义两者一致。
   * @param {(frame: object) => void} opts.onReply
   * @param {(frame: object) => void} opts.onProactive
   * @param {(frame: object) => void} opts.onError
   * @param {(frame: object) => void} [opts.onTask]
   *   桥接任务回调（仅 `dsh-bridge` 通道）：收到 `dsh_task` 帧时调用，
   *   由调用方执行并经 `sendFrame` 回传 `dsh_result`。
   * @param {(frame: object) => void} [opts.onAppend]
   *   追单回调（仅 `dsh-bridge` 通道）：收到 `dsh_append` 帧时调用，
   *   向同一会话 queue 追消息，最终只出一个结果（不另起 waiter）。
   * @param {(patch: object) => void} opts.onStatus
   * @param {() => Array} opts.readBuffer     启动时读持久化缓冲（settings）
   * @param {(frames: Array) => Promise<void>} opts.persistBuffer  缓冲落盘
   */
  constructor(opts = {}) {
    this.backendUrl = String(opts.backendUrl || '').replace(/\/+$/, '')
    this.apiKey = opts.apiKey || ''
    this.channel = typeof opts.channel === 'string' && opts.channel ? opts.channel : 'dsh-bridge'
    this.onReply = opts.onReply
    this.onProactive = opts.onProactive
    this.onError = opts.onError
    this.onTask = opts.onTask
    this.onAppend = opts.onAppend
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
    const base = this.backendUrl.replace(/^http/, 'ws')
    // 通道由构造参数决定（dsh-bridge：反向桥接，后端独立桥接池）。path 前缀原样保留：
    // 远端 `http(s)://<公网>/api` 拼出 `/api/ws`，经 nginx 反代到达后端。
    return `${base}/ws?token=${encodeURIComponent(this.apiKey)}&channel=${encodeURIComponent(this.channel)}`
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
