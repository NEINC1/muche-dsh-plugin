/**
 * HTTP 工具：对后端的 JSON 请求封装（Node 18+ 原生 fetch），0.6.0 版。
 *
 * 唯一口径（全员远端）：base 唯一形态 `<公网基址>/api`，归一走
 * backend.js（调用方禁自拼）。错误统一为 { ok:false, code, error, status?, hint? }，
 * 码本体见 errors.js；调用方按码分支，不猜正文。
 *
 * 语义（WP0 实证后定稿）：归一失败直接返回其码（错地址在 fetch 前即拦）；
 * fetch 阶段非 JSON 一律 UPSTREAM_HTML（归一已保 /api，HTML 必为网关/代理页）；
 * NOT_API 只在归一阶段产生。
 */
import { buildApiUrl } from './backend.js'
import { AUTH_FAILED, NEED_KEY, NETWORK, TIMEOUT, classifyUpstream, err } from './errors.js'

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
  // 兼容旧调用形 fetchJson(fullUrl, opts)：fullUrl 恒为归一 base 加路径，
  // 此处只做请求与分类，不再做地址判定（判定在归一层）。
  let res
  try {
    const doFetch = await stackFetch()
    res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    if (/abort|timeout/i.test(message)) {
      return { ...err(TIMEOUT, `请求超时: ${message.slice(0, 120)}`), status: 0 }
    }
    return { ...err(NETWORK, `请求失败: ${message.slice(0, 120)}`), status: 0 }
  }
  const contentType = String((res.headers && res.headers.get('content-type')) || '')
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = null
  }
  if (parsed === null) {
    const out = classifyUpstream({ status: res.status, contentType, text })
    return out
  }
  if (!res.ok) {
    // 结构化 detail（如额度契约 {code,message,reset_at}）原样透传，调用方按 code 分支
    if (parsed.detail && typeof parsed.detail === 'object') {
      return {
        ok: false,
        error: String(parsed.detail.message || `HTTP ${res.status}`),
        status: res.status,
        code: parsed.detail.code,
        reset_at: parsed.detail.reset_at,
      }
    }
    const detail = typeof parsed.detail === 'string' ? parsed.detail : `HTTP ${res.status}`
    return { ok: false, error: detail, status: res.status }
  }
  return { ok: true, status: res.status, ...parsed }
}

/** 后端调用唯一出口（路由层共用）：归一 → 带 key 请求 → 401/403 换可操作指引。 */
export async function backendCallRaw({ base, apiKey, method, path, body, signal, needKeyHint, needSetupHint }) {
  const built = buildApiUrl(base, path)
  if (!built.ok) return built
  if (!apiKey) {
    return {
      ok: false,
      code: NEED_KEY,
      error: needKeyHint || '还没配 API key：去 设置 → 小沐 填写保存。',
    }
  }
  const result = await fetchJson(built.url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body,
  }, signal)
  if (result && result.ok === false && (result.status === 401 || result.status === 403)) {
    return {
      ok: false,
      status: result.status,
      code: AUTH_FAILED,
      error: 'API key 已失效：去小沐后台重签，到 设置 → 小沐 更新。',
    }
  }
  return result
}
