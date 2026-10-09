/** 后端 JSON 调用唯一出口；路径归 backend.js，安全失败与重试策略归 errors.js。 */
import { buildApiUrl } from './backend.js'
import { AUTH_FAILED, FORBIDDEN, INVALID_RESPONSE, NEED_KEY, classifyFailure, classifyUpstream, err } from './errors.js'

/**
 * 传输实现单源（0.6.2）：进程内全局 fetch 在不同 Node/Electron 版本下行为
 * 不一致（代理 honored 与否），且随宿主升级静默漂移；market 的 net.js
 * 已有同款教训（见其注释）。本模块统一走包内 undici（显式 EnvHttpProxyAgent，
 * 读环境、认 NO_PROXY），包缺席（纯单测树）才回落全局 fetch。
 * 单测经 __setStackFetch 注入（内部 seam，不形成第二消费者入口）。
 */
let stackPromise = null

function stackFetch() {
  // 原子共享初始化：冷启动并发首调共用同一个 promise。
  if (!stackPromise) {
    stackPromise = (async () => {
      try {
        const { EnvHttpProxyAgent, fetch: undiciFetch } = await import('undici')
        const agent = new EnvHttpProxyAgent()
        return (url, init) => undiciFetch(url, { ...init, dispatcher: agent })
      } catch {
        return (...args) => fetch(...args)
      }
    })()
  }
  return stackPromise
}

/** 内部测试 seam：覆盖传输实现（只供单测注入 mock，用后必 __resetStackFetch）。 */
export function __setStackFetch(fn) {
  stackPromise = Promise.resolve(fn)
}

/** 内部测试 seam：恢复自动选择（包在则包 undici，否则全局 fetch）。 */
export function __resetStackFetch() {
  stackPromise = null
}

export async function fetchJson(url, { method = 'GET', headers = {}, body } = {}, signal) {
  let res
  let text
  try {
    const doFetch = await stackFetch()
    res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    text = await res.text()
  } catch (error) {
    const failure = classifyFailure({ error, status: res?.status })
    return err(failure.code, failure.text, { status: res?.status || 0 })
  }
  return jsonResult(res, text)
}

function jsonResult(res, text) {
  let parsed
  try { parsed = text ? JSON.parse(text) : {} } catch {
    return classifyUpstream({ status: res.status, contentType: res.headers?.get('content-type'), text })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const failure = classifyFailure({ code: INVALID_RESPONSE, status: res.status })
    return err(failure.code, failure.text, { status: res.status })
  }
  if (!res.ok || parsed.ok === false) {
    const detail = parsed.detail && typeof parsed.detail === 'object' && !Array.isArray(parsed.detail) ? parsed.detail : parsed
    const code = typeof detail.code === 'string' && detail.code ? detail.code : typeof parsed.code === 'string' && parsed.code ? parsed.code : ''
    const text = typeof detail.message === 'string' ? detail.message : typeof parsed.detail === 'string' ? parsed.detail : typeof parsed.error === 'string' ? parsed.error : undefined
    const failure = classifyFailure({ code, status: res.status, text })
    const metadata = { status: res.status }
    if (detail.reset_at !== undefined) metadata.reset_at = detail.reset_at
    if (detail.hint !== undefined) metadata.hint = detail.hint
    return err(failure.code, failure.text, metadata)
  }
  return { ok: true, ...parsed, status: res.status }
}

/** 二进制请求与 JSON 共用代理栈及失败分类；不缓存、不落盘。 */
export async function fetchBinary(url, { method = 'GET', headers = {} } = {}, signal) {
  let res
  try {
    const doFetch = await stackFetch()
    res = await doFetch(url, { method, headers, signal })
    if (!res.ok) return rewriteBackendAuth(jsonResult(res, await res.text()))
    const contentType = res.headers?.get('content-type') || 'application/octet-stream'
    if (/application\/json/i.test(contentType)) {
      const result = jsonResult(res, await res.text())
      if (!result.ok) return result
      const failure = classifyFailure({ code: INVALID_RESPONSE, status: res.status })
      return err(failure.code, failure.text, { status: res.status })
    }
    if (/text\/html|application\/xhtml/i.test(contentType)) {
      return classifyUpstream({ status: res.status, contentType, text: await res.text() })
    }
    return { ok: true, status: res.status, contentType, bytes: new Uint8Array(await res.arrayBuffer()) }
  } catch (error) {
    const failure = classifyFailure({ error, status: res?.status })
    return err(failure.code, failure.text, { status: res?.status || 0 })
  }
}

/** 401 只证明认证失败，403 只证明访问被拒；两者均不能推断 key 过期。 */
export async function backendCallRaw({ base, apiKey, method, path, body, signal }) {
  const built = buildApiUrl(base, path)
  if (!built.ok) return built
  if (!apiKey) return err(NEED_KEY, classifyFailure({ code: NEED_KEY }).text)
  const result = await fetchJson(built.url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body,
  }, signal)
  return rewriteBackendAuth(result)
}

function rewriteBackendAuth(result) {
  if (result.ok === false && (result.status === 401 || result.status === 403)) {
    const failure = classifyFailure({ code: result.status === 401 ? AUTH_FAILED : FORBIDDEN })
    return { ...result, code: failure.code, error: failure.text }
  }
  return result
}
