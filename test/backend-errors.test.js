import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApiUrl, normalizeBackendUrl } from '../lib/backend.js'
import * as errors from '../lib/errors.js'

const { AUTH_FAILED, BRIDGE_DEPENDENCIES, BRIDGE_OFFLINE, BRIDGE_STARTUP, CURSOR_INVALID, FORBIDDEN, HOST_UNAVAILABLE, HTTP_ERROR, INPUT_INVALID, INVALID_RESPONSE, NEED_KEY, NEED_SETUP, NETWORK, NOT_API, QUOTA, RATE_LIMITED, STALE_RUNTIME, TARGET, TIMEOUT, UPSTREAM_HTML, classifyFailure, classifyUpstream, err } = errors

test('归一不规定部署前缀：根、任意 path、编码路径均保留，不补/api', () => {
  for (const [raw, expected] of [
    ['https://h', 'https://h'], [' https://h/ ', 'https://h'],
    ['https://h/api/', 'https://h/api'], ['https://h/wrong', 'https://h/wrong'],
    ['http://h:8080/muche/v2/', 'http://h:8080/muche/v2'],
    ['https://h/custom%2Fprefix', 'https://h/custom%2Fprefix'],
  ]) {
    const normalized = normalizeBackendUrl(raw)
    assert.equal(normalized.ok, true, raw)
    assert.equal(normalized.url, expected)
    assert.equal(normalized.fixed, false)
    assert.equal(normalized.insecure, expected.startsWith('http:'))
  }
})

test('空基址为NEED_SETUP，非法URL/协议/凭据/query/hash为TARGET，不悄悄删去', () => {
  for (const raw of ['', '   ', undefined, null]) assert.equal(normalizeBackendUrl(raw).code, NEED_SETUP)
  for (const raw of ['not a url', 'ftp://h/api', 'ws://h', 'https://user:private@h/path', 'https://user@h', 'https://h/path?x=1', 'https://h/path#x', 'https://h/?', 'https://h/#']) {
    assert.deepEqual(normalizeBackendUrl(raw), { ok: false, code: TARGET, error: '请检查配置' }, raw)
  }
})

test('HTTP拼装只追加调用路径，不能丢前缀或暗加/api', () => {
  assert.equal(buildApiUrl('https://h', '/chat').url, 'https://h/chat')
  assert.equal(buildApiUrl('https://h/custom/', 'chat/history?limit=1').url, 'https://h/custom/chat/history?limit=1')
  assert.equal(buildApiUrl('https://h/api/', '/chat').url, 'https://h/api/chat')
  assert.equal(buildApiUrl('https://h/?secret=x', '/chat').code, TARGET)
})

test('既有码及共享实用码全部保留，错误工厂保持形状', () => {
  for (const code of [NEED_SETUP, NEED_KEY, AUTH_FAILED, NOT_API, UPSTREAM_HTML, NETWORK, TIMEOUT, CURSOR_INVALID, QUOTA, TARGET, FORBIDDEN, HOST_UNAVAILABLE, INVALID_RESPONSE, HTTP_ERROR, STALE_RUNTIME, INPUT_INVALID]) assert.equal(errors[code], code)
  assert.deepEqual(err(NEED_KEY, 'msg', { status: 401 }), { ok: false, code: NEED_KEY, error: 'msg', status: 401 })
})

test('全部配置故障固定请检查配置，绝不采纳上游过期/密钥/路径正文', () => {
  for (const code of [NEED_SETUP, NEED_KEY, AUTH_FAILED, NOT_API, TARGET, 'CUSTOM_CONFIG']) {
    const failure = classifyFailure({ kind: 'config', code, text: '私密值：key 已过期', error: 'raw fetch failure' })
    assert.equal(failure.kind, 'config')
    assert.equal(failure.text, '请检查配置')
    assert.equal(failure.retryable, false)
    assert.ok(!failure.advice.includes('过期'))
  }
})

test('可靠连接事实优先于调用方config标签；403独立access，不循环重试', () => {
  for (const code of [NETWORK, TIMEOUT, UPSTREAM_HTML]) {
    const failure = classifyFailure({ kind: 'config', code, text: '网络 key 已过期' })
    assert.equal(failure.kind, 'connection')
    assert.equal(failure.text, '连接暂时中断，正在重连')
    assert.equal(failure.retryable, true)
  }
  assert.equal(classifyFailure({ status: 401 }).kind, 'config')
  const denied = classifyFailure({ kind: 'config', status: 403, error: '凭证过期' })
  assert.equal(denied.code, FORBIDDEN)
  assert.equal(denied.kind, 'access')
  assert.equal(denied.retryable, false)
  assert.equal(denied.text, '访问被拒绝')
  for (const status of [401, 403]) {
    assert.equal(classifyFailure({ status, code: HOST_UNAVAILABLE }).kind, 'host')
    assert.equal(classifyFailure({ status, code: NEED_KEY }).code, NEED_KEY)
  }
})

