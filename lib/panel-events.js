/**
 * 面板 SSE Owner：只维护订阅扇出、心跳与面板池连接，运行时事实由 runtime 投影。
 * 首位订阅先接收完整快照再启动上游；末位退订即时释放面板额度，不影响桥接。
 * 配置驱动显式 configure；捕获连接 context 与本地连接票据拒收迟到旧帧。
 * 无 runtime 的独立消费者仍复用 createRuntimeState，不另建状态源。
 */
import { BackendWs } from './backend_ws.js'
import { ChannelConnection } from './connections.js'
import { readConfig, configNamespace, NS } from './config.js'
import { normalizeBackendUrl } from './backend.js'
import { createRuntimeState } from './runtime-state.js'
import { createRegistrationGuard } from './register-guard.js'

const SSE_HEARTBEAT_MS = 25000
const toSseLine = (frame) => `data: ${JSON.stringify(frame)}\n\n`

export function createPanelEventsHub({ createUpstream, runtime } = {}) {
  const ownsRuntime = !runtime
  const source = runtime || createRuntimeState({ configNs: NS })
  const channel = new ChannelConnection({ channel: '', createTransport: createUpstream || ((opts) => new BackendWs(opts)) })
  const subs = new Map()
  let cfg = { backendUrl: '', apiKey: '' }
  let configuredContext = null
  let lastConfigurationCode
  let connectionContext = null
  let connectionTicket = null
  let heartbeatTimer = null
  let stopRuntimeWatch = null
  let disposed = false

  function stopConnection() {
    connectionTicket = null
    connectionContext = null
    channel.stop()
  }
  function detach(res) {
    const close = subs.get(res)
    if (!close) return
    subs.delete(res)
    if (typeof res.off === 'function') res.off('close', close)
    else if (typeof res.removeListener === 'function') res.removeListener('close', close)
    if (subs.size === 0) release()
  }
  function release() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    if (stopRuntimeWatch) { stopRuntimeWatch(); stopRuntimeWatch = null }
    stopConnection()
    source.setReceive(source.context(), { status: 'idle', ready: false })
  }
  function write(res, frame) {
    try { res.write(toSseLine(frame)); return true } catch { detach(res); return false }
  }
  function broadcast(frame) {
    for (const res of [...subs.keys()]) write(res, frame)
  }
  function watchRuntime() {
    if (stopRuntimeWatch || subs.size === 0) return
    const stop = source.subscribe((snapshot) => {
      broadcast({ type: 'runtime', snapshot })
      const code = snapshot.configuration.code
      if (disposed || code === lastConfigurationCode) return
      lastConfigurationCode = code
      if (code) {
        stopConnection()
        source.setReceive(source.context(), { status: 'idle', ready: false })
      } else if (configuredContext && source.accepts(configuredContext)) syncUpstream(configuredContext)
    })
    // subscribe 立即回调；首帧写失败时 release 可能早于 disposer 返回。
    if (disposed || subs.size === 0) stop()
    else stopRuntimeWatch = stop
  }
  function startHeartbeat() {
    if (heartbeatTimer || subs.size === 0) return
    heartbeatTimer = setInterval(() => broadcast({ type: 'heartbeat', context: source.context() }), SSE_HEARTBEAT_MS)
    heartbeatTimer.unref?.()
  }
  function syncUpstream(context = source.context()) {
    if (disposed || !source.accepts(context)) return
    const target = normalizeBackendUrl(cfg.backendUrl)
    const backendUrl = target.ok ? target.url : cfg.backendUrl
    const apiKey = String(cfg.apiKey || '').trim()
    if (subs.size === 0 || source.getSnapshot().configuration.code || !apiKey || !cfg.backendUrl) {
      stopConnection()
      source.setReceive(context, { status: 'idle', ready: false })
      return
    }
    if (connectionContext && !source.accepts(connectionContext)) stopConnection()
    if (channel.hasTransport) {
      channel.sync({ backendUrl, apiKey })
      return
    }
    const capturedContext = { ...context }
    const ticket = {}
    connectionContext = capturedContext
    connectionTicket = ticket
    const current = () => !disposed && connectionTicket === ticket && source.accepts(capturedContext)
    const forward = (frame) => {
      if (current()) broadcast({ ...frame, context: capturedContext })
    }
    channel.sync({
      backendUrl,
      apiKey,
      handlers: {
        onReply: forward,
        onProactive: forward,
        onDialogueUpdated: forward,
        onError: forward,
        onStatus: (state) => { if (current()) source.setReceive(capturedContext, state) },
      },
    })
  }
  function configure(next, context = source.context()) {
    if (disposed) return false
    if (ownsRuntime) {
      source.configure(next)
      context = source.context()
    }
    if (!source.accepts(context)) return false
    cfg = { ...next }
    configuredContext = { ...context }
    broadcast({ type: 'runtime', snapshot: source.getSnapshot() })
    syncUpstream(context)
    return true
  }

  return {
    get subscriberCount() { return subs.size },
    get hasUpstream() { return channel.hasTransport },
    statusOf() {
      return {
        subscribers: subs.size,
        upstreamKeyed: channel.hasTransport,
        upstream: channel.hasTransport ? channel.getState() : null,
      }
    },
    configure,
    subscribe(res, next) {
      if (disposed) return false
      if (subs.has(res)) return true
      const close = () => detach(res)
      subs.set(res, close)
      res.on('close', close)
      if (stopRuntimeWatch) write(res, { type: 'runtime', snapshot: source.getSnapshot() })
      else watchRuntime()
      if (!subs.has(res)) return false
      startHeartbeat()
      if (next !== undefined) configure(next)
      else syncUpstream()
      return subs.has(res)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const res of [...subs.keys()]) {
        detach(res)
        try { res.end() } catch { /* 已关闭响应无需再次结束。 */ }
      }
      release()
      if (ownsRuntime) source.dispose()
    },
  }
}

export function registerPanelEvents(ctx, config, guard, options = {}) {
  const g = guard || createRegistrationGuard()
  const ownsDriver = !options.hub && !options.runtime
  const runtime = options.runtime || (!options.hub ? createRuntimeState({ configNs: typeof ctx.get === 'function' ? configNamespace(ctx) : NS }) : null)
  const hub = options.hub || createPanelEventsHub({ runtime })
  const disposes = []
  const drive = () => {
    const cfg = readConfig(config)
    if (ownsDriver) runtime.configure(cfg)
    hub.configure(cfg, runtime.context())
  }
  if (!options.hub) drive()
  const cleanup = () => {
    while (disposes.length > 0) {
      try { disposes.pop()() } catch { console.warn('muche panel-events: registration cleanup failed') }
    }
    hub.dispose()
    if (ownsDriver) runtime.dispose()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  const registered = g.run(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/api/muche/events',
      handler: (req, res) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '仅支持 GET' }))
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        hub.subscribe(res)
      },
    })
    if (typeof dispose === 'function') { disposes.push(dispose); g.track(dispose) }
  })
  if (registered && ownsDriver && typeof ctx.on === 'function') {
    const dispose = ctx.on('loader/volatile-update', drive)
    if (typeof dispose === 'function') disposes.push(dispose)
  }
  return g.degraded
}
