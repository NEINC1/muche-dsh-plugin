/** 后端基址唯一真源；HTTP/WS 共用，不替用户选择或补写部署路径。 */
import { NEED_SETUP, TARGET, classifyFailure, err } from './errors.js'

/** 只接受无凭据、query、hash 的 http(s) URL；任意路径及根路径均合法。 */
export function normalizeBackendUrl(raw) {
  const text = String(raw || '').trim()
  const fail = (code) => err(code, classifyFailure({ code }).text)
  if (!text) return fail(NEED_SETUP)
  let u
  try { u = new URL(text) } catch { return fail(TARGET) }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password || u.href.includes('?') || u.href.includes('#')) {
    return fail(TARGET)
  }
  return {
    ok: true,
    url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`,
    fixed: false,
    insecure: u.protocol === 'http:',
  }
}

/** 调用路径只作为基址后缀拼接，不能让前导斜杠丢掉用户的部署前缀。 */
export function buildApiUrl(base, path) {
  const n = normalizeBackendUrl(base)
  if (!n.ok) return n
  const suffix = String(path || '').replace(/^\/+/, '')
  return { ok: true, url: `${n.url}/${suffix}`, fixed: false, insecure: n.insecure }
}
