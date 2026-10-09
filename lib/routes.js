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

export { NEED_KEY, NEED_SETUP, AUTH_FAILED } from './errors.js'

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
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}
export function pickImages(body) {
  return Array.isArray(body?.images) ? body.images.filter((s) => typeof s === 'string' && s.length > 0) : undefined
}

export function registerRoutes(ctx, config, guard, { runtime: suppliedRuntime } = {}) {
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
  reg({ kind: 'exact', path: '/api/muche/chat', handler: async (req, res) => {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    const body = await readBody(req)
    const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : ''
    const images = pickImages(body)
    if (!text && !images?.length) return sendJson(res, 400, { ok: false, error: '空消息' })
    const payload = { message: text }
    const messageId = typeof body.message_id === 'string' ? body.message_id.trim() : ''
    if (messageId) payload.message_id = messageId
    if (images) payload.images = images
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
      const body = await readBody(req)
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
