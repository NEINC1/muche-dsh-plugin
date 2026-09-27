/**
 * 后端地址唯一真源（0.6.0）：归一＋拼装＋形态判定。
 *
 * 全员远端唯一口径：base 唯一形态为 `<公网基址>/api`。调用方禁各自
 * `replace(/\/+$/, '')`（旧 4 处散装，见 routes.js/backend_ws.js，WP2 起收口到此）。
 * Client 侧镜像同规约纯函数（宿主边界不跨 import），双边一致性由
 * `dsh/test/backend-errors.test.js` 同一套 fixture 锁死。
 */
import { NEED_SETUP, NOT_API } from './errors.js'

const TARGET = 'TARGET'

/**
 * 归一后端地址（纯函数）。
 *
 * - 空 → NEED_SETUP（未配置显式化，不静默打本机）。
 * - 非法 URL/非 http(s) → TARGET（调用方按“地址配错”收口，不归 NOT_API）。
 * - path 为根 → 自动补 `/api`（fixed=true，调用方须明示“已自动补 /api”）。
 * - path 以 `/api` 结尾 → 通过（fixed=false）。
 * - 其他 path（如 /wrong）→ NOT_API（真判定：明确不是接口前缀，不自动拼接，
 *   否则 https://host/wrong 会被静默改成 https://host/wrong/api 继续错）。
 *
 * 成功返回 { ok:true, url, fixed, insecure }（url 无尾斜杠、无 query/hash）。
 */
export function normalizeBackendUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) {
    return {
      ok: false,
      code: NEED_SETUP,
      error: '还没配后端地址：去 设置 → 小沐 填写保存。',
    }
  }
  let u
  try {
    u = new URL(text)
  } catch {
    return { ok: false, code: TARGET, error: '后端地址不是合法 URL，请检查后重填。' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, code: TARGET, error: '后端地址须为 http(s) 开头，请检查后重填。' }
  }
  const path = String(u.pathname || '').replace(/\/+$/, '')
  if (path === '' || path === '/') {
    return {
      ok: true,
      url: `${u.protocol}//${u.host}/api`,
      fixed: true,
      insecure: u.protocol === 'http:',
    }
  }
  if (/(^|\/)api$/.test(path)) {
    return {
      ok: true,
      url: `${u.protocol}//${u.host}${path}`,
      fixed: false,
      insecure: u.protocol === 'http:',
    }
  }
  return {
    ok: false,
    code: NOT_API,
    error: '后端地址须为 https://公网地址/api（当前路径不是 /api 结尾，不会自动拼接）。',
  }
}

/**
 * 拼后端接口地址：归一失败原样透传 code（调用方按码分支，不猜正文）。
 * path 可带或不带前导 `/`。
 */
export function buildApiUrl(base, path) {
  const n = normalizeBackendUrl(base)
  if (!n.ok) return n
  const p = String(path || '')
  const suffix = p.startsWith('/') ? p : `/${p}`
  return { ok: true, url: n.url + suffix, fixed: n.fixed, insecure: n.insecure }
}

/**
 * 地址形态即时判定（设置页红字用，与归一同规约）。
 * 空串回 false（空框不警告，由保存时 NEED_SETUP 收口）；非法 URL 回 false
 *（由保存时 TARGET 收口，此处不抢报错）。
 */
export function missingApiSuffix(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  let u
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  const path = String(u.pathname || '').replace(/\/+$/, '')
  if (path === '' || path === '/') return true
  return !/(^|\/)api$/.test(path)
}
