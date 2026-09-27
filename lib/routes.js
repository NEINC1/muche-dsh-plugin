/**
 * HTTP 路由层：注册 /api/muche/*（浏览器同源直调，无包内 RPC 依赖）。
 *
 * 服务端直读形态（本地存档已删除）：面板数据（聊天/历史/探针）走这些路由
 * 直连小沐后端——不进 dsh agent 循环（零注入），不在本机落任何用户文件。
 * 配置读写不走这里：设置页经官方客户端设置服务（configForms→
 * settings.update/mutate），存储唯一真源是 profile patch（见 lib/config.js）。
 * 路由注册在插件 fiber 上，随插件卸载。
 *
 * 公网化鉴权（与官方 open-in-app 同构）：每个 handler 先过
 * `ctx.connection.requestRejection(req)`——Host 围栏 + Cookie 鉴权，
 * 401/403 直接拒绝。进程内直调（dsh-call）不走这些路由，不受影响。
 */
import { readConfig, configNamespace } from './config.js'
import { buildApiUrl } from './backend.js'
import { AUTH_FAILED, CURSOR_INVALID, NEED_KEY, NEED_SETUP } from './errors.js'
import { fetchJson } from './http.js'
import { probeBackendUpgrade } from './backend_ws.js'
import { getDshBridgeStatus } from './dsh-bridge.js'
import { createRegistrationGuard } from './register-guard.js'

// 三码本体在 errors.js，此处重导出（历史导入方兼容，WP4 随调用方收口后删）。
export { NEED_KEY, NEED_SETUP, AUTH_FAILED } from './errors.js'

/** 鉴权失败 → 固定 HTTP 码 + code（面板按 code 分支，不猜正文）。 */
function sendAuthError(res, state) {
  if (state === NEED_KEY) {
    return sendJson(res, 401, { ok: false, code: NEED_KEY, error: '还没配 API key：去 设置 → 小沐 填写保存。' })
  }
  if (state === NEED_SETUP) {
    return sendJson(res, 400, { ok: false, code: NEED_SETUP, error: '还没配后端地址：去 设置 → 小沐 填写保存。' })
  }
  return sendJson(res, 401, { ok: false, code: AUTH_FAILED, error: 'API key 已失效：去小沐后台重签，到 设置 → 小沐 更新。' })
}

