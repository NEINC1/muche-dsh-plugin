/** Same-origin request port. Typed failures preserve status and captured runtime context. */
import { HOST_UNAVAILABLE, INVALID_RESPONSE, STALE_RUNTIME } from '../../lib/errors.js'

async function request(path, { method = 'GET', body, context, signal } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (context) {
    headers['X-Muche-Runtime'] = context.runtimeId
    headers['X-Muche-Generation'] = String(context.generation)
  }
  try {
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal })
    let value
    try { value = await response.json() }
    catch { return { ok: false, code: INVALID_RESPONSE, status: response.status, error: '连接暂时不可用', localFailure: true } }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: INVALID_RESPONSE, error: '连接暂时不可用', localFailure: true }
    return { ...value, ok: response.ok && value.ok !== false, status: value.status ?? response.status }
  } catch (error) {
    if (signal?.aborted) return { ok: false, code: STALE_RUNTIME, error: '请求已取消' }
    console.warn('muche client: same-origin request failed', String(error?.name || 'Error'))
    return { ok: false, code: HOST_UNAVAILABLE, status: 0, error: '连接暂时中断，正在重连', localFailure: true }
  }
}
export const apiGet = (path, options) => request(path, options)
export const apiPost = (path, body, options) => request(path, { ...options, method: 'POST', body })
