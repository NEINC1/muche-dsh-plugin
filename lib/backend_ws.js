/** 后端 WS 传输：socket 代际、ping/存活检测、退避及 FIFO 缓冲归本实例；建换停归 ChannelConnection。 */
import http from 'node:http'
import https from 'node:https'
import WebSocket from 'ws'
import { buildApiUrl, normalizeBackendUrl } from './backend.js'
import { AUTH_FAILED, FORBIDDEN, HTTP_ERROR, INPUT_INVALID, INVALID_RESPONSE, NEED_KEY, NETWORK, RATE_LIMITED, TIMEOUT, classifyFailure } from './errors.js'

const PING_INTERVAL_MS = 25000
const CONNECT_TIMEOUT_MS = 10000
const RECONNECT_MAX_MS = 30000
const BUFFER_MAX = 20
const BUFFER_TTL_MS = 10 * 60 * 1000

/** HTTP/WS 共用同一基址校验及路径拼装；空 channel 仍属面板池，不伪造 Origin。 */
export function buildBackendWsUrl(backendUrl, token, channel = '') {
  const built = buildApiUrl(backendUrl, '/ws')
  if (!built.ok) throw Object.assign(new Error(built.error), { code: built.code })
  const u = new URL(built.url)
  const secure = u.protocol === 'https:'
  const query = `token=${encodeURIComponent(token ?? '')}` + (channel ? `&channel=${encodeURIComponent(channel)}` : '')
  u.protocol = secure ? 'wss:' : 'ws:'
  u.search = query
  return {
    secure,
    host: u.hostname,
    port: u.port || (secure ? 443 : 80),
    path: `${u.pathname}?${query}`,
    url: u.href,
  }
}

/** 哑-token upgrade 探针只证明网络链路可达；403 不证明真实 key 有效或过期。 */
export function probeBackendUpgrade(backendUrl, { timeoutMs = 8000 } = {}) {
  let target
  try {
    target = buildBackendWsUrl(backendUrl, '__muche_ws_diag_probe__')
  } catch (error) {
    const failure = classifyFailure({ code: error.code })
    return Promise.resolve({ ok: false, stage: 'target', code: failure.code, error: failure.text, backend: describeTarget(backendUrl) })
  }
  const backend = {
    protocol: target.secure ? 'https' : 'http',
    host: target.host,
    port: target.port,
    pathPrefix: new URL(target.url).pathname.slice(0, -3) || '(根)',
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
    } catch {
      finish({ ok: false, stage: 'target', error: '请检查配置' })
      return
    }
    upReq.on('upgrade', (upRes, upSocket) => {
      upSocket.destroy()
      finish({ ok: false, stage: 'upgraded-unexpectedly', error: '哑 token 被后端接受，请检查后端安全配置' })
    })
    upReq.on('response', (res) => {
      res.resume()
      finish({ ok: true, stage: 'backend-reached', status: res.statusCode })
    })
    upReq.on('timeout', () => {
      finish({ ok: false, stage: 'timeout', code: TIMEOUT, error: '后端连接超时' })
      upReq.destroy()
    })
    upReq.on('error', (error) => {
      finish({ ok: false, stage: classifyNetError(error), code: NETWORK, error: '后端连接未建立' })
    })
    upReq.end()
  })
}

function describeTarget(backendUrl) {
  const normalized = normalizeBackendUrl(backendUrl)
  if (!normalized.ok) return { protocol: '?', host: '(无效)', port: '?', pathPrefix: '?' }
  const u = new URL(normalized.url)
  return {
    protocol: u.protocol === 'https:' ? 'https' : 'http',
    host: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    pathPrefix: u.pathname.replace(/\/+$/, '') || '(根)',
  }
}

function classifyNetError(error) {
  const code = String(error?.code || '')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED/.test(code)) return 'tls'
  return 'tcp'
}

function closeFailure(code) {
  if (code === 4003 || code === 4401) return classifyFailure({ code: AUTH_FAILED })
  if (code === 1008 || code === 4403) return classifyFailure({ code: FORBIDDEN })
  if (code === 1007 || code === 1009) return classifyFailure({ code: INPUT_INVALID })
  if (code === 1002 || code === 1003 || code === 1010) return classifyFailure({ code: INVALID_RESPONSE })
  if (code === 4429) return classifyFailure({ code: RATE_LIMITED })
  if (code === 4408) return classifyFailure({ code: TIMEOUT })
  if (code === 1011) return classifyFailure({ code: HTTP_ERROR, status: 500 })
  return classifyFailure({ code: NETWORK })
}

