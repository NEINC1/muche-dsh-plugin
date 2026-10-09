import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTH_FAILED, FORBIDDEN, HTTP_ERROR, INPUT_INVALID, INVALID_RESPONSE, NEED_KEY, NETWORK, QUOTA, RATE_LIMITED, TARGET, TIMEOUT, UPSTREAM_HTML, classifyFailure } from '../lib/errors.js'
import { __resetStackFetch, __setStackFetch, backendCallRaw, fetchBinary, fetchJson } from '../lib/http.js'

async function withFetch(fn, body) {
  __setStackFetch(fn)
  try { return await body() } finally { __resetStackFetch() }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const html = (status = 200) => new Response('<html>private upstream text</html>', { status, headers: { 'content-type': 'text/html' } })

test('后端请求root/任意前缀均保持HTTP基址，携带key/body/signal，不暗加/api', async () => {
  const signal = new AbortController().signal
  const seen = []
  await withFetch(async (url, init) => { seen.push({ url, init }); return json({ accepted: true }) }, async () => {
    for (const [base, url] of [['https://h', 'https://h/chat'], ['https://h/custom/', 'https://h/custom/chat']]) {
      const result = await backendCallRaw({ base, apiKey: 'test-key', method: 'POST', path: '/chat', body: { message: 'hello' }, signal })
      assert.equal(result.ok, true)
      assert.equal(seen.at(-1).url, url)
      assert.equal(seen.at(-1).init.headers.Authorization, 'Bearer test-key')
      assert.equal(seen.at(-1).init.body, '{"message":"hello"}')
      assert.equal(seen.at(-1).init.signal, signal)
    }
  })
})

test('配置失败在fetch前返回安全码，任何旧hint都不能覆盖固定配置提示', async () => {
  let calls = 0
  await withFetch(async () => { calls += 1; return json({}) }, async () => {
    const bad = await backendCallRaw({ base: 'https://h/?secret=1', apiKey: 'test-key', path: '/chat' })
    assert.equal(bad.code, TARGET)
    const noKey = await backendCallRaw({ base: 'https://h', apiKey: '', path: '/chat', needKeyHint: 'key已过期' })
    assert.equal(noKey.code, NEED_KEY)
    assert.equal(noKey.error, '请检查配置')
    assert.equal(calls, 0)
  })
})

test('401映AUTH_FAILED不宣称过期，403映FORBIDDEN不误当认证失效', async () => {
  for (const [status, code, kind] of [[401, AUTH_FAILED, 'config'], [403, FORBIDDEN, 'access']]) {
    for (const response of [() => json({ detail: 'API key 已过期 private' }, status), () => html(status)]) {
      const result = await withFetch(async () => response(), () => backendCallRaw({ base: 'https://h', apiKey: 'test-key', path: '/auth/me' }))
      assert.equal(result.status, status)
      assert.equal(result.code, code)
      assert.equal(classifyFailure(result).kind, kind)
      assert.equal(classifyFailure(result).retryable, false)
      assert.ok(!result.error.includes('过期'))
      assert.ok(!result.error.includes('private'))
    }
  }
})

test('明确detail/top-level code及status/reset_at保留，未知HTTP操作安全提示', async () => {
  const cases = [
    [{ detail: { code: 'message_quota_exhausted', message: 'private', reset_at: 'later' } }, 429, 'message_quota_exhausted', 'quota'],
    [{ code: 'SPECIFIC_FAILURE', error: 'fetch failed token=private' }, 503, 'SPECIFIC_FAILURE', 'operation'],
    [{ detail: 'rate limit' }, 429, RATE_LIMITED, 'operation'],
    [{ detail: 'raw internal trace' }, 503, HTTP_ERROR, 'operation'],
    [{ detail: 'validation trace' }, 422, HTTP_ERROR, 'operation'],
    [{ ok: false, code: QUOTA, error: 'private' }, 200, QUOTA, 'quota'],
  ]
  for (const [payload, status, code, kind] of cases) {
    const result = await withFetch(async () => json(payload, status), () => fetchJson('https://h/custom/chat'))
    assert.equal(result.ok, false)
    assert.equal(result.status, status)
    assert.equal(result.code, code)
    assert.equal(classifyFailure(result).kind, kind)
    assert.ok(!result.error.includes('private'))
    assert.ok(!result.error.includes('trace'))
    if (payload.detail?.reset_at) assert.equal(result.reset_at, 'later')
  }
  const input = await withFetch(async () => json({ detail: { code: INPUT_INVALID, message: '请缩小图片' } }, 422), () => fetchJson('https://h/chat'))
  assert.equal(input.error, '请缩小图片')
})

test('HTML/非JSON/原始JSON形态明确分类，不暴露正文', async () => {
  const spa = await withFetch(async () => html(), () => fetchJson('https://h/custom/history'))
  assert.equal(spa.code, UPSTREAM_HTML)
  assert.equal(spa.error, '连接暂时中断，正在重连')
  assert.equal(spa.hint, 'html')
  const plain = await withFetch(async () => new Response('raw fetch failure', { status: 503 }), () => fetchJson('https://h/chat'))
  assert.equal(plain.code, INVALID_RESPONSE)
  assert.equal(plain.status, 503)
  for (const body of [null, [], 'private', 1]) {
    const result = await withFetch(async () => json(body), () => fetchJson('https://h/chat'))
    assert.equal(result.code, INVALID_RESPONSE)
  }
})

test('网络/超时只按可靠name/code/cause，异常正文不得改变分类', async () => {
  const cases = [
    [new Error('socket hang up timeout abort network private'), HTTP_ERROR],
    [new TypeError('Failed to fetch'), HTTP_ERROR],
    [new TypeError('anything', { cause: { code: 'ECONNREFUSED' } }), NETWORK],
    [Object.assign(new Error('private'), { code: 'ECONNRESET' }), NETWORK],
    [new DOMException('private', 'TimeoutError'), TIMEOUT],
    [Object.assign(new Error('private'), { code: 'ETIMEDOUT' }), TIMEOUT],
  ]
  for (const [error, code] of cases) {
    const result = await withFetch(async () => { throw error }, () => fetchJson('https://h/chat'))
    assert.equal(result.code, code)
    assert.equal(result.status, 0)
    assert.ok(!result.error.includes('private'))
    assert.ok(!result.error.includes('socket'))
  }
  const result = await withFetch(async () => ({ status: 200, text: async () => { throw Object.assign(new Error('private'), { code: 'ECONNRESET' }) } }), () => fetchJson('https://h/chat'))
  assert.equal(result.code, NETWORK)
  assert.equal(result.status, 200)
})

test('JSON实际HTTP status不被上游自报status覆盖', async () => {
  const result = await withFetch(async () => json({ ok: true, status: 999, messages: [] }, 201), () => fetchJson('https://h/chat'))
  assert.equal(result.ok, true)
  assert.equal(result.status, 201)
})

test('binary和JSON共用传输stack/seam，字节MIME与signal原样，不缓存', async () => {
  const signal = new AbortController().signal
  const seen = []
  await withFetch(async (url, init) => {
    seen.push({ url, init })
    return new Response(new Uint8Array([0, 1, 2, 255]), { status: 200, headers: { 'content-type': 'image/png' } })
  }, async () => {
    for (let i = 0; i < 2; i += 1) {
      const result = await fetchBinary('https://h/custom/image/id/0', { headers: { Authorization: 'Bearer test-key' } }, signal)
      assert.equal(result.ok, true)
      assert.equal(result.contentType, 'image/png')
      assert.deepEqual(result.bytes, new Uint8Array([0, 1, 2, 255]))
      assert.equal(result.status, 200)
    }
    assert.equal(seen.length, 2)
    assert.equal(seen[0].init.signal, signal)
    assert.equal(seen[0].init.headers.Authorization, 'Bearer test-key')
  })
})

test('binary鉴权/访问/404/网络错误同型，404保留局部失败status', async () => {
  for (const [status, code] of [[401, AUTH_FAILED], [403, FORBIDDEN], [404, HTTP_ERROR]]) {
    const result = await withFetch(async () => json({ detail: 'private' }, status), () => fetchBinary('https://h/image/id/0'))
    assert.equal(result.ok, false)
    assert.equal(result.status, status)
    assert.equal(result.code, code)
    assert.ok(!result.error.includes('private'))
  }
  const failure = await withFetch(async () => { throw Object.assign(new Error('private'), { code: 'ENOTFOUND' }) }, () => fetchBinary('https://h/image/id/0'))
  assert.equal(failure.code, NETWORK)
  const malformed = await withFetch(async () => html(), () => fetchBinary('https://h/image/id/0'))
  assert.equal(malformed.code, UPSTREAM_HTML)
  const jsonFailure = await withFetch(async () => json({ ok: false, code: QUOTA }), () => fetchBinary('https://h/image/id/0'))
  assert.equal(jsonFailure.code, QUOTA)
})
