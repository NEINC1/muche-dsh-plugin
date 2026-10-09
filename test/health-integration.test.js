/**
 * health-integration.test.js — 穿真实路由的集成锁（0.6.0 WP4）。
 *
 * 用本地 stub 后端走 registerRoutes 的真 handler：health 三段全形、
 * POST 候选值错地址即拦（零 fetch）、history 非法游标 422→CURSOR_INVALID。
 * 后端零改动约束下，本文件是插件侧能摸到的最深证据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { CURSOR_INVALID, NOT_API } from '../lib/errors.js'
import { registerRoutes } from '../lib/routes.js'

const mode = { history422: false }

function stubBackend() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    // 模拟 nginx 剥 /api 前缀后的后端视角。
    const pathname = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/'
    if (pathname === '/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ user_id: 'u-int', role: 'user', public_base_url: 'https://公网' }))
      return
    }
    if (pathname === '/chat') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ messages: ['你好'], inner_thought: '', degraded: false }))
      return
    }
    if (pathname === '/chat/history') {
      if (mode.history422) {
        res.writeHead(422, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: '非法游标' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ messages: [], has_more: false, next_before: '' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ detail: 'x' }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function harness(config) {
  const handlers = {}
  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer: {
      register: ({ path, handler }) => {
        if (handlers[path]) throw new Error(`duplicate ${path}`)
        handlers[path] = handler
      },
    },
    get: () => undefined,
    effect: () => {},
    on: () => {},
  }
  registerRoutes(ctx, config)
  return handlers
}

function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(payload) { this.body = String(payload || '') },
  }
}

function postReq(body) {
  const text = JSON.stringify(body)
  return {
    method: 'POST',
    url: '/',
    on: (ev, fn) => {
      if (ev === 'data') fn(Buffer.from(text))
      if (ev === 'end') setImmediate(fn)
    },
  }
}

test('health GET 三段全形：auth 过＋history 过＋ws 段定位 /api', async () => {
  const { server, port } = await stubBackend()
  try {
    const handlers = harness({ backendUrl: `http://127.0.0.1:${port}/api`, apiKey: 'muche_k', workspacePath: '' })
    const res = fakeRes()
    await handlers['/api/muche/health']({ method: 'GET' }, res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.auth.ok, true)
    assert.equal(body.auth.userId, 'u-int')
    assert.equal(body.history.ok, true)
    assert.equal(body.ws.backend.pathPrefix, '/api')
    assert.ok(Array.isArray(body.status.fibers))
  } finally {
    server.close()
  }
})

test('health POST 候选值：三种失败各按真实事实分类，不猜地址形态', async () => {
  const { server, port } = await stubBackend()
  try {
    const handlers = harness({ backendUrl: `http://127.0.0.1:${port}/api`, apiKey: 'muche_k', workspacePath: '' })
    // A syntactically impossible target is rejected locally, before any socket.
    const unusable = fakeRes()
    await handlers['/api/muche/health'](postReq({ backendUrl: 'not a url', apiKey: 'muche_k' }), unusable)
    const unusableBody = JSON.parse(unusable.body)
    assert.equal(unusableBody.auth.code, 'TARGET')
    assert.equal(unusableBody.history.code, 'TARGET')
    assert.notEqual(unusableBody.auth.code, NOT_API, '插件无权替用户判定地址形态')
    // A well-formed but unreachable host is a connection fact, not a configuration verdict.
    const unreachable = fakeRes()
    await handlers['/api/muche/health'](postReq({ backendUrl: 'http://127.0.0.1:59999/api', apiKey: 'muche_k' }), unreachable)
    assert.equal(JSON.parse(unreachable.body).auth.kind, 'connection')
    const good = fakeRes()
    await handlers['/api/muche/health'](postReq({ backendUrl: `http://127.0.0.1:${port}/api`, apiKey: 'muche_k' }), good)
    assert.equal(JSON.parse(good.body).auth.ok, true, '候选值不写回运行配置，但自身可验证')
    assert.equal(JSON.parse(good.body).mode, 'candidate')
  } finally {
    server.close()
  }
})

test('chat 转发：文本透传＋message_id 透传', async () => {
  const { server, port } = await stubBackend()
  try {
    const handlers = harness({ backendUrl: `http://127.0.0.1:${port}/api`, apiKey: 'muche_k', workspacePath: '' })
    const res = fakeRes()
    await handlers['/api/muche/chat'](
      postReq({ text: 'hi', message_id: 'm-1' }),
      res,
    )
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.deepEqual(body.messages, ['你好'])
  } finally {
    server.close()
  }
})

test('history 非法游标 422→CURSOR_INVALID（面板回最新页，不红字）', async () => {
  const { server, port } = await stubBackend()
  mode.history422 = true
  try {
    const handlers = harness({ backendUrl: `http://127.0.0.1:${port}/api`, apiKey: 'muche_k', workspacePath: '' })
    const res = fakeRes()
    await handlers['/api/muche/history'](
      { method: 'GET', url: '/api/muche/history?limit=5&before=xxx' },
      res,
    )
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.code, CURSOR_INVALID)
  } finally {
    mode.history422 = false
    server.close()
  }
})
