/**
 * panel-events.test.js — 面板事件下行（SSE 替代通道）守卫。
 *
 * 锁六条（dsh-app:// 页原生 WS 不可用，SSE 是唯一实时下行）：
 * ① 无 key 不建上游（401 在路由层，前置断言 hub 同样拒绝）；
 * ② 上游是面板池（channel 空串，与直连同额度，不挤占桥接）＋配置现读透传；
 * ③ 空 channel 的真实建连 URL 不带 channel 参数（后端判面板池）；
 * ④ 上游帧原样扇出为 SSE data 行；
 * ⑤ 末位退订即拆上游（额度即时释放）；
 * ⑥ 配置变化重建上游（换 key 不串户）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'

import { BackendWs } from '../lib/backend_ws.js'

import { createPanelEventsHub } from '../lib/panel-events.js'

function fakeRes() {
  const handlers = {}
  return {
    written: [],
    ended: false,
    write(chunk) { this.written.push(String(chunk)) },
    on(event, fn) { handlers[event] = fn },
    end() { this.ended = true },
    fireClose() { if (handlers.close) handlers.close() },
  }
}

function harness() {
  const created = []
  const hub = createPanelEventsHub({
    createUpstream: (opts) => {
      const up = {
        opts,
        started: false,
        disposed: false,
        start() { this.started = true },
        dispose() { this.disposed = true },
        emit(type, frame) {
          if (type === 'reply' && opts.onReply) opts.onReply(frame)
          if (type === 'proactive' && opts.onProactive) opts.onProactive(frame)
          if (type === 'error' && opts.onError) opts.onError(frame)
        },
      }
      created.push(up)
      return up
    },
  })
  return { hub, created }
}

const CFG = { backendUrl: 'https://公网/api', apiKey: 'muche_k', workspacePath: '' }

test('无 key 不建上游', () => {
  const { hub, created } = harness()
  assert.equal(hub.subscribe(fakeRes(), { backendUrl: 'https://公网/api', apiKey: '' }), false)
  assert.equal(created.length, 0)
  assert.equal(hub.hasUpstream, false)
})

test('上游进面板池＋配置透传＋订阅者收 hello', () => {
  const { hub, created } = harness()
  const res = fakeRes()
  assert.equal(hub.subscribe(res, CFG), true)
  assert.equal(created.length, 1)
  assert.equal(created[0].opts.channel, '', '上游必须进面板池（空 channel），禁挤占桥接池')
  assert.equal(created[0].opts.backendUrl, CFG.backendUrl)
  assert.equal(created[0].opts.apiKey, CFG.apiKey)
  assert.equal(created[0].started, true)
  assert.ok(res.written.some((line) => line.includes('"hello"')), '订阅者未收到 hello')
  assert.equal(hub.subscriberCount, 1)
})

test('上游帧原样扇出 SSE data 行', () => {
  const { hub, created } = harness()
  const a = fakeRes()
  const b = fakeRes()
  hub.subscribe(a, CFG)
  hub.subscribe(b, CFG)
  assert.equal(created.length, 1, '同配置多订阅者必须复用同一上游')
  created[0].emit('proactive', { type: 'proactive', messages: ['主动消息'] })
  for (const res of [a, b]) {
    const last = res.written[res.written.length - 1]
    assert.ok(last.startsWith('data: '), `非 SSE 行：${last}`)
    assert.deepEqual(JSON.parse(last.slice('data: '.length)), { type: 'proactive', messages: ['主动消息'] })
  }
})

test('末位退订即拆上游', () => {
  const { hub, created } = harness()
  const a = fakeRes()
  const b = fakeRes()
  hub.subscribe(a, CFG)
  hub.subscribe(b, CFG)
  a.fireClose()
  assert.equal(hub.hasUpstream, true, '还有订阅者不应拆上游')
  b.fireClose()
  assert.equal(hub.hasUpstream, false, '末位退订必须拆上游（释放面板额度）')
  assert.equal(created[0].disposed, true)
  assert.equal(hub.subscriberCount, 0)
})

test('配置变化重建上游（换 key 不串户）', () => {
  const { hub, created } = harness()
  hub.subscribe(fakeRes(), CFG)
  hub.subscribe(fakeRes(), { ...CFG, apiKey: 'muche_new' })
  assert.equal(created.length, 2, '配置变化必须重建上游')
  assert.equal(created[0].disposed, true, '旧上游必须释放')
  assert.equal(created[1].opts.apiKey, 'muche_new')
})

test('空 channel 真实建连 URL 不带 channel 参数（后端判面板池）', async () => {
  const seen = []
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  server.on('connection', (sock, req) => {
    seen.push(req.url)
    sock.close()
  })
  await new Promise((resolve) => server.on('listening', resolve))
  const port = server.address().port
  const panel = new BackendWs({ backendUrl: `http://127.0.0.1:${port}`, apiKey: 'k', channel: '' })
  const bridge = new BackendWs({ backendUrl: `http://127.0.0.1:${port}`, apiKey: 'k' })
  try {
    panel.start()
    bridge.start()
    const deadline = Date.now() + 3000
    while (seen.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(seen.length, 2, '两条上游都应到达假后端')
    const panelUrl = seen.find((u) => !u.includes('channel='))
    assert.ok(panelUrl, `面板池 URL 必须无 channel 参数：${JSON.stringify(seen)}`)
    assert.ok(panelUrl.includes('/ws?token='), `面板池 URL 形态漂移：${panelUrl}`)
    assert.ok(seen.some((u) => u.includes('channel=dsh-bridge')), '桥接默认通道回归断裂')
  } finally {
    panel.dispose()
    bridge.dispose()
    server.close()
  }
})
