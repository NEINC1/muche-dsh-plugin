import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApiUrl, normalizeBackendUrl } from '../lib/backend.js'
import { buildBackendWsUrl } from '../lib/backend_ws.js'
import { NEED_SETUP, TARGET } from '../lib/errors.js'

const fixtures = [
  ['http://127.0.0.1:8000', 'http://127.0.0.1:8000/ws', '/ws'],
  ['https://example.com/', 'https://example.com/ws', '/ws'],
  ['http://example.com/api/', 'http://example.com/api/ws', '/api/ws'],
  ['https://example.com/muche/v2', 'https://example.com/muche/v2/ws', '/muche/v2/ws'],
  ['https://example.com/any%2Fprefix/', 'https://example.com/any%2Fprefix/ws', '/any%2Fprefix/ws'],
  ['http://[::1]:8000/custom', 'http://[::1]:8000/custom/ws', '/custom/ws'],
]

test('HTTP与WS共用基址规则，root和任意部署前缀一致', () => {
  for (const [base, httpUrl, pathname] of fixtures) {
    assert.equal(normalizeBackendUrl(base).ok, true)
    assert.equal(buildApiUrl(base, '/ws').url, httpUrl)
    const target = buildBackendWsUrl(base, 'k')
    const wsUrl = new URL(target.url)
    assert.equal(wsUrl.pathname, pathname)
    assert.equal(target.path, pathname + '?token=k')
    assert.equal(wsUrl.protocol, base.startsWith('https:') ? 'wss:' : 'ws:')
    wsUrl.protocol = target.secure ? 'https:' : 'http:'
    wsUrl.search = ''
    assert.equal(wsUrl.href, httpUrl)
  }
})

test('https默认443，http默认80，显式端口不丢', () => {
  assert.equal(buildBackendWsUrl('https://example.com/custom', 'k').port, 443)
  assert.equal(buildBackendWsUrl('http://example.com', 'k').port, 80)
  assert.equal(buildBackendWsUrl('https://example.com:8443/custom', 'k').port, '8443')
})

test('token/channel正确编码，面板空channel不冒充桥接池', () => {
  const token = 'a b&c=/#中文'
  const panel = buildBackendWsUrl('https://example.com/custom/', token, '')
  assert.equal(panel.path, '/custom/ws?token=' + encodeURIComponent(token))
  assert.equal(new URL(panel.url).searchParams.get('token'), token)
  assert.equal(new URL(panel.url).searchParams.has('channel'), false)
  assert.equal(new URL(buildBackendWsUrl('https://example.com', 'k', 'dsh-bridge').url).searchParams.get('channel'), 'dsh-bridge')
})

test('HTTP/WS在发请求前拒绝同一批非法基址，不剥掉query/hash/凭据', () => {
  for (const base of ['', 'not a url', 'ftp://example.com/api', 'ws://example.com', 'https://user:private@example.com/path', 'https://example.com/path?private=1', 'https://example.com/path#private']) {
    const expected = base ? TARGET : NEED_SETUP
    assert.equal(buildApiUrl(base, '/ws').code, expected)
    assert.throws(() => buildBackendWsUrl(base, 'k'), (error) => error.code === expected && error.message === '请检查配置')
  }
})
