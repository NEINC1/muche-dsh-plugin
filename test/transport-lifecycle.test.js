import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BackendWs } from '../lib/backend_ws.js'
import { ChannelConnection } from '../lib/connections.js'
import { AUTH_FAILED, FORBIDDEN, HTTP_ERROR, INPUT_INVALID, INVALID_RESPONSE, NEED_KEY, NEED_SETUP, NETWORK, QUOTA, RATE_LIMITED, TARGET, TIMEOUT } from '../lib/errors.js'

class Clock {
  constructor() { this.time = 1000; this.nextId = 1; this.jobs = new Map() }
  setTimeout(fn, delay) { return this.add(fn, delay, 0) }
  setInterval(fn, delay) { return this.add(fn, delay, delay) }
  add(fn, delay, interval) {
    const id = this.nextId++
    this.jobs.set(id, { id, fn, at: this.time + delay, interval })
    return id
  }
  clearTimeout(id) { this.jobs.delete(id) }
  clearInterval(id) { this.jobs.delete(id) }
  advance(ms) {
    const target = this.time + ms
    let steps = 0
    while (true) {
      const job = [...this.jobs.values()].filter((item) => item.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!job) break
      if (++steps > 1000) throw new Error('timer runaway')
      this.time = job.at
      if (job.interval) job.at += job.interval
      else this.jobs.delete(job.id)
      job.fn()
    }
    this.time = target
  }
  nextDelay() { return Math.min(...[...this.jobs.values()].map((job) => job.at - this.time)) }
}

function fixture(opts = {}) {
  const sockets = []
  class Socket extends EventEmitter {
    static OPEN = 1
    constructor(url) {
      super()
      this.url = url
      this.readyState = 0
      this.sent = []
      this.terminated = 0
      sockets.push(this)
    }
    open() { this.readyState = 1; this.emit('open') }
    frame(frame) { this.emit('message', JSON.stringify(frame)) }
    remoteClose(code, reason = '') { this.readyState = 3; this.emit('close', code, Buffer.from(reason)) }
    send(raw) {
      if (this.readyState !== 1) throw Object.assign(new Error('not open'), { code: 'ECONNRESET' })
      this.sent.push(JSON.parse(raw))
    }
    terminate() { this.terminated += 1; this.readyState = 3; this.emit('close', 1006, Buffer.from('local termination')) }
  }
  const clock = new Clock()
  const statuses = []
  const hellos = []
  const transport = new BackendWs({
    backendUrl: 'https://h/custom', apiKey: 'test-key',
    WebSocket: Socket, timers: clock, now: () => clock.time, random: () => 0.5,
    onStatus: (state) => statuses.push(state), onHello: (frame) => hellos.push(frame), ...opts,
  })
  return { transport, sockets, clock, statuses, hellos, Socket }
}
function greet(socket) { socket.open(); socket.frame({ type: 'hello', user_id: 'test-user' }) }
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('ready只由真后端hello提交：open和synthetic SSE hello不能算在线', () => {
  const { transport, sockets, statuses, hellos } = fixture()
  assert.equal(transport.getState().ready, false)
  transport.start()
  assert.equal(transport.getState().status, 'connecting')
  sockets[0].open()
  assert.equal(transport.getState().status, 'open')
  assert.equal(transport.getState().ready, false)
  sockets[0].frame({ type: 'hello', via: 'sse' })
  assert.equal(transport.getState().ready, false)
  assert.equal(hellos.length, 0)
  sockets[0].frame({ type: 'hello', user_id: 'test-user' })
  assert.equal(transport.getState().ready, true)
  assert.equal(hellos.length, 1)
  sockets[0].frame({ type: 'hello', user_id: 'test-user' })
  assert.equal(hellos.length, 1)
  assert.deepEqual(statuses.filter((state) => state.status === 'open').map((state) => state.ready), [false, true])
  transport.dispose()
  assert.equal(statuses.at(-1).ready, false)
})

