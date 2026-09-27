/**
 * connections.test.js — 连接生命周期唯一 Owner（0.6.0）。
 *
 * 锁：无 key 不建、同纹复用、变纹重建、停即 dispose、指纹含 channel 防串池、
 * handlers 直透传输构造。深度审查结论：双槽 Manager 系过度抽象已删，
 * 各模块直持 ChannelConnection，纤程注册归各模块 fiber 闭包。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ChannelConnection, fingerprint } from '../lib/connections.js'

function fakeFactory(created) {
  return (opts) => {
    const t = {
      opts,
      started: false,
      disposed: false,
      start() { this.started = true },
      dispose() { this.disposed = true },
      getState() { return { status: 'open', lastError: '', buffered: 0, oldestTs: 0 } },
    }
    created.push(t)
    return t
  }
}

test('无 key 不建且停旧', () => {
  const created = []
  const ch = new ChannelConnection({ channel: '', createTransport: fakeFactory(created) })
  assert.equal(ch.sync({ backendUrl: 'https://h/api', apiKey: '' }), null)
  assert.equal(created.length, 0)
  assert.equal(ch.hasTransport, false)
})

test('同纹复用（不重建不断连）', () => {
  const created = []
  const ch = new ChannelConnection({ channel: '', createTransport: fakeFactory(created) })
  const a = ch.sync({ backendUrl: 'https://h/api', apiKey: 'k', handlers: {} })
  const b = ch.sync({ backendUrl: 'https://h/api', apiKey: 'k', handlers: {} })
  assert.equal(a, b)
  assert.equal(created.length, 1)
})

test('变纹重建（旧 dispose，新 start，channel 固定面板池）', () => {
  const created = []
  const ch = new ChannelConnection({ channel: '', createTransport: fakeFactory(created) })
  const a = ch.sync({ backendUrl: 'https://h/api', apiKey: 'k1', handlers: {} })
  const b = ch.sync({ backendUrl: 'https://h/api', apiKey: 'k2', handlers: {} })
  assert.notEqual(a, b)
  assert.equal(a.disposed, true)
  assert.equal(b.started, true)
  assert.equal(b.opts.channel, '')
  assert.equal(created.length, 2)
})

test('stop 幂等且 getState 回 idle', () => {
  const created = []
  const ch = new ChannelConnection({ channel: 'dsh-bridge', createTransport: fakeFactory(created) })
  const t = ch.sync({ backendUrl: 'https://h/api', apiKey: 'k', handlers: {} })
  assert.equal(ch.current, t)
  ch.stop()
  ch.stop()
  assert.equal(ch.current, null)
  assert.equal(ch.hasTransport, false)
  assert.deepEqual(ch.getState(), { status: 'idle', lastError: '', buffered: 0, oldestTs: 0 })
})

test('指纹含 channel（面板与桥接同地址同 key 不串池）', () => {
  assert.notEqual(
    fingerprint('', 'https://h/api', 'k'),
    fingerprint('dsh-bridge', 'https://h/api', 'k'),
  )
})

test('handlers 直透传输构造（桥接回调不丢）', () => {
  const created = []
  const ch = new ChannelConnection({ channel: 'dsh-bridge', createTransport: fakeFactory(created) })
  const handlers = { onTask: () => {}, onAppend: () => {}, onDecide: () => {}, onStatus: () => {} }
  const t = ch.sync({ backendUrl: 'https://h/api', apiKey: 'k', handlers })
  assert.equal(t, ch.current)
  for (const key of Object.keys(handlers)) {
    assert.equal(t.opts[key], handlers[key], `handlers.${key} 未透传`)
  }
  assert.equal(t.opts.channel, 'dsh-bridge')
})
