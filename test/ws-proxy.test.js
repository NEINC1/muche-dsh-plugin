/** ws-proxy 升级缓冲方向回归测试 + 后端 upgrade 目标回归测试。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pipeBoth, backendUpgradeTarget } from '../lib/ws-proxy.js'

function endpoint() {
  return {
    writes: [],
    handlers: {},
    on(event, fn) { this.handlers[event] = fn },
    write(value) { this.writes.push(value) },
    pipe(target) { this.pipeTarget = target },
    destroy() { this.destroyed = true },
  }
}

test('升级 head 按来源转发，避免 WebSocket masking 被污染', () => {
  const browser = endpoint()
  const backend = endpoint()
  const browserHead = Buffer.from('browser-frame')
  const backendHead = Buffer.from('backend-frame')

  pipeBoth(browser, backend, browserHead, backendHead)

  assert.deepEqual(backend.writes, [browserHead])
  assert.deepEqual(browser.writes, [backendHead])
  assert.equal(browser.pipeTarget, backend)
  assert.equal(backend.pipeTarget, browser)
})

// 根因回归：backendUrl 的 path（远端 /api 前缀）必须原样保留，
// 否则远端 WS 落到 nginx SPA 首页而永远握手失败。
test('同机直连：upgrade 打后端 /ws', () => {
  const t = backendUpgradeTarget('http://127.0.0.1:8000', 'k1')
  assert.equal(t.secure, false)
  assert.equal(t.host, '127.0.0.1')
  assert.equal(String(t.port), '8000')
  assert.equal(t.path, '/ws?token=k1')
})

test('远端反代：/api 前缀保留，upgrade 打后端 /api/ws', () => {
  const t = backendUpgradeTarget('http://124.222.23.51/api', 'k2')
  assert.equal(t.secure, false)
  assert.equal(t.host, '124.222.23.51')
  assert.equal(String(t.port), '80')
  assert.equal(t.path, '/api/ws?token=k2')
})

test('远端反代：末尾斜杠归一后仍保留 /api', () => {
  const t = backendUpgradeTarget('http://124.222.23.51/api/', 'k3')
  assert.equal(t.path, '/api/ws?token=k3')
})

test('https 后端：走安全通道且默认 443', () => {
  const t = backendUpgradeTarget('https://example.com/muche', 'k4')
  assert.equal(t.secure, true)
  assert.equal(String(t.port), '443')
  assert.equal(t.path, '/muche/ws?token=k4')
})

test('token 按 query 编码', () => {
  const t = backendUpgradeTarget('http://127.0.0.1:8000', 'a b&c=')
  assert.equal(t.path, '/ws?token=' + encodeURIComponent('a b&c='))
})

test('非法后端地址抛错（调用方收口为断开，不崩进程）', () => {
  assert.throws(() => backendUpgradeTarget('not a url', 'k'))
})