test('hello后原有业务/任务帧完整分发；quota只是本次业务失败，不断开连接', () => {
  const seen = []
  const handlers = Object.fromEntries(['onReply', 'onProactive', 'onDialogueUpdated', 'onTask', 'onAppend', 'onDecide', 'onQuery'].map((key) => [key, (frame) => seen.push(frame)]))
  const errors = []
  const { transport, sockets } = fixture({ ...handlers, onError: (frame) => errors.push(frame) })
  transport.start(); greet(sockets[0])
  const frames = ['reply', 'proactive', 'dialogue_updated', 'dsh_task', 'dsh_append', 'dsh_decide', 'dsh_session_query'].map((type) => ({ type, task_id: type, payload: { x: 1 } }))
  for (const frame of frames) sockets[0].frame(frame)
  assert.deepEqual(seen, frames)
  sockets[0].frame({ type: 'unknown_event', payload: 'must not forward' })
  assert.deepEqual(seen, frames)
  sockets[0].frame({ type: 'error', code: QUOTA, error: 'private detail', reset_at: 'later' })
  assert.equal(errors[0].code, QUOTA)
  assert.equal(errors[0].error, '消息额度已用完')
  assert.equal(errors[0].reset_at, 'later')
  assert.equal(transport.getState().ready, true)
  sockets[0].frame({ type: 'error', kind: 'operation', error: 'raw fetch private', text: 'internal stack' })
  assert.equal(errors[1].error, '操作未完成，请稍后重试')
  transport.dispose()
})

test('BackendWs缺省channel为dsh-bridge，显式空channel保持面板原契约', () => {
  for (const channel of [undefined, '']) {
    const { transport, sockets } = fixture({ channel })
    transport.start()
    assert.equal(new URL(sockets[0].url).searchParams.get('channel'), channel === undefined ? 'dsh-bridge' : null)
    transport.dispose()
  }
})

test('stop/start后旧socket迟到open/message/close/error/pong及timer不能污染新代际', () => {
  const replies = []
  const { transport, sockets, clock, statuses, hellos } = fixture({ onReply: (frame) => replies.push(frame) })
  transport.start()
  const old = sockets[0]
  const lateConnectTimeout = [...clock.jobs.values()][0].fn
  old.open()
  const lateHelloTimeout = [...clock.jobs.values()].find((job) => !job.interval).fn
  transport.stop()
  assert.equal(clock.jobs.size, 0)
  transport.start()
  const current = sockets[1]
  greet(current)
  const state = transport.getState()
  const statusCount = statuses.length
  old.open()
  old.frame({ type: 'hello', user_id: 'old' })
  old.frame({ type: 'reply', text: 'late' })
  old.remoteClose(4003, 'credential revoked')
  old.emit('error', Object.assign(new Error('late'), { code: 'ECONNRESET' }))
  old.emit('pong')
  lateConnectTimeout()
  lateHelloTimeout()
  assert.deepEqual(transport.getState(), state)
  assert.equal(statuses.length, statusCount)
  assert.equal(hellos.length, 1)
  assert.equal(replies.length, 0)
  current.frame({ type: 'reply', text: 'current' })
  assert.equal(replies.length, 1)
  transport.dispose()
  assert.equal(clock.jobs.size, 0)
})

test('dispose为终态，start不可复活，迟到事件不排重连', () => {
  const { transport, sockets, clock, statuses } = fixture()
  transport.start()
  const old = sockets[0]
  transport.dispose()
  const count = statuses.length
  old.open()
  old.frame({ type: 'hello' })
  old.remoteClose(1006)
  transport.start()
  transport.stop()
  transport.start()
  assert.equal(sockets.length, 1)
  assert.equal(transport.getState().status, 'closed')
  assert.equal(transport.getState().ready, false)
  assert.equal(statuses.length, count)
  assert.equal(clock.jobs.size, 0)
})

