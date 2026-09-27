/**
 * backend-errors.test.js — 新真源契约（0.6.0 WP1）。
 *
 * 锁：归一/拼装/形态判定/上游分类四函数同一套 fixture；
 * Client 镜像实现须跑同一套断言（双边一致，防分叉）。
 * 旧 http-api-shape.test.js 在 WP4 改锁 code 后删除，两者共存期间互不碰。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildApiUrl, missingApiSuffix, normalizeBackendUrl } from '../lib/backend.js'
import {
  AUTH_FAILED,
  CURSOR_INVALID,
  NEED_KEY,
  NEED_SETUP,
  NETWORK,
  NOT_API,
  QUOTA,
  TIMEOUT,
  UPSTREAM_HTML,
  classifyUpstream,
  err,
} from '../lib/errors.js'

test('归一：空即 NEED_SETUP，不回落不静默', () => {
  for (const raw of ['', '   ', undefined, null]) {
    const r = normalizeBackendUrl(raw)
    assert.equal(r.ok, false)
    assert.equal(r.code, NEED_SETUP)
  }
})

test('归一：根路径自动补 /api 并举 fixed', () => {
  const r = normalizeBackendUrl('https://h')
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://h/api')
  assert.equal(r.fixed, true)
  const slash = normalizeBackendUrl('https://h/api/')
  assert.equal(slash.ok, true)
  assert.equal(slash.url, 'https://h/api')
  assert.equal(slash.fixed, false)
})

test('归一：/api 结尾通过，大小写与前后空白归一', () => {
  const r = normalizeBackendUrl('  https://h/api  ')
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://h/api')
})

test('归一：非 /api 路径判 NOT_API，不静默拼接', () => {
  const r = normalizeBackendUrl('https://h/wrong')
  assert.equal(r.ok, false)
  assert.equal(r.code, NOT_API)
  assert.ok(r.error.includes('/api'))
})

test('归一：非法 URL 与非 http(s) 判 TARGET，不归 NOT_API', () => {
  for (const raw of ['not a url', 'ftp://h/api', 'ws://h/api']) {
    const r = normalizeBackendUrl(raw)
    assert.equal(r.ok, false)
    assert.notEqual(r.code, NOT_API)
  }
})

test('归一：http 标记 insecure 但不断连（dev 放行，面板警告）', () => {
  const r = normalizeBackendUrl('http://h/api')
  assert.equal(r.ok, true)
  assert.equal(r.insecure, true)
})

test('拼装：失败透传 code，成功拼接', () => {
  const bad = buildApiUrl('https://h/wrong', '/chat/history')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, NOT_API)
  const good = buildApiUrl('https://h/api/', 'chat/history?limit=1')
  assert.equal(good.ok, true)
  assert.equal(good.url, 'https://h/api/chat/history?limit=1')
})

test('形态判定：空不警告、根警告、/api 放行、错路径警告、非法不抢报错', () => {
  assert.equal(missingApiSuffix(''), false)
  assert.equal(missingApiSuffix('https://h'), true)
  assert.equal(missingApiSuffix('https://h/'), true)
  assert.equal(missingApiSuffix('https://h/api'), false)
  assert.equal(missingApiSuffix('https://h/api/'), false)
  assert.equal(missingApiSuffix('https://h/wrong'), true)
  assert.equal(missingApiSuffix('not a url'), false)
})

test('上游分类：HTML 一律 UPSTREAM_HTML（归一已保 /api，fetch 阶段无 NOT_API）', () => {
  const page = classifyUpstream({ status: 200, contentType: 'text/html', text: '<html>spa' })
  assert.equal(page.ok, false)
  assert.equal(page.code, UPSTREAM_HTML)
  assert.equal(page.hint, 'html')
  const gateway = classifyUpstream({ status: 502, contentType: 'text/html', text: '<html>502' })
  assert.equal(gateway.code, UPSTREAM_HTML)
  assert.equal(gateway.status, 502)
  const plain = classifyUpstream({ status: 503, contentType: 'text/plain', text: 'oops' })
  assert.equal(plain.code, UPSTREAM_HTML)
  assert.equal(plain.hint, 'non-json')
})

test('错误体形状稳定：9 码全导出，err 工厂透传 extra', () => {
  for (const code of [NEED_SETUP, NEED_KEY, AUTH_FAILED, NOT_API, UPSTREAM_HTML, NETWORK, TIMEOUT, CURSOR_INVALID, QUOTA]) {
    assert.equal(typeof code, 'string')
  }
  const e = err(NEED_KEY, 'msg', { status: 401 })
  assert.deepEqual(e, { ok: false, code: NEED_KEY, error: 'msg', status: 401 })
})
