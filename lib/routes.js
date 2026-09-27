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
 * 401/403 直接拒绝。localhost 后端调用（dsh-call）不走这些路由，不受影响。
 */
import { readConfig, configNamespace } from './config.js'
import { fetchJson } from './http.js'
import { probeBackendUpgrade } from './backend_ws.js'
import { getDshBridgeStatus } from './dsh-bridge.js'
import { createRegistrationGuard } from './register-guard.js'

export const NEED_KEY = 'NEED_KEY'
export const NEED_SETUP = 'NEED_SETUP'
export const AUTH_FAILED = 'AUTH_FAILED'

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
  /** 统一后端调用：读配置 → 带 key 请求 → 统一错误形态。
   * 空地址禁 fetch（相对地址会打中 Host 自己，静默错比报错更糟）。
   * signal 可选透传（身份探测 8s 封顶，黑洞不等死）。 */
  async function backendCall(method, path, body, signal) {
    const cfg = readConfig(config)
    if (!cfg.apiKey) {
      return { ok: false, code: NEED_KEY, error: '还没配 API key：去 设置 → 小沐 填写保存。' }
    }
    if (!cfg.backendUrl) {
      return { ok: false, code: NEED_SETUP, error: '还没配后端地址：去 设置 → 小沐 填写保存。' }
    }
    return rewriteAuthError(await fetchJson(cfg.backendUrl.replace(/\/+$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body,
    }, signal))
  }

  /**
   * 鉴权三态（无本地存档后的唯一身份口）：只判定"能不能调后端"，
   * 不组任何目录、不建任何文件。ok 即配齐且 key 有效。
   */
  async function resolveAuth() {
    const cfg = readConfig(config)
    if (!cfg.apiKey) return { state: NEED_KEY }
    if (!cfg.backendUrl) return { state: NEED_SETUP }
    const me = await backendCall('GET', '/auth/me', undefined, AbortSignal.timeout(8000))
    if (me && me.ok === true) return { state: 'ok' }
    const status = me && typeof me.status === 'number' ? me.status : 0
    if (status === 401 || status === 403 || (me && me.code === AUTH_FAILED)) return { state: AUTH_FAILED }
    throw new Error((me && me.error) || '身份解析失败')
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
      const result = await backendCall('GET', path)
      if (result && result.ok === false && (result.code === AUTH_FAILED || result.status === 401 || result.status === 403)) {
        return sendAuthError(res, AUTH_FAILED)
      }
      sendJson(res, result.ok ? 200 : 502, result)
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
      const rawUrl = typeof body.backendUrl === 'string' && body.backendUrl.trim()
        ? body.backendUrl.trim()
        : (cfg.backendUrl || '')
      if (!rawUrl) return sendJson(res, 400, { ok: false, code: NEED_SETUP, error: '请先填写后端地址' })
      const url = rawUrl.replace(/\/+$/, '')
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

  // 桥接状态自检：面板“在线”只证明路由可达，工具要的是桥接池在线。
  // 本路由原样返回 getDshBridgeStatus（主/副纤程、停用原因、依赖、WS 状态），
  // 消费者为故障排查与契约测试，面板后续可直显，禁各自重算“在线”。
  // auth 块：只看鉴权三态（无本地存档后无抽屉可报），失败只记状态。
  reg({
    kind: 'exact',
    path: '/api/muche/status',
    handler: async (req, res) => {
      if (rejected(ctx, req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
      // configNs：官方配置命名空间＝本插件 profile 条目 id，客户端凭它向
      // 官方设置服务（configForms）绑定（见 lib/config.js configNamespace）。
      sendJson(res, 200, {
        ok: true,
        status: getDshBridgeStatus(),
        configNs: configNamespace(ctx),
        auth: await readAuthSnapshot(),
      })
    },
  })

  /** 鉴权快照（只判定不落盘；失败只记状态，永不抛以免拖垮 status）。 */
  async function readAuthSnapshot() {
    try {
      const auth = await resolveAuth()
      return { state: auth.state }
    } catch {
      return { state: 'unknown' }
    }
  }

  return g.degraded
}