test('1008/4003等明确非重试失败pause，不猜过期或Origin；显式start才恢复', () => {
  const cases = [[1008, FORBIDDEN], [4003, AUTH_FAILED], [4403, FORBIDDEN], [1007, INPUT_INVALID], [1009, INPUT_INVALID], [1002, INVALID_RESPONSE]]
  for (const [closeCode, code] of cases) {
    const { transport, sockets, clock } = fixture()
    transport.start(); greet(sockets[0])
    sockets[0].remoteClose(closeCode, 'ambiguous credential or origin reason')
    const state = transport.getState()
    assert.equal(state.ready, false)
    assert.equal(state.status, 'closed')
    assert.equal(state.closeCode, closeCode)
    assert.equal(state.reason, 'ambiguous credential or origin reason')
    assert.equal(state.code, code)
    assert.equal(state.retryable, false)
    assert.ok(!state.lastError.includes('过期'))
    if (code === AUTH_FAILED) assert.equal(state.lastError, '请检查配置')
    clock.advance(600000)
    assert.equal(sockets.length, 1)
    assert.equal(clock.jobs.size, 0)
    transport.start()
    assert.equal(sockets.length, 2)
    assert.equal(transport.getState().status, 'connecting')
    transport.dispose()
  }
})

test('真实Channel同配置sync不解除pause，配置改变会dispose旧并建新', () => {
  const { Socket, sockets, clock } = fixture()
  const channel = new ChannelConnection({ channel: '', createTransport: (opts) => new BackendWs({ ...opts, WebSocket: Socket, timers: clock, now: () => clock.time, random: () => 0.5 }) })
  const old = channel.sync({ backendUrl: 'https://h/custom', apiKey: 'k1' })
  greet(sockets[0]); sockets[0].remoteClose(1008)
  assert.equal(channel.sync({ backendUrl: 'https://h/custom', apiKey: 'k1' }), old)
  clock.advance(60000)
  assert.equal(sockets.length, 1)
  const current = channel.sync({ backendUrl: 'https://h/custom', apiKey: 'k2' })
  assert.notEqual(current, old)
  assert.equal(old.disposed, true)
  assert.equal(sockets.length, 2)
  greet(sockets[1])
  assert.equal(channel.getState().ready, true)
  sockets[0].remoteClose(4003)
  assert.equal(channel.getState().ready, true)
  channel.dispose()
  assert.equal(clock.jobs.size, 0)
})

test('可靠network异常指数退避，直到真hello才重置，不以open重置', () => {
  const { transport, sockets, clock } = fixture()
  transport.start()
  for (const [index, delay] of [3000, 6000, 12000, 24000, 30000].entries()) {
    sockets[index].remoteClose(1006)
    assert.equal(transport.getState().code, NETWORK)
    assert.equal(transport.getState().retryable, true)
    assert.equal(clock.nextDelay(), delay)
    clock.advance(delay - 1)
    assert.equal(sockets.length, index + 1)
    clock.advance(1)
    assert.equal(sockets.length, index + 2)
  }
  sockets[5].open()
  sockets[5].remoteClose(1006)
  assert.equal(clock.nextDelay(), 30000)
  clock.advance(30000)
  greet(sockets[6])
  sockets[6].remoteClose(1006)
  assert.equal(clock.nextDelay(), 3000)
  transport.dispose()
})

test('退避加入可测jitter且最大30s，旧重连回调不能再建连接', () => {
  for (const [random, expected] of [[0, 2400], [1, 3600]]) {
    const { transport, sockets, clock } = fixture({ random: () => random })
    transport.start(); sockets[0].remoteClose(1006)
    assert.equal(clock.nextDelay(), expected)
    const lateReconnect = [...clock.jobs.values()][0].fn
    transport.stop(); transport.start()
    lateReconnect()
    assert.equal(sockets.length, 2)
    transport.dispose()
  }
})

test('HTTP升级403/401明确停，503仅业务暂不可用可退避，绝不伪造Origin绕过拒绝', () => {
  for (const [status, code, retryable] of [[403, FORBIDDEN, false], [401, AUTH_FAILED, false], [503, HTTP_ERROR, true], [404, HTTP_ERROR, false]]) {
    const { transport, sockets, clock } = fixture()
    transport.start()
    let destroyed = 0
    let drained = 0
    sockets[0].emit('unexpected-response', { destroy: () => destroyed++ }, { statusCode: status, resume: () => drained++ })
    assert.equal(transport.getState().code, code)
    assert.equal(transport.getState().retryable, retryable)
    assert.equal(destroyed, 1)
    assert.equal(drained, 1)
    assert.equal(clock.jobs.size, retryable ? 1 : 0)
    assert.ok(!transport.getState().lastError.includes('过期'))
    transport.dispose()
  }
})

