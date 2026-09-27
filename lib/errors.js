/**
 * 错误分类唯一真源（0.6.0）。
 *
 * 9 个码是面板、路由、探针三方的唯一分支依据；测试锁 `code` 不锁文案。
 * 调用方禁自造字符串分支（`error.includes(...)` 一律视为未收口）。
 */

export const NEED_SETUP = 'NEED_SETUP'
export const NEED_KEY = 'NEED_KEY'
export const AUTH_FAILED = 'AUTH_FAILED'
export const NOT_API = 'NOT_API'
export const UPSTREAM_HTML = 'UPSTREAM_HTML'
export const NETWORK = 'NETWORK'
export const TIMEOUT = 'TIMEOUT'
export const CURSOR_INVALID = 'CURSOR_INVALID'
export const QUOTA = 'QUOTA'

/** 统一错误体：{ ok:false, code, error, ...extra }（status/hint/reset_at 按需附带）。 */
export function err(code, error, extra) {
  return { ok: false, code, error, ...(extra || {}) }
}

/**
 * 上游非 JSON 回包分类（纯函数）。
 *
 * 前提（由 backend.js 保证）：请求 base 已归一为 `/api` 结尾，故 fetch 阶段的
 * HTML 一律是网关/代理/跳转页，与地址形态无关 → 只出 UPSTREAM_HTML。
 * NOT_API 只在归一阶段（存盘/调用前）产生，见 normalizeBackendUrl。
 */
export function classifyUpstream({ status, contentType, text }) {
  const body = String(text || '')
  const type = String(contentType || '')
  const hint = /text\/html/i.test(type) || /^\s*</.test(body) ? 'html' : 'non-json'
  const out = err(
    UPSTREAM_HTML,
    '后端暂不可用（收到非接口回包，非地址问题）：去面板健康检查看分段结论',
  )
  out.status = status
  out.hint = hint
  return out
}
