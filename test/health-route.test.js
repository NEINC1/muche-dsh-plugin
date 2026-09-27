/**
 * health-route.test.js — 统一健康口（0.6.0 WP2）。
 *
 * 锁：GET /api/muche/health 一次返回 configNs＋auth＋history＋ws；
 * 未配置时三段均为码不打网（无 key/无地址零 fetch）；非 GET 405；
 * 30s 缓存命中不重打（第二次同 payload）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { NEED_KEY, NEED_SETUP } from '../lib/errors.js'
import { registerRoutes } from '../lib/routes.js'

function routeCtx(config) {
  const handlers = {}
  return {
    ctx: {
      connection: { requestRejection: () => undefined },
      webServer: {
        register: ({ path, handler }) => {
          if (handlers[path]) throw new Error(`webserver: duplicate exact route "${path}"`)
          handlers[path] = handler
        },
      },
      get: (name) => (name === 'loader' ? undefined : undefined),
      effect: () => {},
      on: () => {},
    },
    handlers,
    config,
  }
}

function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(payload) { this.body = String(payload || '') },
  }
}

const getReq = { method: 'GET' }

test('未配置时三段均为码，零后端请求', async () => {
  const { ctx, handlers, config } = routeCtx({ backendUrl: '', apiKey: '', workspacePath: '' })
  registerRoutes(ctx, config)
  assert.ok(handlers['/api/muche/health'], '缺少 /api/muche/health 路由')
  const res = fakeRes()
  await handlers['/api/muche/health'](getReq, res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(typeof payload.configNs, 'string')
  assert.equal(payload.auth.code, NEED_KEY)
  assert.equal(payload.history.code, NEED_KEY)
  assert.equal(payload.ws.ok, false)
  assert.equal(payload.ws.stage, 'target')
})

test('缺地址时 history 段为 NEED_SETUP（非 NEED_KEY 顺序：先 key 后地址）', async () => {
  const { ctx, handlers, config } = routeCtx({ backendUrl: '', apiKey: 'muche_x', workspacePath: '' })
  registerRoutes(ctx, config)
  const res = fakeRes()
  await handlers['/api/muche/health'](getReq, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.history.code, NEED_SETUP)
})

test('非 GET/POST 405', async () => {
  const { ctx, handlers, config } = routeCtx({ backendUrl: '', apiKey: '', workspacePath: '' })
  registerRoutes(ctx, config)
  const res = fakeRes()
  await handlers['/api/muche/health']({ method: 'PUT', on: () => {} }, res)
  assert.equal(res.status, 405)
})

test('POST 候选值检查：key 必填，不写配置', async () => {
  const { ctx, handlers, config } = routeCtx({ backendUrl: '', apiKey: '', workspacePath: '' })
  registerRoutes(ctx, config)
  const post = (body) => ({
    method: 'POST',
    on: (ev, fn) => {
      if (ev === 'data') return
      if (ev === 'end') setImmediate(fn)
    },
  })
  const res = fakeRes()
  await handlers['/api/muche/health'](post(), res)
  assert.equal(res.status, 400)
})

test('30s 缓存：第二次同 payload（checkedAt 不变）', async () => {
  const { ctx, handlers, config } = routeCtx({ backendUrl: '', apiKey: '', workspacePath: '' })
  registerRoutes(ctx, config)
  const r1 = fakeRes()
  await handlers['/api/muche/health'](getReq, r1)
  const r2 = fakeRes()
  await handlers['/api/muche/health'](getReq, r2)
  assert.equal(JSON.parse(r1.body).checkedAt, JSON.parse(r2.body).checkedAt)
})

test('缓存绑配置指纹：换 key 即重算（不返回旧结论）', async () => {
  const config = { backendUrl: '', apiKey: '', workspacePath: '' }
  const { ctx, handlers } = routeCtx(config)
  registerRoutes(ctx, config)
  const r1 = fakeRes()
  await handlers['/api/muche/health'](getReq, r1)
  assert.equal(JSON.parse(r1.body).history.code, NEED_KEY)
  config.apiKey = 'muche_new'
  const r2 = fakeRes()
  await handlers['/api/muche/health'](getReq, r2)
  assert.equal(JSON.parse(r2.body).history.code, NEED_SETUP)
})
