/**
 * http-api-shape.test.js — 后端地址形态精确诊断（全员远端唯一口径）。
 *
 * 锁：地址少了 /api 会打到 SPA 首页回 HTML（GET 200 / POST 405），
 * fetchJson 必须识别为 NOT_API 并给出可操作指引，不再报无差别的
 * "响应解析失败"。JSON 错误透传语义不动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchJson, NOT_API, notApiError } from '../lib/http.js'

function withFetch(fn, body) {
  const prev = globalThis.fetch
  globalThis.fetch = fn
  try {
    return body()
  } finally {
    globalThis.fetch = prev
  }
}

const html = (status = 200) => new Response('<html><body>spa</body></html>', {
  status,
  headers: { 'content-type': 'text/html' },
})

test('HTML 回包判 NOT_API 并指 /api 后缀', async () => {
  const res = await withFetch(async () => html(200), () => fetchJson('https://h/chat/history', {}))
  assert.equal(res.ok, false)
  assert.equal(res.code, NOT_API)
  assert.ok(res.error.includes('/api'), `指引未提 /api 后缀：${res.error}`)
  assert.equal(res.status, 200)
})

test('POST 405 HTML 同样判 NOT_API', async () => {
  const res = await withFetch(async () => html(405), () => fetchJson('https://h/chat', { method: 'POST' }))
  assert.equal(res.code, NOT_API)
})

test('JSON 错误透传不动（额度/401 原样）', async () => {
  const denied = await withFetch(
    async () => new Response(JSON.stringify({ detail: '凭证无效' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    () => fetchJson('https://h/api/auth/me', {}),
  )
  assert.equal(denied.ok, false)
  assert.equal(denied.status, 401)
  assert.equal(denied.error, '凭证无效')
  assert.notEqual(denied.code, NOT_API)
})

test('网络异常仍报请求失败（不误判 NOT_API）', async () => {
  const res = await withFetch(
    async () => { throw new Error('socket hang up') },
    () => fetchJson('https://h/api/chat/history', {}),
  )
  assert.equal(res.ok, false)
  assert.ok(res.error.includes('请求失败'))
  assert.notEqual(res.code, NOT_API)
})

test('notApiError 文案稳定（面板与测试页同源）', () => {
  const e = notApiError()
  assert.equal(e.code, NOT_API)
  assert.ok(e.error.includes('https://公网地址/api'))
})
