/**
 * HTTP 路由层：注册 /api/muche/*（浏览器同源直调，无包内 RPC 依赖）。
 *
 * 客户端面板与设置页全部走这些路由；消息只经此通道直连小沐后端——
 * 不进 dsh agent 循环（零注入）。路由注册在插件 fiber 上，随插件卸载。
 *
 * 公网化鉴权（与官方 open-in-app 同构）：每个 handler 先过
 * `ctx.connection.requestRejection(req)`——Host 围栏 + Cookie 鉴权，
 * 401/403 直接拒绝。localhost 后端调用（dsh-call）不走这些路由，不受影响。
 */
import { readConfig, DEFAULT_BACKEND } from './config.js'
import { fetchJson } from './http.js'
import { requestDshBridgeRefresh } from './dsh-bridge.js'

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
      error: 'API key 已失效：去小沐后台重签，到 设置 → 小沐 更新。',
    }
  }
  return result
}

export function registerRoutes(ctx) {
  /** 统一后端调用：读配置 → 带 key 请求 → 统一错误形态。 */
  async function backendCall(method, path, body) {
    const cfg = readConfig(ctx)
    if (!cfg.apiKey) {
      return { ok: false, error: '还没配 API key：去 设置 → 小沐 填写保存。' }
    }
    return rewriteAuthError(await fetchJson(cfg.backendUrl.replace(/\/+$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body,
    }))
  }

  ctx.webServer.register({
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

  ctx.webServer.register({
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
      const cfg = readConfig(ctx)
      if (!cfg.apiKey) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' })
      }
      let upstream
      try {
        upstream = await fetch(
          `${cfg.backendUrl.replace(/\/+$/, '')}/image/${encodeURIComponent(id)}/${encodeURIComponent(index)}`,
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

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/muche/history',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      const url = new URL(req.url ?? '', 'http://localhost')
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 20))
      const before = url.searchParams.get('before') || ''
      let path = `/chat/history?limit=${limit}`
      if (before) path += `&before=${encodeURIComponent(before)}`
      const result = await backendCall('GET', path)
      sendJson(res, result.ok ? 200 : 502, result)
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/muche/config',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      if (req.method === 'GET') {
        // 界面不展示地址：未填（或与默认值相同）即回空串，连接层仍走
        // readConfig 的默认值——输入框只显示用户自己填过的值。
        const raw = ctx.settings.get('muche') || {}
        const shownBackend = typeof raw.backendUrl === 'string' && raw.backendUrl && raw.backendUrl !== DEFAULT_BACKEND
          ? raw.backendUrl
          : ''
        const cfg = readConfig(ctx)
        sendJson(res, 200, { ok: true, ...cfg, backendUrl: shownBackend })
        return
      }
      const body = await readBody(req)
      try {
        const patch = {}
        if (typeof body.backendUrl === 'string' && body.backendUrl.trim()) patch.backendUrl = body.backendUrl.trim()
        if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim()
        if (Object.keys(patch).length > 0) await ctx.settings.update('muche', patch)
        // 配置变更后重建出站连接（换 key 即换连）：dsh 反向桥接。
        // 未加载时 refresh 为空操作，不影响保存。
        try {
          await requestDshBridgeRefresh()
        } catch { /* 桥接重连失败不影响配置保存 */ }
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/muche/test',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      const body = await readBody(req)
      const cfg = readConfig(ctx)
      const url = (typeof body.backendUrl === 'string' && body.backendUrl.trim()
        ? body.backendUrl.trim()
        : cfg.backendUrl || DEFAULT_BACKEND).replace(/\/+$/, '')
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (!key) return sendJson(res, 400, { ok: false, error: '未填 API key' })
      const result = rewriteAuthError(await fetchJson(`${url}/auth/me`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
      }, AbortSignal.timeout(10000)))
      if (!result.ok) return sendJson(res, 502, result)
      sendJson(res, 200, result.user_id ? { ok: true, userId: result.user_id } : { ok: false, error: '鉴权失败' })
    },
  })
}