test('异常只凭name/code/cause归因，不猜正文或孤立TypeError', () => {
  for (const error of [new Error('network timeout socket hang up'), new TypeError('Failed to fetch')]) {
    const failure = classifyFailure({ error })
    assert.equal(failure.kind, 'operation')
    assert.equal(failure.code, HTTP_ERROR)
    assert.equal(failure.text, '操作未完成，请稍后重试')
  }
  for (const error of [new DOMException('anything', 'TimeoutError'), new DOMException('anything', 'AbortError'), { code: 'ETIMEDOUT' }, { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }]) assert.equal(classifyFailure({ error }).code, TIMEOUT)
  for (const error of [{ name: 'NetworkError' }, { code: 'ECONNRESET' }, new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })]) assert.equal(classifyFailure({ error }).code, NETWORK)
  const cycle = new Error('timeout')
  cycle.cause = cycle
  assert.equal(classifyFailure({ error: cycle }).code, HTTP_ERROR)
})

test('额度/输入/host/业务操作独立，未知操作不泄露raw错误', () => {
  for (const fact of [{ code: QUOTA }, { code: 'message_quota_exhausted' }, { kind: 'quota' }]) {
    const failure = classifyFailure(fact)
    assert.equal(failure.kind, 'quota')
    assert.equal(failure.retryable, false)
  }
  const rate = classifyFailure({ status: 429 })
  assert.equal(rate.code, RATE_LIMITED)
  assert.equal(rate.kind, 'operation')
  assert.equal(rate.retryable, true)
  assert.equal(classifyFailure({ kind: 'input', text: '最多发送3张图片' }).text, '最多发送3张图片')
  assert.equal(classifyFailure({ code: INPUT_INVALID, error: '请缩小图片' }).text, '请缩小图片')
  assert.equal(classifyFailure({ code: CURSOR_INVALID }).kind, 'input')
  assert.equal(classifyFailure({ code: HOST_UNAVAILABLE }).kind, 'host')
  assert.equal(classifyFailure({ code: STALE_RUNTIME }).retryable, false)
  const unknown = classifyFailure({ code: 'unknown_failure', error: 'fetch failed token=private', text: '内部堆栈', status: 503 })
  assert.equal(unknown.code, 'unknown_failure')
  assert.equal(unknown.kind, 'operation')
  assert.equal(unknown.text, '操作未完成，请稍后重试')
  assert.equal(unknown.retryable, true)
  assert.equal(classifyFailure({ kind: 'operation', text: '图片暂时无法加载', error: 'raw fetch private' }).text, '图片暂时无法加载')
})

test('bridge只消费故障事实，不猜Owner启动资格；配置/access/额度仍优先', () => {
  for (const code of [BRIDGE_DEPENDENCIES, BRIDGE_STARTUP]) assert.equal(classifyFailure({ kind: 'bridge', code }).text, '本机 dsh 启动失败')
  for (const code of [BRIDGE_OFFLINE, NETWORK, TIMEOUT]) {
    const failure = classifyFailure({ kind: 'bridge', code, retryable: false })
    assert.equal(failure.kind, 'bridge')
    assert.equal(failure.text, '本机 dsh 连接异常')
    assert.equal(failure.retryable, false)
  }
  assert.equal(classifyFailure({ kind: 'bridge', code: AUTH_FAILED }).kind, 'config')
  assert.equal(classifyFailure({ kind: 'bridge', code: FORBIDDEN }).kind, 'access')
  assert.equal(classifyFailure({ kind: 'bridge', code: QUOTA }).kind, 'quota')
})

test('非JSON回包仅报告形态；HTML不再声称地址肯定正确', () => {
  const html = classifyUpstream({ status: 200, contentType: 'text/html', text: '<html>private</html>' })
  assert.deepEqual(html, { ok: false, code: UPSTREAM_HTML, error: '连接暂时中断，正在重连', status: 200, hint: 'html' })
  assert.equal(classifyFailure(html).kind, 'connection')
  const nonJson = classifyUpstream({ status: 503, contentType: 'text/plain', text: 'raw internal error' })
  assert.equal(nonJson.code, INVALID_RESPONSE)
  assert.equal(classifyFailure(nonJson).kind, 'operation')
  assert.equal(classifyUpstream({ status: 403, contentType: 'text/html', text: '<html>denied' }).code, FORBIDDEN)
})
