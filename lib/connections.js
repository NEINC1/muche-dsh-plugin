/**
 * 连接生命周期唯一 Owner（0.6.0 WP3）：指纹换连。
 *
 * BackendWs 仍是传输类（ping/重连/缓冲语义不动）；本模块拥有“何时建、
 * 何时换、何时停”。指纹 `channel|backendUrl|apiKey` 是换连的唯一依据，
 * 调用方禁各自比对字段。两个消费者：panel-events 的上游、dsh-bridge 的桥。
 *
 * 纤程注册（配置保存后重刷、状态聚合）归各模块自己的 fiber 闭包
 * （bridge 的 fibers 集），不在此另建第二套单例。
 */
import { BackendWs } from './backend_ws.js'

const IDLE_STATE = { status: 'idle', lastError: '', buffered: 0, oldestTs: 0 }

/** 通道指纹：任一段变化即换连（换 key 不串户，不断旧连即半残）。 */
export function fingerprint(channel, backendUrl, apiKey) {
  return `${String(channel || '')}|${String(backendUrl || '')}|${String(apiKey || '')}`
}

export class ChannelConnection {
  /**
   * @param {string} channel 通道名（'' ＝面板池；'dsh-bridge' ＝桥接池）。
   * @param {(opts) => object} [createTransport] 传输工厂（缺省真 BackendWs；
   *   测试注 fake，须有 start()/dispose()，可选 getState()）。
   */
  constructor({ channel = '', createTransport } = {}) {
    this.channel = String(channel || '')
    this.newTransport = createTransport || ((opts) => new BackendWs(opts))
    this.transport = null
    this.key = ''
  }

  get hasTransport() {
    return this.transport !== null
  }

  /** 当前传输（可为 null；发送方自行判空，语义与旧直持 BackendWs 一致）。 */
  get current() {
    return this.transport
  }

  /**
   * 按配置对齐传输：无 key 即停并回 null；指纹相同复用；不同即停旧建新。
   * handlers 直透传输构造（onReply/onProactive/onError/onTask/onAppend/onDecide/onStatus）。
   */
  sync({ backendUrl, apiKey, handlers } = {}) {
    if (!apiKey) {
      this.stop()
      return null
    }
    const key = fingerprint(this.channel, backendUrl, apiKey)
    if (this.transport && this.key === key) return this.transport
    this.stop()
    const t = this.newTransport({ backendUrl, apiKey, channel: this.channel, ...(handlers || {}) })
    this.transport = t
    this.key = key
    t.start()
    return t
  }

  getState() {
    if (this.transport && typeof this.transport.getState === 'function') {
      return this.transport.getState()
    }
    return { ...IDLE_STATE }
  }

  stop() {
    if (this.transport) {
      try {
        this.transport.dispose()
      } catch { /* 已关 */ }
      this.transport = null
      this.key = ''
    }
  }

  dispose() {
    this.stop()
  }
}