test('异常name/code可靠才NETWORK/TIMEOUT，unknown Error安全operation且不无限重试', () => {
  for (const [error, code, retryable] of [[Object.assign(new Error('private'), { code: 'ECONNRESET' }), NETWORK, true], [new DOMException('private', 'TimeoutError'), TIMEOUT, true], [new Error('network timeout abort private'), HTTP_ERROR, false]]) {
    const { transport, sockets, clock } = fixture()
    transport.start()
    sockets[0].emit('error', error)
    assert.equal(transport.getState().code, code)
    assert.equal(transport.getState().retryable, retryable)
    assert.ok(!transport.getState().lastError.includes('private'))
    assert.equal(clock.jobs.size, retryable ? 1 : 0)
    transport.dispose()
  }
})

test('真实hello有10s截止，synthetic hello/pong不能令socket永久open未ready', () => {
  const { transport, sockets, clock } = fixture()
  transport.start(); sockets[0].open()
  sockets[0].frame({ type: 'hello', via: 'sse' })
  sockets[0].frame({ type: 'pong' })
  clock.advance(9999)
  assert.equal(transport.getState().status, 'open')
  assert.equal(transport.getState().ready, false)
  clock.advance(1)
  assert.equal(transport.getState().status, 'closed')
  assert.equal(transport.getState().code, TIMEOUT)
  assert.equal(transport.getState().retryable, true)
  transport.dispose()
})

test('25s ping；50s没有pong/真实frame即不再ready并重连，不能假在线', () => {
  const { transport, sockets, clock } = fixture()
  transport.start(); greet(sockets[0])
  clock.advance(25000)
  assert.deepEqual(sockets[0].sent, [{ type: 'ping' }])
  assert.equal(transport.getState().ready, true)
  clock.advance(25000)
  assert.equal(transport.getState().ready, false)
  assert.equal(transport.getState().status, 'closed')
  assert.equal(transport.getState().code, TIMEOUT)
  assert.equal(sockets[0].terminated, 1)
  clock.advance(3000)
  assert.equal(sockets.length, 2)
  transport.dispose()
})

test('应用pong/任意真实frame/协议pong都会更新lastSeen，旧代际pong不能续命', () => {
  const { transport, sockets, clock } = fixture()
  transport.start(); greet(sockets[0])
  clock.advance(24000); sockets[0].frame({ type: 'pong' })
  clock.advance(25000); sockets[0].frame({ type: 'unconsumed_snapshot', value: 1 })
  clock.advance(25000); sockets[0].emit('pong')
  clock.advance(25000)
  assert.equal(transport.getState().ready, true)
  assert.equal(sockets[0].sent.filter((frame) => frame.type === 'ping').length, 3)
  const old = sockets[0]
  transport.stop(); transport.start(); greet(sockets[1])
  clock.advance(24000); old.emit('pong')
  clock.advance(26000)
  assert.equal(transport.getState().ready, false)
  assert.equal(transport.getState().code, TIMEOUT)
  transport.dispose()
})

test('RATE_LIMITED不是消息额度，业务帧不掉线；明确access错误帧pause', () => {
  const errors = []
  const { transport, sockets, clock } = fixture({ onError: (frame) => errors.push(frame) })
  transport.start(); greet(sockets[0])
  sockets[0].frame({ type: 'error', status: 429 })
  assert.equal(errors[0].code, RATE_LIMITED)
  assert.equal(errors[0].kind, 'operation')
  assert.equal(transport.getState().ready, true)
  sockets[0].frame({ type: 'error', code: FORBIDDEN, error: 'key may have expired' })
  assert.equal(errors[1].code, FORBIDDEN)
  assert.equal(transport.getState().status, 'closed')
  assert.equal(transport.getState().retryable, false)
  assert.equal(clock.jobs.size, 0)
  transport.dispose()
})