export class BackendWs {
  /**
   * opts.channel 缺省 dsh-bridge，显式空串是面板池；业务回调不改变池归属。
   * onHello 仅接受真正后端 hello，onStatus/getState.ready 不以 socket open 代替。
   * WebSocket/timers/now/random 是内部测试 seam，不另建生命周期 Owner。
   */
  constructor(opts = {}) {
    this.backendUrl = String(opts.backendUrl || '').trim()
    this.apiKey = opts.apiKey || ''
    this.channel = opts.channel === undefined ? 'dsh-bridge' : String(opts.channel || '')
    for (const key of ['onReply', 'onProactive', 'onDialogueUpdated', 'onError', 'onTask', 'onAppend', 'onDecide', 'onQuery', 'onHello', 'onHelloAck', 'onStatus', 'readBuffer', 'persistBuffer']) this[key] = opts[key]
    this.WebSocket = opts.WebSocket || WebSocket
    const timers = opts.timers || globalThis
    this.timers = Object.fromEntries(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map((key) => [key, timers[key].bind(timers)]))
    this.now = opts.now || (() => Date.now())
    this.random = opts.random || Math.random
    this.sock = null
    this.openTimer = null
    this.helloTimer = null
    this.pingTimer = null
    this.reconnectTimer = null
    this.generation = 0
    this.attempts = 0
    this.status = 'idle'
    this.ready = false
    this.lastError = ''
    this.code = ''
    this.closeCode = null
    this.reason = ''
    this.retryable = false
    this.lastSeen = 0
    this.buffer = []
    this.bufferLoaded = false
    this.disposed = false
    this.stopped = true
    this.paused = false
    this.flushChain = Promise.resolve()
    this.persistChain = Promise.resolve()
  }

  getState() {
    return {
      status: this.status,
      ready: this.ready,
      lastError: this.lastError,
      code: this.code,
      closeCode: this.closeCode,
      reason: this.reason,
      retryable: this.retryable,
      buffered: this.buffer.length,
      oldestTs: this.buffer.length > 0 ? this.buffer[0].ts : 0,
    }
  }

  /** 显式 start 可解除非重试失败的 pause；普通 sync 同配置不得偷偷重试。dispose 是终态。 */
  start() {
    if (this.disposed || this.sock) return
    this.stopped = false
    this.paused = false
    this.attempts = 0
    this.#clearReconnect()
    if (!this.bufferLoaded) {
      this.bufferLoaded = true
      if (this.readBuffer) {
        const saved = this.readBuffer()
        if (Array.isArray(saved)) {
          const now = this.now()
          this.buffer = saved.filter((f) => f && f.messageId && f.message)
            .map((f) => ({ ...f, ts: f.ts ?? now }))
            .filter((f) => now - f.ts < BUFFER_TTL_MS).slice(-BUFFER_MAX)
        }
      }
    }
    this.#open()
  }

  stop() {
    this.#stop(false)
  }

  dispose() {
    this.#stop(true)
  }

