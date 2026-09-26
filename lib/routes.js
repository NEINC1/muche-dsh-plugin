/**
 * HTTP 路由层：注册 /api/muche/*（浏览器同源直调，无包内 RPC 依赖）。
 *
 * 客户端面板的数据（聊天/历史/同步/探针）走这些路由；消息只经此通道直连
 * 小沐后端——不进 dsh agent 循环（零注入）。配置读写不走这里：设置页经
 * 官方客户端设置服务（configForms→settings.update/mutate），存储唯一真源
 * 是 profile patch（见 lib/config.js）。路由注册在插件 fiber 上，随插件卸载。
 *
 * 公网化鉴权（与官方 open-in-app 同构）：每个 handler 先过
 * `ctx.connection.requestRejection(req)`——Host 围栏 + Cookie 鉴权，
 * 401/403 直接拒绝。localhost 后端调用（dsh-call）不走这些路由，不受影响。
 */
import { readConfig, DEFAULT_BACKEND, configNamespace } from './config.js'
import { fetchJson } from './http.js'
import { probeBackendUpgrade } from './ws-proxy.js'
import { getDshBridgeStatus } from './dsh-bridge.js'
import { createRegistrationGuard } from './register-guard.js'

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

export function registerRoutes(ctx, config, guard) {
  // 双挂载守卫（2026-09-23 桌面端事故）：第二份 apply 撞重复路由不再抛、
  // 不中断后继注册；调用方（index.js）凭 guard.degraded 决定是否起桥接，
  // 保证主纤程唯一执行。guard 缺省自建，保持老调用方兼容。
  const g = guard || createRegistrationGuard()
  // 卸载清理（同事故的另一半根因，属插件自身 bug）：官方 register 返回
  // disposer（"the disposer removing the route"，见 dsh-host-webserver），
  // 必须绑到纤程——旧代码直接丢弃，live-remove 后路由泄漏，下次 apply 必撞车。
  // 桌面端官方插件写法：ctx.effect(() => ctx.webServer.register({...}))。
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
  /** 统一后端调用：读配置 → 带 key 请求 → 统一错误形态。 */
  async function backendCall(method, path, body) {
    const cfg = readConfig(config)
    if (!cfg.apiKey) {
      return { ok: false, error: '还没配 API key：去 设置 → 小沐 填写保存。' }
    }
    return rewriteAuthError(await fetchJson(cfg.backendUrl.replace(/\/+$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body,
    }))
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

  reg({
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

  // 本地历史（OI-070 WP3）：面板显示读本地文件，不以服务端为准。
  // userId 取后端 /auth/me（dsh 代传 key，只能看到本用户）。
  reg({
    kind: 'exact',
    path: '/api/muche/local-history',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      const url = new URL(req.url ?? '', 'http://localhost')
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 20))
      try {
        const { ensureUserMessageDir, readLocalRows, pageLocalRows } = await import('./local-store.js')
        const me = await backendCall('GET', '/auth/me')
        const userId = me && me.ok === false ? '' : String((me && me.user_id) || '')
        const dir = await ensureUserMessageDir(ctx, config, userId)
        const rows = await readLocalRows(dir)
        const page = pageLocalRows(rows, limit)
        sendJson(res, 200, { ok: true, messages: page, has_more: rows.length > page.length, next_before: null })
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 本地同步触发（OI-070 WP3）：纯拉模式，拿本地游标调服务端分页拉。
  reg({
    kind: 'exact',
    path: '/api/muche/sync',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
      try {
        const { ensureUserMessageDir } = await import('./local-store.js')
        const { syncOnce, checkGeneration } = await import('./sync.js')
        const me = await backendCall('GET', '/auth/me')
        const userId = me && me.ok === false ? '' : String((me && me.user_id) || '')
        const dir = await ensureUserMessageDir(ctx, config, userId)
        const fetchPage = async (before) => {
          let path = '/chat/history?limit=50'
          if (before) path += `&before=${encodeURIComponent(before)}`
          const result = await backendCall('GET', path)
          if (!result || result.ok === false) throw new Error((result && result.error) || '同步失败')
          return result
        }
        const fetchGeneration = async () => {
          const result = await backendCall('GET', '/chat/lifecycle-generation')
          if (!result || result.ok === false) throw new Error((result && result.error) || '代际读取失败')
          return result.generation
        }
        const gen = await checkGeneration({ dir, fetchGeneration })
        const sync = await syncOnce({ dir, fetchPage })
        sendJson(res, 200, { ok: true, reset: gen.reset, generation: gen.generation, added: sync.added })
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 配置读写不在此：设置页经官方客户端设置服务（configForms→
  // settings.update/mutate），存储唯一真源是 profile patch（见 lib/config.js）。
  // 本文件只读配置（backendCall/test/代理目标），不写。

  reg({
    kind: 'exact',
    path: '/api/muche/test',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      const body = await readBody(req)
      const cfg = readConfig(config)
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

  // WS 链路探针（实时通道排障口）：浏览器侧 WS 失败
  // 是不透明错误，原因只落本机 dsh 日志。本路由在 Host 侧复用代理同一目标
  // 构造发一次哑-token upgrade，把“Host→后端”逐段结果变成 JSON（浏览器凭
  // Cookie 直开本 URL 即见，无需找日志）。哑 token 进不了鉴权，不占额度；
  // 回包不带任何 token/key，只带后端地址形态（定位“地址配成默认/丢 /api”等）。
  reg({
    kind: 'exact',
    path: '/api/muche/ws-diag',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
      const cfg = readConfig(config)
      sendJson(res, 200, await probeBackendUpgrade(cfg.backendUrl))
    },
  })

  // 桥接状态自检（2026-09-23 桌面端事故的可观测收口）：面板“在线”只证明
  // 路由可达，工具要的是桥接池在线。本路由原样返回 getDshBridgeStatus
  //（主/副纤程、停用原因、依赖、WS 状态），消费者为故障排查与契约测试，
  // 面板后续可直显，禁各自重算“在线”。
  reg({
    kind: 'exact',
    path: '/api/muche/status',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
      // configNs：官方配置命名空间＝本插件 profile 条目 id，客户端凭它向
      // 官方设置服务（configForms）绑定（见 lib/config.js configNamespace）。
      sendJson(res, 200, { ok: true, status: getDshBridgeStatus(), configNs: configNamespace(ctx) })
    },
  })

  return g.degraded
}
