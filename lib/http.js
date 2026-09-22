/**
 * HTTP 工具：对后端的 JSON 请求封装（Node 18+ 原生 fetch）。
 * 错误统一为 { ok:false, error, status }（不静默、可展示给用户）。
 */
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
  const text = await res.text()
  let parsed = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    return { ok: false, error: '响应解析失败', status: res.status }
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
