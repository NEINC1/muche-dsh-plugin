/**
 * backend-ws-url.test.js — 到后端 upgrade 目标构造守卫（OI-078 收口）。
 *
 * backendUpgradeTarget 与 BackendWs 私有 #wsUrl 同语义两遍实现，
 * 收口为 backend_ws.js 唯一导出 buildBackendWsUrl（桥接/上游/探针共用）。
 * 锁：path 前缀保留（丢 /api 即落 SPA 首页）/ https 通道 / token 编码 /
 * 非法与空地址抛错（调用方收口，空地址＝未配置）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildBackendWsUrl } from '../lib/backend_ws.js'

// 根因回归：backendUrl 的 path（远端 /api 前缀）必须原样保留，
// 否则远端 WS 落到 nginx SPA 首页而永远握手失败。
test('同机直连：upgrade 打后端 /ws', () => {
  const t = buildBackendWsUrl('http://127.0.0.1:8000', 'k1')
  assert.equal(t.secure, false)
  assert.equal(t.host, '127.0.0.1')
  assert.equal(String(t.port), '8000')
  assert.equal(t.path, '/ws?token=k1')
  assert.equal(t.url, 'ws://127.0.0.1:8000/ws?token=k1')
})

test('远端反代：/api 前缀保留，upgrade 打后端 /api/ws', () => {
  const t = buildBackendWsUrl('http://124.222.23.51/api', 'k2')
  assert.equal(t.secure, false)
  assert.equal(t.host, '124.222.23.51')
  assert.equal(String(t.port), '80')
  assert.equal(t.path, '/api/ws?token=k2')
})

test('远端反代：末尾斜杠归一后仍保留 /api', () => {
  const t = buildBackendWsUrl('http://124.222.23.51/api/', 'k3')
  assert.equal(t.path, '/api/ws?token=k3')
})

test('https 后端：走安全通道且默认 443', () => {
  const t = buildBackendWsUrl('https://example.com/muche', 'k4')
  assert.equal(t.secure, true)
  assert.equal(String(t.port), '443')
  assert.equal(t.path, '/muche/ws?token=k4')
  assert.ok(t.url.startsWith('wss://'))
})

test('token 按 query 编码', () => {
  const t = buildBackendWsUrl('http://127.0.0.1:8000', 'a b&c=')
  assert.equal(t.path, '/ws?token=' + encodeURIComponent('a b&c='))
})

test('面板池无 channel 参数；桥接带 channel', () => {
  assert.ok(!buildBackendWsUrl('http://127.0.0.1:8000', 'k', '').path.includes('channel='))
  assert.ok(buildBackendWsUrl('http://127.0.0.1:8000', 'k', 'dsh-bridge').path.includes('channel=dsh-bridge'))
})

test('非法与空地址抛错（调用方收口为断开，不崩进程）', () => {
  assert.throws(() => buildBackendWsUrl('not a url', 'k'))
  assert.throws(() => buildBackendWsUrl('', 'k'), /未配后端地址/)
})