  #stop(dispose) {
    const changed = !this.stopped || this.status !== 'closed'
    this.stopped = true
    if (dispose) this.disposed = true
    this.generation += 1
    this.#clearReconnect()
    this.#clearSocketTimers()
    const old = this.sock
    this.sock = null
    this.ready = false
    this.retryable = false
    this.#closeSocket(old)
    if (changed) this.#setStatus('closed')
  }

  #setStatus(status) {
    this.status = status
    this.onStatus?.(this.getState())
  }

  #current(sock, generation) {
    return !this.disposed && !this.stopped && this.sock === sock && this.generation === generation
  }

  #clearSocketTimers() {
    for (const key of ['openTimer', 'helloTimer']) {
      if (this[key] !== null) this.timers.clearTimeout(this[key])
      this[key] = null
    }
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  #clearReconnect() {
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  #closeSocket(sock) {
    if (!sock) return
    try {
      if (typeof sock.terminate === 'function') sock.terminate()
      else sock.close()
    } catch { /* 连接已失效；本代际已关闭，迟到事件不再参与状态。 */ }
  }

  #recordFailure(failure, { closeCode = null, reason = '' } = {}) {
    this.code = failure.code
    this.lastError = failure.text
    this.retryable = failure.retryable
    this.closeCode = closeCode
    this.reason = String(reason || '').slice(0, 200)
    this.paused = !failure.retryable
    this.ready = false
  }

  #finish(sock, generation, failure, close = {}) {
    if (!this.#current(sock, generation)) return
    this.generation += 1
    this.sock = null
    this.#clearSocketTimers()
    this.#recordFailure(failure, close)
    this.#closeSocket(sock)
    console.warn(`muche backend-ws: closed code=${failure.code} closeCode=${close.closeCode ?? '-'} retryable=${failure.retryable}`)
    this.#setStatus('closed')
    this.#scheduleReconnect()
  }

  #open() {
    if (this.disposed || this.stopped || this.paused || this.sock) return
    let url
    try {
      url = buildBackendWsUrl(this.backendUrl, this.apiKey, this.channel).url
      if (!this.apiKey) throw Object.assign(new Error('请检查配置'), { code: NEED_KEY })
    } catch (error) {
      this.#recordFailure(classifyFailure({ code: error.code, error }))
      this.#setStatus('closed')
      return
    }
    const generation = ++this.generation
    this.ready = false
    this.code = ''
    this.lastError = ''
    this.closeCode = null
    this.reason = ''
    this.retryable = false
    this.#setStatus('connecting')
    if (this.disposed || this.stopped || this.generation !== generation) return
    let sock
    try { sock = new this.WebSocket(url) } catch (error) {
      this.#recordFailure(classifyFailure({ error }))
      this.#setStatus('closed')
      this.#scheduleReconnect()
      return
    }
    this.sock = sock
    this.openTimer = this.timers.setTimeout(() => {
      if (this.#current(sock, generation)) this.#finish(sock, generation, classifyFailure({ code: TIMEOUT }))
    }, CONNECT_TIMEOUT_MS)

    sock.on('open', () => {
      if (!this.#current(sock, generation)) return
      this.timers.clearTimeout(this.openTimer)
      this.openTimer = null
      this.lastSeen = this.now()
      this.#setStatus('open')
      if (!this.#current(sock, generation)) return
      this.helloTimer = this.timers.setTimeout(() => {
        if (this.#current(sock, generation) && !this.ready) this.#finish(sock, generation, classifyFailure({ code: TIMEOUT }))
      }, CONNECT_TIMEOUT_MS)
      this.pingTimer = this.timers.setInterval(() => {
        if (!this.#current(sock, generation)) return
        if (this.now() - this.lastSeen >= 2 * PING_INTERVAL_MS) {
          this.#finish(sock, generation, classifyFailure({ code: TIMEOUT }))
          return
        }
        try { sock.send(JSON.stringify({ type: 'ping' })) } catch (error) {
          this.#finish(sock, generation, classifyFailure({ error }))
        }
      }, PING_INTERVAL_MS)
    })

    sock.on('message', (raw) => {
      if (!this.#current(sock, generation)) return
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return
      this.lastSeen = this.now()
      if (frame.type === 'hello') {
        if (frame.via === 'sse' || this.ready) return
        this.ready = true
        this.attempts = 0
        if (this.helloTimer !== null) this.timers.clearTimeout(this.helloTimer)
        this.helloTimer = null
        this.#setStatus('open')
        if (!this.#current(sock, generation)) return
        this.onHello?.(frame)
        if (this.#current(sock, generation)) void this.#flushBuffer(sock, generation)
        return
      }
      const handler = {
        reply: this.onReply, proactive: this.onProactive, dialogue_updated: this.onDialogueUpdated, error: this.onError,
        dsh_task: this.onTask, dsh_append: this.onAppend, dsh_decide: this.onDecide, dsh_session_query: this.onQuery,
        dsh_hello_ack: this.onHelloAck,
      }[frame.type]
      if (frame.type === 'error') {
        const failure = classifyFailure({ code: frame.code, kind: frame.kind, status: frame.status, error: frame.error, text: frame.kind === 'input' ? frame.text : undefined })
        handler?.({ ...frame, code: failure.code, error: failure.text, retryable: failure.retryable, kind: failure.kind })
        if (failure.kind === 'config' || failure.kind === 'access') this.#finish(sock, generation, failure)
      } else handler?.(frame)
    })

    sock.on('pong', () => {
      if (this.#current(sock, generation)) this.lastSeen = this.now()
    })
    sock.on('close', (code, reason) => {
      this.#finish(sock, generation, closeFailure(code), { closeCode: code, reason })
    })
    sock.on('error', (error) => {
      this.#finish(sock, generation, classifyFailure({ error }))
    })
    sock.on('unexpected-response', (req, res) => {
      if (!this.#current(sock, generation)) return
      const failure = classifyFailure({ status: res.statusCode })
      this.#finish(sock, generation, failure)
      res.resume?.()
      req.destroy?.()
    })
  }

  #scheduleReconnect() {
    if (this.reconnectTimer !== null || this.disposed || this.stopped || this.paused || !this.retryable) return
    const generation = this.generation
    const base = Math.min(RECONNECT_MAX_MS, 3000 * 2 ** Math.min(this.attempts, 4))
    const jitter = 0.8 + Math.max(0, Math.min(1, this.random())) * 0.4
    const delay = Math.min(RECONNECT_MAX_MS, Math.round(base * jitter))
    this.attempts += 1
    this.reconnectTimer = this.timers.setTimeout(() => {
      if (this.disposed || this.stopped || this.paused || this.generation !== generation) return
      this.reconnectTimer = null
      this.#open()
    }, delay)
  }

  #canSend(sock = this.sock) {
    return !this.stopped && !this.disposed && sock && sock === this.sock && sock.readyState === (this.WebSocket.OPEN ?? 1)
  }

  sendUserMessage(messageId, message) {
    if (!this.#canSend() || !this.ready || this.buffer.length > 0) {
      this.#enqueue({ messageId, message })
      if (this.#canSend() && this.ready) void this.#flushBuffer(this.sock, this.generation)
      return
    }
    try { this.sock.send(JSON.stringify({ type: 'user_message', message_id: messageId, message })) } catch (error) {
      this.#enqueue({ messageId, message })
      this.#finish(this.sock, this.generation, classifyFailure({ error }))
    }
  }

  /** 桥接结果不进入离线缓冲；失败交付由桥接 Owner 判，禁止自动重做副作用任务。 */
  sendFrame(frame) {
    if (!this.#canSend()) throw Object.assign(new Error('后端 WS 未连接'), { code: NETWORK })
    this.sock.send(JSON.stringify(frame))
  }

  #persist() {
    if (!this.persistBuffer) return Promise.resolve()
    const snapshot = this.buffer.map((frame) => ({ ...frame }))
    // 缓冲仍只有本实例一个写者；串行快照防止慢旧写覆盖新代际已排空的快照。
    this.persistChain = this.persistChain.then(() => this.persistBuffer(snapshot))
      .catch(() => console.warn('muche backend-ws: buffer persistence failed'))
    return this.persistChain
  }

  #enqueue(frame) {
    const now = this.now()
    this.buffer.push({ messageId: frame.messageId, message: frame.message, ts: now })
    this.buffer = this.buffer.filter((f) => now - f.ts < BUFFER_TTL_MS).slice(-BUFFER_MAX)
    void this.#persist()
  }

  #flushBuffer(sock, generation) {
    const job = async () => {
      while (this.buffer.length > 0 && this.#current(sock, generation) && this.#canSend(sock) && this.ready) {
        const frame = this.buffer[0]
        if (this.now() - frame.ts >= BUFFER_TTL_MS) this.buffer.shift()
        else {
          try { sock.send(JSON.stringify({ type: 'user_message', message_id: frame.messageId, message: frame.message })) } catch (error) {
            this.#finish(sock, generation, classifyFailure({ error }))
            break
          }
          this.buffer.shift()
        }
        await this.#persist()
      }
    }
    const run = this.flushChain.then(job)
    this.flushChain = run.catch(() => console.warn('muche backend-ws: buffer persistence failed'))
    return this.flushChain
  }
}
