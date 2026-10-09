import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelConnection, fingerprint } from '../lib/connections.js'

const idle = { status: 'idle', ready: false, lastError: '', code: '', closeCode: null, reason: '', retryable: false, buffered: 0, oldestTs: 0 }
function fakeFactory(created) {
  return (opts) => {
    const transport = {
      opts, starts: 0, disposed: false,
      state: { ...idle },
      start() { this.starts += 1; this.state = { ...idle, status: 'connecting' }; opts.onStatus?.(this.state) },
      dispose() {
        this.disposed = true
        this.state = { ...idle, status: 'closed' }
        opts.onStatus?.(this.state)
        opts.onTask?.({ type: 'dsh_task', task_id: 'during-disposal' })
      },
      getState() { return { ...this.state } },
    }
    created.push(transport)
    return transport
  }
}

test('缺key或缺base才停止，非法但非空base交传输分类', () => {
  const created = []
  const channel = new ChannelConnection({ createTransport: fakeFactory(created) })
  for (const [backendUrl, apiKey] of [['https://h', ''], ['', 'k'], ['  ', 'k'], ['https://h', '  ']]) assert.equal(channel.sync({ backendUrl, apiKey }), null)
  assert.equal(created.length, 0)
  const transport = channel.sync({ backendUrl: 'not a url', apiKey: 'k' })
  assert.equal(channel.current, transport)
  assert.equal(created.length, 1)
  channel.sync({ backendUrl: '', apiKey: 'k' })
  assert.equal(transport.disposed, true)
  assert.equal(channel.hasTransport, false)
})

test('同纹复用包括paused transport，不偷偷start重试', () => {
  const created = []
  const channel = new ChannelConnection({ createTransport: fakeFactory(created) })
  const a = channel.sync({ backendUrl: 'https://h', apiKey: 'k' })
  a.state = { ...idle, status: 'closed', code: 'FORBIDDEN', retryable: false }
  const b = channel.sync({ backendUrl: 'https://h', apiKey: 'k' })
  assert.equal(a, b)
  assert.equal(a.starts, 1)
  assert.equal(created.length, 1)
})

test('变纹换连，迟到的旧status/hello/业务回调不能影响新连接', () => {
  const created = []
  const channel = new ChannelConnection({ channel: 'dsh-bridge', createTransport: fakeFactory(created) })
  const statuses = []
  const seen = []
  const handlers = { onStatus: (state) => statuses.push(state), onHello: (frame) => seen.push(frame), onTask: (frame) => seen.push(frame), onReply: (frame) => seen.push(frame) }
  const old = channel.sync({ backendUrl: 'https://h', apiKey: 'k1', handlers })
  old.opts.onTask({ type: 'dsh_task', task_id: 'current-old' })
  const current = channel.sync({ backendUrl: 'https://h', apiKey: 'k2', handlers })
  assert.equal(old.disposed, true)
  assert.notEqual(old, current)
  assert.equal(current.opts.channel, 'dsh-bridge')
  assert.deepEqual(statuses.map((state) => state.status), ['connecting', 'closed', 'connecting'])
  const count = statuses.length
  old.opts.onStatus({ status: 'open', ready: true })
  old.opts.onHello({ type: 'hello' })
  old.opts.onTask({ type: 'dsh_task', task_id: 'late' })
  old.opts.onReply({ type: 'reply', text: 'late' })
  assert.equal(statuses.length, count)
  assert.equal(seen.length, 1)
  current.opts.onHello({ type: 'hello' })
  current.opts.onTask({ type: 'dsh_task', task_id: 'new' })
  assert.equal(seen.length, 3)
  assert.equal(channel.getState().status, 'connecting')
})

test('stop幂等，显式关闭仅通知一次，dispose终态不复活', () => {
  const created = []
  const states = []
  const channel = new ChannelConnection({ createTransport: fakeFactory(created) })
  const old = channel.sync({ backendUrl: 'https://h', apiKey: 'k', handlers: { onStatus: (state) => states.push(state) } })
  channel.stop()
  channel.stop()
  assert.equal(channel.current, null)
  assert.deepEqual(channel.getState(), idle)
  assert.deepEqual(states.map((state) => state.status), ['connecting', 'closed'])
  old.opts.onStatus({ status: 'open', ready: true })
  assert.equal(states.length, 2)
  assert.ok(channel.sync({ backendUrl: 'https://h', apiKey: 'k' }))
  channel.dispose()
  assert.equal(channel.sync({ backendUrl: 'https://h', apiKey: 'k' }), null)
  assert.equal(created.length, 2)
})

test('指纹含channel及无碰撞字段边界', () => {
  assert.notEqual(fingerprint('', 'https://h', 'k'), fingerprint('dsh-bridge', 'https://h', 'k'))
  assert.notEqual(fingerprint('', 'https://h/a|b', 'c'), fingerprint('', 'https://h/a', 'b|c'))
})

test('同步start回调内stop也必须返回已提交的空通道，不能交回退休transport', () => {
  const created = []
  const channel = new ChannelConnection({ createTransport: fakeFactory(created) })
  const result = channel.sync({ backendUrl: 'https://h', apiKey: 'k', handlers: { onStatus: (state) => { if (state.status === 'connecting') channel.stop() } } })
  assert.equal(result, null)
  assert.equal(channel.current, null)
  assert.equal(created[0].disposed, true)
})

test('停旧的显式状态通知若重入sync，后提交的配置必须胜出而非泄漏第三连接', () => {
  const created = []
  const channel = new ChannelConnection({ createTransport: fakeFactory(created) })
  const old = channel.sync({ backendUrl: 'https://h', apiKey: 'old', handlers: {
    onStatus: (state) => {
      if (state.status === 'closed') channel.sync({ backendUrl: 'https://h/newer', apiKey: 'newer' })
    },
  } })
  const current = channel.sync({ backendUrl: 'https://h/outer', apiKey: 'outer' })
  assert.equal(old.disposed, true)
  assert.equal(created.length, 2)
  assert.equal(current, channel.current)
  assert.equal(current.opts.backendUrl, 'https://h/newer')
  channel.dispose()
})

test('所有on回调接线行为不丢，传输参数不能从handlers篡改channel/base/key', () => {
  const created = []
  const channel = new ChannelConnection({ channel: '', createTransport: fakeFactory(created) })
  const seen = []
  const handlers = { channel: 'dsh-bridge', apiKey: 'bad', backendUrl: 'bad' }
  for (const name of ['onReply', 'onProactive', 'onDialogueUpdated', 'onError', 'onTask', 'onAppend', 'onDecide', 'onQuery', 'onHello', 'onHelloAck']) handlers[name] = (frame) => seen.push([name, frame])
  const transport = channel.sync({ backendUrl: 'https://h', apiKey: 'k', handlers })
  for (const name of Object.keys(handlers).filter((name) => name.startsWith('on'))) transport.opts[name]({ type: name })
  assert.equal(seen.length, 10)
  assert.equal(transport.opts.channel, '')
  assert.equal(transport.opts.backendUrl, 'https://h')
  assert.equal(transport.opts.apiKey, 'k')
  channel.stop()
  for (const name of Object.keys(handlers).filter((name) => name.startsWith('on'))) transport.opts[name]({ type: 'late' })
  assert.equal(seen.length, 10)
})
