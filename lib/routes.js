/**
 * Same-origin HTTP consumers of the saved-config runtime. Official settings alone write
 * config. DSH's Host/Cookie rejection gate precedes every handler. Backend calls share
 * backendCallRaw; their captured runtime context fences late results and side effects.
 * Candidate diagnostics never commit running state. History remains server-only.
 */
import { readConfig, configNamespace } from './config.js'
import { buildApiUrl } from './backend.js'
import { AUTH_FAILED, CURSOR_INVALID, NEED_KEY, NEED_SETUP, HOST_UNAVAILABLE, STALE_RUNTIME, HTTP_ERROR, classifyFailure } from './errors.js'
import { backendCallRaw, fetchBinary } from './http.js'
import { probeBackendUpgrade } from './backend_ws.js'
import { getDshBridgeStatus } from './dsh-bridge.js'
import { createRegistrationGuard } from './register-guard.js'
import { createRuntimeState, sameRuntimeContext } from './runtime-state.js'
import { readFile } from 'node:fs/promises'

export { NEED_KEY, NEED_SETUP, AUTH_FAILED } from './errors.js'

// Keep these transport limits aligned with the shared Python contract and Nginx template;
// tests reject drift across independently deployed adapters.
const CHAT_REQUEST_BODY_MAX_BYTES = 40 * 1024 * 1024
const HEALTH_REQUEST_BODY_MAX_BYTES = 64 * 1024
// 语音上行是 WAV base64；上限与后端 ChatRequest.audio 的 max_length 同一真源，
// 由 request-body-bounds.test.js 直接比对 Python 常量。
const CHAT_AUDIO_MAX_BASE64_CHARS = 4_000_000
const DESKTOP_CHAT_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小沐</title><style>
:root{--dsw-alias-bg-base:#fff;--dsw-alias-border-l1:#e4e6eb;--dsw-alias-border-l2:#eceef1;--dsw-alias-button-ghost-active-fill:#f0f2f5;--dsw-alias-interactive-bg-hover:#f6f7f9;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#5f6368;--dsw-alias-label-tertiary:#858a91;--dsw-alias-state-business-primary:#4d6bfe;--dsw-alias-state-error-primary:#d94b4b;--dsw-alias-state-success-primary:#38a169;--dsw-shadow-lv2:0 8px 24px #0002;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--dsw-alias-bg-base:#1b1c1f;--dsw-alias-border-l1:#34373d;--dsw-alias-border-l2:#2a2d33;--dsw-alias-button-ghost-active-fill:#2b2f36;--dsw-alias-interactive-bg-hover:#25282e;--dsw-alias-label-primary:#e6e8eb;--dsw-alias-label-secondary:#a7adb6;--dsw-alias-label-tertiary:#7d838c;--dsw-alias-state-business-primary:#6b86ff;--dsw-alias-state-error-primary:#f07171;--dsw-alias-state-success-primary:#4cc38a;--dsw-shadow-lv2:0 8px 24px #0009}}
html,body,#muche-desktop-chat-root{width:100%;height:100%;margin:0;font-family:system-ui,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}*{box-sizing:border-box}
</style><script defer src="/api/muche/desktop-chat.js"></script></head><body><div id="muche-desktop-chat-root"></div></body></html>`

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}
function rejected(ctx, req, res) {
  const status = ctx.connection.requestRejection(req)
  if (status === undefined) return false
  sendJson(res, status, { ok: false, code: HOST_UNAVAILABLE, error: '本机连接不可用' })
  return true
}
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let receivedBytes = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const reject = (reason) => {
      chunks.length = 0
      finish({ ok: false, reason })
      if (typeof req.resume === 'function') req.resume()
    }
    req.on('end', () => {
      if (settled) return
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        finish({ ok: true, body })
      } catch { finish({ ok: true, body: {} }) }
    })
    req.on('error', (error) => {
      if (settled) return
      console.warn('muche routes: request body read failed', String(error?.name || 'Error'))
      reject('read_failed')
    })
    const contentLength = req.headers?.['content-length']
    if (contentLength !== undefined) {
      if (typeof contentLength !== 'string' || !/^\d+$/.test(contentLength)) {
        reject('invalid_length')
        return
      }
      if (BigInt(contentLength) > BigInt(maxBytes)) {
        reject('too_large')
        return
      }
    }
    req.on('data', (chunk) => {
      if (settled) return
      receivedBytes += chunk.length
      if (receivedBytes > maxBytes) {
        reject('too_large')
        return
      }
      chunks.push(chunk)
    })
  })
}
function bodyReadFailure(res, result) {
  if (result.reason === 'too_large') {
    sendJson(res, 413, { ok: false, error: '请求体过大' })
    return
  }
  sendJson(res, 400, { ok: false, error: '请求体无效' })
}
export function pickImages(body) {
  return Array.isArray(body?.images) ? body.images.filter((s) => typeof s === 'string' && s.length > 0) : undefined
}

export function registerRoutes(ctx, config, guard, { runtime: suppliedRuntime, getDesktop } = {}) {
  const g = guard || createRegistrationGuard()
  const runtime = suppliedRuntime || createRuntimeState({ configNs: configNamespace(ctx) })
  if (!suppliedRuntime) runtime.configure(readConfig(config))
  const disposes = []
  const pending = new Set()
  let bound = runtime.context()
  const offState = runtime.subscribe(() => {
    if (sameRuntimeContext(bound, runtime.context())) return
    bound = runtime.context()
    for (const controller of pending) controller.abort()
    pending.clear()
  })
  const cleanup = () => {
    offState()
    for (const controller of pending) controller.abort()
    pending.clear()
    while (disposes.length) {
      try { disposes.pop()() } catch (error) { console.warn('muche routes: cleanup failed', String(error?.name || 'Error')) }
    }
    if (!suppliedRuntime) runtime.dispose()
  }
  // Official contract: ctx.effect(setup) runs setup for the fiber lifetime and disposes whatever
  // it returns. setup must return cleanup itself, not a wrapper that never runs.
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  if (!suppliedRuntime && typeof ctx.on === 'function') {
    const off = ctx.on('loader/volatile-update', () => runtime.configure(readConfig(config)))
    if (typeof off === 'function') disposes.push(off)
  }
  const reg = (entry) => g.run(() => {
    const off = ctx.webServer.register(entry)
    if (typeof off === 'function') { disposes.push(off); g.track(off) }
  })
  const stale = (context) => ({ ok: false, code: STALE_RUNTIME, error: '配置已更新，请重试', context })
  const expectedMatches = (req, context) => {
    const id = req?.headers?.['x-muche-runtime']
    const gen = req?.headers?.['x-muche-generation']
    return id === undefined && gen === undefined || id === context.runtimeId && Number(gen) === context.generation
  }
  async function backendCall(method, path, body, req) {
    const context = runtime.context()
    if (!expectedMatches(req, context)) return stale(context)
    const cfg = readConfig(config)
    const controller = new AbortController()
    const ticket = runtime.beginHttp()
    pending.add(controller)
    try {
      const timeout = AbortSignal.timeout(method === 'POST' ? 120000 : 15000)
      const result = await backendCallRaw({ base: cfg.backendUrl, apiKey: cfg.apiKey, method, path, body, signal: AbortSignal.any([controller.signal, timeout]) })
      if (!runtime.accepts(context)) return stale(context)
      runtime.observeHttp(context, result, { operation: method === 'POST' ? 'chat' : 'history', ticket })
      return { ...result, context, snapshot: runtime.getSnapshot() }
    } finally { pending.delete(controller) }
  }
  const reply = (res, result) => sendJson(res, result.ok ? 200 : result.code === STALE_RUNTIME ? 409 : result.status >= 400 ? result.status : 502, result)

  reg({ kind: 'exact', path: '/api/muche/runtime', handler: (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
    sendJson(res, 200, { ok: true, snapshot: runtime.getSnapshot() })
  } })
  reg({ kind: 'exact', path: '/api/muche/desktop-chat', handler: (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" })
    res.end(DESKTOP_CHAT_HTML)
  } })
  reg({ kind: 'exact', path: '/api/muche/desktop-chat.js', handler: async (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
    try {
      const script = await readFile(new URL('../client/desktop-chat.js', import.meta.url))
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(script)
    } catch (error) { console.error('muche desktop: chat bundle unavailable', error?.name || 'Error'); sendJson(res, 500, { ok: false, error: '聊天窗口不可用' }) }
  } })
  reg({ kind: 'exact', path: '/api/muche/desktop', handler: async (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    const read = await readBody(req, 4096)
    if (!read.ok) return bodyReadFailure(res, read)
    const action = read.body?.action
    if (!['show', 'hide', 'retry'].includes(action)) return sendJson(res, 400, { ok: false, error: '未知操作' })
    const desktop = getDesktop?.()
    if (!desktop) return sendJson(res, 503, { ok: false, code: 'DESKTOP_UNAVAILABLE', error: '桌面悬浮窗不可用' })
    try {
      Promise.resolve(desktop[action]()).catch(error => console.error('muche desktop: action failed', error?.message || error))
      return sendJson(res, 202, { ok: true, accepted: true, snapshot: runtime.getSnapshot() })
    } catch (error) {
      console.error('muche desktop: action failed', error?.message || error)
      return sendJson(res, 500, { ok: false, error: '桌面悬浮窗操作失败' })
    }
  } })
  reg({ kind: 'exact', path: '/api/muche/chat', handler: async (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    const read = await readBody(req, CHAT_REQUEST_BODY_MAX_BYTES)
    if (!read.ok) return bodyReadFailure(res, read)
    const body = read.body
    const text = typeof body.text === 'string' ? body.text : ''
    const images = pickImages(body)
    // 有 audio 即语音轮：文字可以为空，转写与静音判定都归后端（单一真源）。
    const audio = typeof body.audio === 'string' ? body.audio : ''
    if (audio && audio.length > CHAT_AUDIO_MAX_BASE64_CHARS) return sendJson(res, 413, { ok: false, code: 'AUDIO_TOO_LARGE', error: '录音过长' })
    if (!text && !images?.length && !audio) return sendJson(res, 400, { ok: false, error: '空消息' })
    const payload = { message: text }
    const messageId = typeof body.message_id === 'string' ? body.message_id.trim() : ''
    if (messageId) payload.message_id = messageId
    if (images) payload.images = images
    if (audio) payload.audio = audio
    reply(res, await backendCall('POST', '/chat', payload, req))
  } })
  reg({ kind: 'exact', path: '/api/muche/history', handler: async (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
    const url = new URL(req.url || '/', 'http://localhost')
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 20))
    const before = url.searchParams.get('before') || ''
    const path = `/chat/history?limit=${limit}` + (before ? `&before=${encodeURIComponent(before)}` : '')
    let result = await backendCall('GET', path, undefined, req)
    if (!result.ok && result.status === 422 && (!result.code || result.code === HTTP_ERROR)) result = { ...result, code: CURSOR_INVALID, error: '游标过期，已回最新页' }
    reply(res, result)
  } })
  reg({ kind: 'exact', path: '/api/muche/tasks', handler: async (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
    reply(res, await backendCall('GET', '/tasks', undefined, req))
  } })
  reg({ kind: 'exact', path: '/api/muche/tasks/stop', handler: async (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    const read = await readBody(req, HEALTH_REQUEST_BODY_MAX_BYTES)
    if (!read.ok) return bodyReadFailure(res, read)
    const taskId = typeof read.body?.task_id === 'string' ? read.body.task_id.trim() : ''
    if (!/^[A-Za-z0-9:_-]{1,80}$/.test(taskId)) return sendJson(res, 400, { ok: false, error: '缺少任务 id' })
    reply(res, await backendCall('POST', '/tasks/' + encodeURIComponent(taskId) + '/stop', {}, req))
  } })
  reg({ kind: 'exact', path: '/api/muche/image', handler: async (req, res) => {
    if (rejected(ctx, req, res)) return
    const url = new URL(req.url || '/', 'http://localhost')
    const id = url.searchParams.get('id') || ''
    const index = url.searchParams.get('index') || '0'
    if (!/^[0-9a-f-]{1,64}$/i.test(id) || !/^\d{1,3}$/.test(index)) return sendJson(res, 400, { ok: false, error: '图片不存在' })
    const context = runtime.context()
    if (!expectedMatches(req, context)) return reply(res, stale(context))
    const cfg = readConfig(config)
    if (!cfg.apiKey) return sendJson(res, 401, { ok: false, code: NEED_KEY, error: '请检查配置', context })
    const built = buildApiUrl(cfg.backendUrl, `/image/${encodeURIComponent(id)}/${encodeURIComponent(index)}`)
    if (!built.ok) return reply(res, { ...built, context })
    const controller = new AbortController()
    pending.add(controller)
    try {
      const upstream = await fetchBinary(built.url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } }, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
      if (!runtime.accepts(context)) return reply(res, stale(context))
      if (!upstream.ok) return reply(res, { ...upstream, context })
      res.writeHead(200, { 'Content-Type': upstream.contentType || 'image/jpeg', 'Cache-Control': 'no-store' })
      res.end(Buffer.from(upstream.bytes))
    } catch (error) {
      if (!runtime.accepts(context)) return reply(res, stale(context))
      console.warn('muche routes: image request failed', String(error?.name || 'Error'))
      sendJson(res, 502, { ok: false, error: '图片暂时无法加载', context })
    } finally { pending.delete(controller) }
  } })

  // Diagnostic cache contains only probe results, never cached live runtime/bridge state.
  let healthCache = null
  async function runHealthChecks(cfg) {
    // Key before address, matching the runtime's own committed order, and without any
    // network attempt: an incomplete configuration is a configuration fact, not an outage.
    const incomplete = !cfg.apiKey ? NEED_KEY : !cfg.backendUrl ? NEED_SETUP : ''
    if (incomplete) {
      const segment = { ok: false, code: incomplete, error: '请检查配置', kind: 'config' }
      return { ok: true, auth: segment, history: segment, ws: { ...segment, stage: 'target' }, checkedAt: new Date().toISOString() }
    }
    // Diagnostics report the same shared classification the panel consumes, so the settings
    // page and the banner can never disagree about what one backend answer means.
    const segment = (r) => ({ ok: false, ...classifyFailure({ code: r.code, status: r.status, retryable: r.retryable }) })
    const call = (path) => backendCallRaw({ base: cfg.backendUrl, apiKey: cfg.apiKey, method: 'GET', path, signal: AbortSignal.timeout(8000) })
    const parts = await Promise.allSettled([
      call('/auth/me').then((r) => r.ok ? { ok: true, userId: r.user_id || r.userId || '' } : segment(r)),
      call('/chat/history?limit=1').then((r) => r.ok ? { ok: true, count: Array.isArray(r.messages) ? r.messages.length : 0 } : segment(r)),
      probeBackendUpgrade(cfg.backendUrl, { timeoutMs: 8000 }),
    ])
    const pick = (part) => part.status === 'fulfilled' ? part.value : { ok: false, code: 'HTTP_ERROR', error: '检查异常', kind: 'operation' }
    return { ok: true, auth: pick(parts[0]), history: pick(parts[1]), ws: pick(parts[2]), checkedAt: new Date().toISOString() }
  }
  reg({ kind: 'exact', path: '/api/muche/health', handler: async (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method === 'POST') {
      const read = await readBody(req, HEALTH_REQUEST_BODY_MAX_BYTES)
      if (!read.ok) return bodyReadFailure(res, read)
      const body = read.body
      const stored = readConfig(config)
      const candidate = { backendUrl: typeof body.backendUrl === 'string' && body.backendUrl.trim() ? body.backendUrl.trim() : stored.backendUrl, apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : '' }
      if (!candidate.apiKey) return sendJson(res, 400, { ok: false, code: NEED_KEY, error: '请检查配置' })
      return sendJson(res, 200, { ...await runHealthChecks(candidate), mode: 'candidate' })
    }
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET/POST' })
    const cfg = readConfig(config)
    const key = `${cfg.backendUrl}|${cfg.apiKey}`
    const live = new URL(req.url || '/', 'http://localhost').searchParams.get('live') === '1'
    let payload
    if (!live && healthCache?.key === key && Date.now() - healthCache.at < 30000) payload = healthCache.payload
    else {
      payload = await runHealthChecks(cfg)
      healthCache = { at: Date.now(), key, payload }
    }
    sendJson(res, 200, { ...payload, configNs: configNamespace(ctx), runtime: runtime.getSnapshot(), status: getDshBridgeStatus() })
  } })
  return g.degraded
}
