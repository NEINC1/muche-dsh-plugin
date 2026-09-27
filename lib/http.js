/**
 * HTTP 工具：对后端的 JSON 请求封装（Node 18+ 原生 fetch）。
 * 错误统一为 { ok:false, error, status, code? }（不静默、可展示给用户）。
 *
 * 后端地址唯一口径（全员远端）：`<公网基址>/api`。地址少了 `/api` 会打到
 * SPA 首页回 HTML（GET 200 / POST 405），此处识别为 NOT_API 并给出可操作
 * 指引——面板"响应解析失败"类红屏的首查项，不再是一句无差别报错。
 */
export const NOT_API = 'NOT_API'

export function notApiError() {
  return {
    ok: false,
    code: NOT_API,
    error: '后端地址可能少了 /api 后缀（收到的是网页不是接口）：远端请填 https://公网地址/api',
  }
}

export async function fetchJson(url, { method = 'GET', headers = {}, body } = {}, signal) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    return { ok: false, error: `请求失败: ${String(error && error.message ? error.message : error)}` }
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
    // 非 JSON（典型：少 /api 打到 SPA 首页的 HTML）→ 精确诊断，不吞。
    const out = notApiError()
    out.status = res.status
    if (/text\/html/i.test(contentType) || /^\s*</.test(text)) out.hint = 'html'
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
