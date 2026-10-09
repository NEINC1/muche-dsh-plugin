/** 配置指纹决定通道的建/换/停；传输状态及重试策略只由 BackendWs 提交。 */
import { BackendWs } from './backend_ws.js'

const IDLE_STATE = { status: 'idle', ready: false, lastError: '', code: '', closeCode: null, reason: '', retryable: false, buffered: 0, oldestTs: 0 }

export function fingerprint(channel, backendUrl, apiKey) {
  return JSON.stringify([String(channel || ''), String(backendUrl || ''), String(apiKey || '')])
}

export class ChannelConnection {
  constructor({ channel = '', createTransport } = {}) {
    this.channel = String(channel || '')
    this.newTransport = createTransport || ((opts) => new BackendWs(opts))
    this.transport = null
    this.key = ''
    this.generation = 0
    this.handlers = null
    this.disposed = false
  }

  get hasTransport() {
    return this.transport !== null
  }

  get current() {
    return this.transport
  }

  /** 缺 key 或 base 才不建；非法但非空基址交传输分类，不在此另判配置规则。 */
  sync({ backendUrl, apiKey, handlers } = {}) {
    if (this.disposed) return null
    if (!String(apiKey || '').trim() || !String(backendUrl || '').trim()) {
      this.stop()
      return null
    }
    const key = fingerprint(this.channel, backendUrl, apiKey)
    if (this.transport && this.key === key) return this.transport
    const stoppedGeneration = this.generation + 1
    this.stop()
    if (this.disposed || this.generation !== stoppedGeneration) return this.transport
    const generation = ++this.generation
    this.handlers = handlers || {}
    const fenced = { ...this.handlers }
    for (const [name, handler] of Object.entries(this.handlers)) {
      if (name.startsWith('on') && typeof handler === 'function') {
        fenced[name] = (...args) => {
          if (this.disposed || this.generation !== generation || !this.transport) return
          return handler(...args)
        }
      }
    }
    const transport = this.newTransport({ ...fenced, backendUrl, apiKey, channel: this.channel })
    if (this.disposed || this.generation !== generation) {
      transport.dispose()
      return this.transport
    }
    this.transport = transport
    this.key = key
    transport.start()
    return this.transport
  }

  getState() {
    if (this.transport && typeof this.transport.getState === 'function') return this.transport.getState()
    return { ...IDLE_STATE }
  }

  stop() {
    const transport = this.transport
    const handlers = this.handlers
    this.generation += 1
    this.transport = null
    this.handlers = null
    this.key = ''
    if (!transport) return
    try { transport.dispose() } catch {
      console.warn('muche channel: transport disposal failed')
    }
    // 显式停用仍通知当前消费者一次；dispose 内或稍后到来的旧回调全部被代际栅栏拒绝。
    const state = typeof transport.getState === 'function' ? transport.getState() : IDLE_STATE
    handlers?.onStatus?.({ ...state, status: 'closed', ready: false, retryable: false })
  }

  dispose() {
    this.disposed = true
    this.stop()
  }
}