/** 公网化先行门：未通过 dsh 鉴权即 401/403，返回 true 表示已拒绝。 */
function rejected(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
  return true
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** 附图透传（DSH 插件上传）：只做数组形态归一，数量/大小/类型由后端 vision 强校验。 */
export function pickImages(body) {
  const images = body && body.images
  if (images === undefined || images === null) return undefined
  if (!Array.isArray(images)) return undefined
  return images.filter((s) => typeof s === 'string' && s.length > 0)
}

/**
 * 401/403 → 统一换成可操作指引（后端原始 detail 如"凭证无效或已失效"对用户
 * 不可操作）。典型触发:账号重置前签发的 key 被清、或在 web 后台显式吊销。
 */
function rewriteAuthError(result) {
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

export function registerRoutes(ctx, config, guard) {
  // 双挂载守卫：第二份 apply 撞重复路由不再抛、不中断后继注册；
  // 调用方（index.js）凭 guard.degraded 决定是否起桥接，保证主纤程唯一执行。
  // guard 缺省自建，保持老调用方兼容。
  const g = guard || createRegistrationGuard()
  // 卸载清理：官方 register 返回 disposer，必须绑到纤程——否则 live-remove
  // 后路由泄漏，下次 apply 必撞车。桌面端官方插件写法：
  // ctx.effect(() => ctx.webServer.register({...}))。
  const disposes = []
  const reg = (entry) => g.run(() => {
    const dispose = ctx.webServer.register(entry)
    if (typeof dispose === 'function') disposes.push(dispose)
  })
  const cleanup = () => {
    while (disposes.length > 0) {
      const dispose = disposes.pop()
      try {
        dispose()
      } catch { /* 已卸载/重复清理，直接忽略 */ }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)
  /** 统一后端调用：读配置 → 归一（错地址 fetch 前即拦）→ 带 key 请求 → 统一错误形态。
   * signal 可选透传（身份探测 8s 封顶，黑洞不等死）。 */
  async function backendCall(method, path, body, signal) {
    return backendCallWith(readConfig(config), method, path, body, signal)
  }

  /** 同上，但用显式配置（健康口 POST 测候选值，不读已存）。 */
  async function backendCallWith(cfg, method, path, body, signal) {
    if (!cfg.apiKey) {
      return { ok: false, code: NEED_KEY, error: '还没配 API key：去 设置 → 小沐 填写保存。' }
    }
    const built = buildApiUrl(cfg.backendUrl, path)
    if (!built.ok) return built
    return rewriteAuthError(await fetchJson(built.url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body,
    }, signal))
  }

  /** 游标 422 映射（0.6.0）：非法游标转 CURSOR_INVALID，面板回最新页，不红字。 */
  function withCursorMapping(result) {
    if (result && result.ok === false && result.status === 422 && !result.code) {
      return { ok: false, code: CURSOR_INVALID, status: 422, error: '游标过期，已回最新页' }
    }
    return result
  }

  reg({
    kind: 'exact',
    path: '/api/muche/chat',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      const body = await readBody(req)
      const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : ''
      const images = pickImages(body)
      if (!text && !images) return sendJson(res, 400, { ok: false, error: '空消息' })
      const messageId = typeof body.message_id === 'string' ? body.message_id.trim() : ''
      const payload = { message: text }
      if (messageId) payload.message_id = messageId
      if (images) payload.images = images
      const result = await backendCall('POST', '/chat', payload)
      sendJson(res, result.ok ? 200 : 502, result)
    },
  })

  reg({
    kind: 'exact',
    path: '/api/muche/image',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      const url = new URL(req.url || '/', 'http://localhost')
      const id = url.searchParams.get('id') || ''
      const index = url.searchParams.get('index') || '0'
      if (!/^[0-9a-f-]{1,64}$/i.test(id) || !/^\d{1,3}$/.test(index)) {
        return sendJson(res, 400, { ok: false, error: '图片不存在' })
      }
      const cfg = readConfig(config)
      if (!cfg.apiKey) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' })
      }
      const built = buildApiUrl(cfg.backendUrl, `/image/${encodeURIComponent(id)}/${encodeURIComponent(index)}`)
      if (!built.ok) {
        return sendJson(res, 502, { ok: false, code: built.code, error: built.error })
      }
      let upstream
      try {
        upstream = await fetch(
          built.url,
          { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
        )
      } catch {
        return sendJson(res, 502, { ok: false, error: '图片不存在' })
      }
      if (!upstream.ok) {
        return sendJson(res, 404, { ok: false, error: '图片不存在' })
      }
      res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') || 'image/jpeg' })
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.end(buf)
    },
  })

  // 历史直读（服务端唯一真源）：首屏单页、增量小批量、游标翻页全走这里。
  // 鉴权失败返明确 code（面板按 code 分支）；后端直返形状原样透传
  // { ok, messages, has_more, next_before }（含 ingress_id/vision 供 overlay
  // 精确认领与过期图占位）。
  reg({
    kind: 'exact',
    path: '/api/muche/history',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      const url = new URL(req.url ?? '', 'http://localhost')
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 20))
      const before = url.searchParams.get('before') || ''
      const cfg = readConfig(config)
      if (!cfg.apiKey) return sendAuthError(res, NEED_KEY)
      if (!cfg.backendUrl) return sendAuthError(res, NEED_SETUP)
      let path = `/chat/history?limit=${limit}`
      if (before) path += `&before=${encodeURIComponent(before)}`
      const result = withCursorMapping(await backendCall('GET', path))
      if (result && result.ok === false && (result.code === AUTH_FAILED || result.status === 401 || result.status === 403)) {
        return sendAuthError(res, AUTH_FAILED)
      }
      sendJson(res, result.ok ? 200 : 502, result)
    },
  })

  // 统一健康口（0.6.0）：一次返回 auth＋history＋ws 三段结论＋configNs＋桥状态。
  // GET 用已存配置（30s 短 TTL 缓存）；POST 带 {backendUrl?, apiKey} 测候选值
  // （设置页保存前试连，不写配置；key 必填，地址缺省回落已存）。面板打开、
  // 设置页测试连接、排障探针共用它（旧 /test＋/status＋/ws-diag 已删）。
  // 三段并发、各 8s 封顶。
  let healthCache = null // { at, key, payload } 纤程内缓存，随纤程消亡；只缓存 GET 已存口径；只缓存 GET 已存口径
  async function runHealthChecks(effCfg) {
    const [authSettled, historySettled, wsSettled] = await Promise.allSettled([
      (async () => {
        if (!effCfg.apiKey) return { ok: false, code: NEED_KEY, error: '还没配 API key' }
        if (!effCfg.backendUrl) return { ok: false, code: NEED_SETUP, error: '还没配后端地址' }
        const me = await backendCallWith(effCfg, 'GET', '/auth/me', undefined, AbortSignal.timeout(8000))
        if (me && me.ok === true) {
          return { ok: true, userId: me.user_id || me.userId || '' }
        }
        return { ok: false, code: (me && me.code) || AUTH_FAILED, error: (me && me.error) || '身份解析失败' }
      })(),
      (async () => {
        if (!effCfg.apiKey) return { ok: false, code: NEED_KEY, error: '还没配 API key' }
        if (!effCfg.backendUrl) return { ok: false, code: NEED_SETUP, error: '还没配后端地址' }
        const r = withCursorMapping(await backendCallWith(effCfg, 'GET', '/chat/history?limit=1', undefined, AbortSignal.timeout(8000)))
        if (r && r.ok === true) return { ok: true, count: Array.isArray(r.messages) ? r.messages.length : 0 }
        return { ok: false, code: (r && r.code) || 'HISTORY_FAILED', error: (r && r.error) || '历史不可读' }
      })(),
      probeBackendUpgrade(effCfg.backendUrl, { timeoutMs: 8000 }),
    ])
    const pick = (s) => (s.status === 'fulfilled' ? s.value : { ok: false, code: 'HEALTH_FAILED', error: '检查异常' })
    return {
      ok: true,
      configNs: configNamespace(ctx),
      status: getDshBridgeStatus(),
      auth: pick(authSettled),
      history: pick(historySettled),
      ws: pick(wsSettled),
      checkedAt: new Date().toISOString(),
    }
  }
  reg({
    kind: 'exact',
    path: '/api/muche/health',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      if (req.method === 'GET') {
        const cfg = readConfig(config)
        const key = `${cfg.backendUrl}|${cfg.apiKey}`
        if (healthCache && healthCache.key === key && Date.now() - healthCache.at < 30000) {
          return sendJson(res, 200, healthCache.payload)
        }
        const payload = await runHealthChecks(cfg)
        healthCache = { at: Date.now(), key, payload }
        return sendJson(res, 200, payload)
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        const cfg = readConfig(config)
        const candidate = {
          backendUrl: typeof body.backendUrl === 'string' && body.backendUrl.trim()
            ? body.backendUrl.trim()
            : (cfg.backendUrl || ''),
          apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : '',
        }
        if (!candidate.apiKey) return sendJson(res, 400, { ok: false, error: '未填 API key' })
        return sendJson(res, 200, await runHealthChecks(candidate))
      }
      return sendJson(res, 405, { ok: false, error: '仅支持 GET/POST' })
    },
  })

  // 配置读写不在此：设置页经官方客户端设置服务（configForms→
  // settings.update/mutate），存储唯一真源是 profile patch（见 lib/config.js）。
  // 本文件只读配置，不写。旧 /test＋/status＋/ws-diag 三口已删（0.6.0 WP4），
  // 其职责收口进上面的 /health（鉴权三态由 health.auth 段替代）。

  return g.degraded
}
