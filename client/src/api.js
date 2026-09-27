/**
 * 同源 HTTP 封装（0.6.0 WP3a）：/api/muche/* 路由，esbuild 打进 client.js。
 * 失败一律 { ok:false, error }（码分支在调用方，见 panel/settings）。
 */

// ── HTTP 封装（同源 /api/muche/* 路由） ──
export async function apiGet(path) {
  try {
    const r = await fetch(path)
    return await r.json().catch(() => ({ ok: false, error: '响应解析失败' }))
  } catch (e) { return { ok: false, error: '请求失败' } }
}

export async function apiPost(path, body) {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    return await r.json().catch(() => ({ ok: false, error: '响应解析失败' }))
  } catch (e) { return { ok: false, error: '请求失败' } }
}
