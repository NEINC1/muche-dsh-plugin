import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { probeBackendUpgrade } from '../lib/backend_ws.js'
import { TARGET } from '../lib/errors.js'

async function fakeBackend() {
  const seen = []
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, origin: req.headers.origin })
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, seen }
}
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

test('哑token 403只证明链路可达，root/任意path保留，无凭据回显、不伪造Origin', async () => {
  const { server, port, seen } = await fakeBackend()
  try {
    for (const prefix of ['', '/api', '/custom/prefix', '/ws/custom']) {
      const result = await probeBackendUpgrade(`http://127.0.0.1:${port}${prefix}`, { timeoutMs: 3000 })
      assert.equal(result.ok, true)
      assert.equal(result.stage, 'backend-reached')
      assert.equal(result.status, 403)
      assert.equal(result.backend.pathPrefix, prefix || '(根)')
      const target = new URL(seen.at(-1).url, 'http://x')
      assert.equal(target.pathname, prefix + '/ws')
      assert.equal(target.searchParams.get('token'), '__muche_ws_diag_probe__')
      assert.equal(seen.at(-1).origin, undefined)
      const dumped = JSON.stringify(result)
      assert.ok(!dumped.includes('__muche_ws_diag_probe__'))
      assert.ok(!dumped.includes('token'))
    }
  } finally { await close(server) }
})

test('关闭端口可靠归tcp，不抛也不泄露raw socket错误', async () => {
  const { server, port } = await fakeBackend()
  await close(server)
  const result = await probeBackendUpgrade(`http://127.0.0.1:${port}`, { timeoutMs: 3000 })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'tcp')
  assert.equal(result.error, '后端连接未建立')
})

test('非法协议、凭据、query/hash在发送前target失败且诊断也不能泄露输入', async () => {
  for (const base of [':::::垃圾地址', 'ftp://h/custom', 'https://user:private@h/path', 'https://h/?token=private', 'https://h/#private']) {
    const result = await probeBackendUpgrade(base)
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'target')
    assert.equal(result.code, TARGET)
    assert.equal(result.error, '请检查配置')
    assert.ok(!JSON.stringify(result).includes('private'))
  }
})