test('FIFO缓冲等真hello补发；stop/new代际不会让旧异步flush跨socket发送', async () => {
  let release
  let first = true
  const gate = new Promise((resolve) => { release = resolve })
  const persisted = []
  const saved = [{ messageId: 'm1', message: 'one', ts: 1000 }, { messageId: 'm2', message: 'two', ts: 1000 }]
  const { transport, sockets } = fixture({
    readBuffer: () => saved,
    persistBuffer: async (frames) => { persisted.push(frames); if (first) { first = false; await gate } },
  })
  transport.start(); sockets[0].open()
  assert.equal(transport.getState().buffered, 2)
  assert.deepEqual(sockets[0].sent, [])
  sockets[0].frame({ type: 'hello' })
  await settle()
  assert.deepEqual(sockets[0].sent.map((frame) => frame.message_id), ['m1'])
  transport.stop(); transport.start(); greet(sockets[1])
  transport.sendUserMessage('m3', 'three')
  assert.equal(transport.getState().buffered, 2)
  release()
  await settle()
  assert.deepEqual(sockets[0].sent.map((frame) => frame.message_id), ['m1'])
  assert.deepEqual(sockets[1].sent.map((frame) => frame.message_id), ['m2', 'm3'])
  assert.equal(transport.getState().buffered, 0)
  assert.deepEqual(persisted.at(-1), [])
  transport.sendFrame({ type: 'dsh_result', task_id: 't1', ok: true })
  assert.equal(sockets[1].sent.at(-1).type, 'dsh_result')
  transport.dispose()
  assert.throws(() => transport.sendFrame({ type: 'dsh_result' }), (error) => error.code === NETWORK)
})

test('慢离线持久化必须先于排空快照完成，不能把已补发消息重新写回离线存储', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let first = true
  const writes = []
  const { transport, sockets } = fixture({ persistBuffer: async (frames) => {
    if (first) { first = false; await gate }
    writes.push(frames)
  } })
  transport.sendUserMessage('m1', 'one')
  transport.start(); greet(sockets[0])
  await settle()
  assert.equal(writes.length, 0)
  release()
  await settle()
  assert.deepEqual(writes.map((frames) => frames.map((frame) => frame.messageId)), [['m1'], []])
  assert.equal(transport.getState().buffered, 0)
  transport.dispose()
})

test('缓冲上限20/TTL10分钟，离线新增帧按FIFO补发而非任务结果缓存', async () => {
  const { transport, sockets, clock } = fixture()
  for (let i = 0; i < 21; i++) transport.sendUserMessage(`m${i}`, `${i}`)
  assert.equal(transport.getState().buffered, 20)
  clock.advance(600000)
  transport.sendUserMessage('fresh', 'new')
  assert.equal(transport.getState().buffered, 1)
  assert.equal(transport.getState().oldestTs, clock.time)
  transport.start(); greet(sockets[0]); await settle()
  assert.deepEqual(sockets[0].sent, [{ type: 'user_message', message_id: 'fresh', message: 'new' }])
  assert.equal(transport.getState().buffered, 0)
  transport.dispose()
})

test('未配置/非法基址前置失败，不启动网络/重试timer且配置提示统一', () => {
  for (const [opts, code] of [[{ backendUrl: '' }, NEED_SETUP], [{ apiKey: '' }, NEED_KEY], [{ backendUrl: 'https://h/?secret=1' }, TARGET]]) {
    const { transport, sockets, clock } = fixture(opts)
    transport.start()
    assert.equal(transport.getState().code, code)
    assert.equal(transport.getState().lastError, '请检查配置')
    assert.equal(transport.getState().ready, false)
    assert.equal(sockets.length, 0)
    assert.equal(clock.jobs.size, 0)
    transport.dispose()
  }
})

test('onStatus内stop也能fence正在open流程，不能留下hello/ping timer', () => {
  let transport
  const { sockets, clock, transport: target } = fixture({ onStatus: (state) => { if (state.status === 'open') transport.stop() } })
  transport = target
  transport.start(); sockets[0].open()
  assert.equal(transport.getState().status, 'closed')
  assert.equal(transport.getState().ready, false)
  assert.equal(clock.jobs.size, 0)
  transport.dispose()
})
