/**
 * ws-diag.test.js — WS 链路探针守卫。
 *
 * 锁三条（实时通道排障口）：
 * ① 探针与代理用同一 backendUpgradeTarget（单真源）：带 /api 前缀的地址，
 *   探针打到的就是 `<前缀>/ws`，回包 pathPrefix 原样可见；
 * ② 哑 token 被后端拒绝（403）即判整段可达（ok=true），不建连接不占额度；
 * ③ 连不上的端口按段归因（tcp），配错的地址在发送前即回 target 段；
 *   回包永不带 token/key。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { probeBackendUpgrade } from '../lib/ws-proxy.js'

/** 假后端：upgrade 一律 403（模拟鉴权拒绝），记录收到的 path。 */
function fakeBackend() {
  const seen = []
  const server = http.createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket) => {
    seen.push(req.url)
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno')
    socket.destroy()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

test('哑 token 被拒即判可达：403 + 路径前缀保留 + 无 token 回显', async () => {
  const { server, port, seen } = await fakeBackend()
  try {
    const result = await probeBackendUpgrade(`http://127.0.0.1:${port}/api`, { timeoutMs: 3000 })
    assert.equal(result.ok, true)
    assert.equal(result.stage, 'backend-reached')
    assert.equal(result.status, 403)
    assert.equal(result.backend.host, '127.0.0.1')
    assert.equal(result.backend.pathPrefix, '/api')
    assert.equal(seen.length, 1)
    assert.ok(seen[0].startsWith('/api/ws?token='), `代理目标漂移：${seen[0]}`)
    const sentToken = new URL(seen[0], 'http://x').searchParams.get('token')
    assert.equal(sentToken, '__muche_ws_diag_probe__', '探针必须只带哑 token（真 key 永不发出）')
    const dumped = JSON.stringify(result)
    assert.ok(!/muche_|apiKey|token/i.test(dumped), '回包泄漏凭据字段')
  } finally {
    server.close()
  }
})

test('连不上的端口按段归因（tcp），不抛', async () => {
  const { server, port } = await fakeBackend()
  const closedPort = port
  server.close()
  await new Promise((r) => setTimeout(r, 100))
  const result = await probeBackendUpgrade(`http://127.0.0.1:${closedPort}`, { timeoutMs: 3000 })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'tcp')
  assert.ok(result.error, '无错误信息')
})

test('配错的地址在发送前即回 target 段', async () => {
  const result = await probeBackendUpgrade(':::::垃圾地址', { timeoutMs: 3000 })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'target')
})
