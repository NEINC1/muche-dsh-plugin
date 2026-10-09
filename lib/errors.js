/** Host/browser 共用的纯失败分类；调用方只提供事实，不凭上游正文猜原因。 */
export const NEED_SETUP = 'NEED_SETUP'
export const NEED_KEY = 'NEED_KEY'
export const AUTH_FAILED = 'AUTH_FAILED'
export const NOT_API = 'NOT_API'
export const UPSTREAM_HTML = 'UPSTREAM_HTML'
export const NETWORK = 'NETWORK'
export const TIMEOUT = 'TIMEOUT'
export const CURSOR_INVALID = 'CURSOR_INVALID'
export const QUOTA = 'QUOTA'
export const RATE_LIMITED = 'RATE_LIMITED'
export const TARGET = 'TARGET'
export const FORBIDDEN = 'FORBIDDEN'
export const HOST_UNAVAILABLE = 'HOST_UNAVAILABLE'
export const INVALID_RESPONSE = 'INVALID_RESPONSE'
export const HTTP_ERROR = 'HTTP_ERROR'
export const STALE_RUNTIME = 'STALE_RUNTIME'
export const INPUT_INVALID = 'INPUT_INVALID'
export const BRIDGE_DEPENDENCIES = 'BRIDGE_DEPENDENCIES'
export const BRIDGE_STARTUP = 'BRIDGE_STARTUP'
export const BRIDGE_OFFLINE = 'BRIDGE_OFFLINE'

const CONFIG_CODES = new Set([NEED_SETUP, NEED_KEY, AUTH_FAILED, TARGET, NOT_API])
const QUOTA_CODES = new Set([QUOTA, 'message_quota_exhausted'])
const INPUT_CODES = new Set([INPUT_INVALID, CURSOR_INVALID])
const BRIDGE_CODES = new Set([BRIDGE_DEPENDENCIES, BRIDGE_STARTUP, BRIDGE_OFFLINE])
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR', 'ERR_OPERATION_TIMED_OUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

function exceptionCode(error) {
  // fetch 的 TypeError 本身也可能是编程错误；只有可靠 name/code（含 cause）才判连接。
  const seen = new Set()
  for (let e = error; e && typeof e === 'object' && !seen.has(e); e = e.cause) {
    seen.add(e)
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || TIMEOUT_CODES.has(e.code)) return TIMEOUT
    if (e.name === 'NetworkError' || NETWORK_CODES.has(e.code)) return NETWORK
  }
  return ''
}

/**
 * 失败展示与重试策略的纯接口。bridge 的启动资格由桥接 Owner 判，不在此猜生命周期。
 * @param {{kind?:string, code?:string, error?:unknown, text?:string, status?:number, retryable?:boolean}} fact
 * @returns {{kind:string, code:string, text:string, advice:string, retryable:boolean}}
 */
export function classifyFailure(fact = {}) {
  const f = fact || {}
  const status = Number(f.status) || 0
  let code = typeof f.code === 'string' ? f.code : ''
  if (!code && status === 401) code = AUTH_FAILED
  else if (!code && status === 403) code = FORBIDDEN
  else if (!code && status === 429) code = RATE_LIMITED
  if (!code) code = exceptionCode(f.error)
  const out = (kind, fallback, text, advice = '', retryable = false) => ({ kind, code: code || fallback, text, advice, retryable })
  if (CONFIG_CODES.has(code) || (!code && f.kind === 'config')) {
    return out('config', NEED_SETUP, '请检查配置', '打开 dsh 设置 → 小沐，检查配置后保存')
  }
  if (code === FORBIDDEN) {
    return out('access', FORBIDDEN, '访问被拒绝', '请确认访问权限及来源限制')
  }
  if (code === RATE_LIMITED) return out('operation', RATE_LIMITED, '请求过于频繁，请稍后重试', '', true)
  if (QUOTA_CODES.has(code) || f.kind === 'quota') {
    return out('quota', QUOTA, '消息额度已用完', '请等待额度恢复')
  }
  if (f.kind === 'bridge' || BRIDGE_CODES.has(code)) {
    const startup = code === BRIDGE_DEPENDENCIES || code === BRIDGE_STARTUP
    return out('bridge', startup ? BRIDGE_STARTUP : BRIDGE_OFFLINE,
      startup ? '本机 dsh 启动失败' : '本机 dsh 连接异常',
      '请检查本机 dsh 状态及后端连接',
      typeof f.retryable === 'boolean' ? f.retryable : code === NETWORK || code === TIMEOUT || code === UPSTREAM_HTML)
  }
  if (code === NETWORK || code === TIMEOUT || code === UPSTREAM_HTML) {
    return out('connection', NETWORK, '连接暂时中断，正在重连', '请稍候，连接恢复后重试', true)
  }
  if (code === HOST_UNAVAILABLE || code === STALE_RUNTIME) {
    return out('host', HOST_UNAVAILABLE,
      code === STALE_RUNTIME ? '本机插件尚未就绪' : '本机服务暂不可用',
      '请检查本机服务与插件状态', code !== STALE_RUNTIME)
  }
  if (INPUT_CODES.has(code) || f.kind === 'input') {
    const correction = typeof f.text === 'string' ? f.text : typeof f.error === 'string' ? f.error : ''
    return out('input', INPUT_INVALID,
      correction || (code === CURSOR_INVALID ? '历史位置无效，请重新加载' : '请检查输入后重试'))
  }
  if (f.kind === 'config') return out('config', TARGET, '请检查配置', '打开 dsh 设置 → 小沐，检查配置后保存')
  if (f.kind === 'access') return out('access', FORBIDDEN, '访问被拒绝', '请确认访问权限及来源限制')
  if (f.kind === 'host') return out('host', HOST_UNAVAILABLE, '本机服务暂不可用', '请检查本机服务与插件状态', true)
  if (f.kind === 'connection') return out('connection', NETWORK, '连接暂时中断，正在重连', '请稍候，连接恢复后重试', true)
  return out('operation', HTTP_ERROR,
    f.kind === 'operation' && typeof f.text === 'string' && f.text ? f.text : code === INVALID_RESPONSE ? '服务响应异常，请稍后重试' : '操作未完成，请稍后重试',
    '如仍失败，请检查服务状态', status >= 500 || status === 408 || status === 425)
}

/** 统一错误体；status/hint/reset_at 等协议元数据按需保留。 */
export function err(code, error, extra) {
  return { ok: false, code, error, ...(extra || {}) }
}

/** 非 JSON 响应仅报告观察到的形态，不断言用户基址一定正确或一定错误。 */
export function classifyUpstream({ status, contentType, text }) {
  const html = /text\/html|application\/xhtml/i.test(String(contentType || '')) || /^\s*</.test(String(text || ''))
  const failure = classifyFailure({ code: status === 401 || status === 403 ? '' : html ? UPSTREAM_HTML : INVALID_RESPONSE, status })
  return err(failure.code, failure.text, { status, hint: html ? 'html' : 'non-json' })
}
