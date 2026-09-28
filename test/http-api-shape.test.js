/**
 * http-api-shape.test.js — 后端回包形态分类（0.6.0，不兼容旧版）。
 *
 * 语义（WP0 实证后定稿）：
 *  - 归一保 /api，fetch 阶段 HTML 一律 UPSTREAM_HTML（网关/代理页），永不出 NOT_API；
 *  - NOT_API 只在归一阶段产生（错路径存盘/调用前即拦），见 backend-errors.test.js；
 *  - JSON 错误透传不动；网络异常分 NETWORK/TIMEOUT。
 * 旧 NOT_API-fetch 语义整删（用户确认不兼容旧版）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { UPSTREAM_HTML } from '../lib/errors.js'
import { __resetStackFetch, __setStackFetch, fetchJson } from '../lib/http.js'

async function withFetch(fn, body) {
  // 经内部 seam 注入（fetchJson 走传输单源，不再直读全局 fetch）。
  __setStackFetch(fn)
  try {
    return await body()
  } finally {
    __resetStackFetch()
  }
}

const html = (status = 200) => new Response('<html><body>spa</body></html>', {
  status,
  headers: { 'content-type': 'text/html' },
})

test('HTML 回包判 UPSTREAM_HTML（fetch 阶段永不出 NOT_API）', async () => {
  const res = await withFetch(async () => html(200), () => fetchJson('https://h/api/chat/history', {}))
  assert.equal(res.ok, false)
  assert.equal(res.code, UPSTREAM_HTML)
  assert.equal(res.hint, 'html')
  assert.equal(res.status, 200)
})

test('网关 502 HTML 同判 UPSTREAM_HTML（后端暂不可用，非地址问题）', async () => {
  const res = await withFetch(async () => html(502), () => fetchJson('https://h/api/chat', { method: 'POST' }))
  assert.equal(res.code, UPSTREAM_HTML)
  assert.equal(res.status, 502)
})

test('JSON 错误透传不动（额度/401 原样）', async () => {
  const denied = await withFetch(
    async () => new Response(JSON.stringify({ detail: '凭证无效' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    () => fetchJson('https://h/api/auth/me', {}),
  )
  assert.equal(denied.ok, false)
  assert.equal(denied.status, 401)
  assert.equal(denied.error, '凭证无效')
  assert.notEqual(denied.code, UPSTREAM_HTML)
})

test('网络异常分 NETWORK，超时分 TIMEOUT（不混为 UPSTREAM_HTML）', async () => {
  const down = await withFetch(
    async () => { throw new Error('socket hang up') },
    () => fetchJson('https://h/api/chat/history', {}),
  )
  assert.equal(down.ok, false)
  assert.ok(down.error.includes('请求失败'))
  assert.notEqual(down.code, UPSTREAM_HTML)
  const timeout = await withFetch(
    async () => { throw new DOMException('signal timed out', 'TimeoutError') },
    () => fetchJson('https://h/api/chat/history', {}),
  )
  assert.notEqual(timeout.code, UPSTREAM_HTML)
})
