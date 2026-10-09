/**
 * muche-dsh-plugin — Host 入口。
 *
 * 小沐接入的正式形态（见 muche 仓库 docs 与 PROGRESS）：
 * 小沐聊天 = 插件自绘浮层面板 + 直连后端 HTTP，**不进 dsh agent 循环、不建
 * dsh 会话**。原因（勿改回）：
 *  - dsh 会话的隐藏机制与可聊天互斥：归档会在当前会话被归档时被客户端
 *    强制清空选择；subagent 拥有的会话走 subagent 路由门控（普通 session.prompt
 *    被 agent-busy 拒绝）；
 *  - 会话内 LLM 调用会把 AGENTS.md(agent-instructions)/runtime context
 *    (plugin)/委派通知等注入成 role='user' 的消息，需要适配器过滤，且
 *    显示层仍有残留——面板形态从根上消除注入面。
 *
 * Host 职责：导出 Config（后端地址+API key+工作区目录，全 volatile，
 * 每用户本机配置，走官方表单）、注册 /api/muche/* HTTP 路由（聊天/历史/
 * 配置探针/连接测试，浏览器同源直调）+ 反向桥接（dsh-bridge.js：小沐经
 * 用户本机插件调用 dsh 会话，出站常驻 WS）。
 * 客户端代码见 client/client.js（导出 inject/apply）。
 */
import { Config, readConfig, configNamespace } from './config.js'
import { registerRoutes } from './routes.js'
import { createPanelEventsHub, registerPanelEvents } from './panel-events.js'
import { registerDshBridge } from './dsh-bridge.js'
import { createRegistrationGuard } from './register-guard.js'
import { createRuntimeState, watchHttpReadiness } from './runtime-state.js'
import { backendCallRaw } from './http.js'

export { Config }
export const name = 'muche-dsh-plugin'

// workspaceRegistry（dsh-workspace 插件，进程内工作区实体）与 sessionQuery
// （dsh-session-query，readTitle）由 web profile 基础层提供，桥接执行核用它
// 归拢小沐会话到专用工作区并读取自动生成标题。
// sessionController（dsh-api-session-controller，TypertRemoteService）由基础层提供，
// 桥接执行核进程内直调其 create/prompt（与人用客户端同一实现，零 wire 复制；
// 新版自定义路由不继承 Cookie 鉴权，进程内 fetch 自调即 401）。
// connection（dsh-client-connection）提供公网化鉴权门（requestRejection），
// /api/muche/* 先行过门（与官方 open-in-app 同构）。
//
// 市场安装形态：顶层只硬依赖面板生死线
// （settings/webServer/connection）；反向桥接依赖走
// ctx.get 可选——缺失时桥接停用、面板照常，整插件不进 waiting。
export const inject = ['settings', 'webServer', 'connection']

export function apply(ctx, config) {
  // Only the fiber which owns the routes controls this runtime. A duplicate mount cannot
  // contribute another user's bridge/config facts or initiate another backend connection.
  // A degraded mount releases everything it registered in this round, so no route is ever
  // left pointing at a runtime this fiber no longer owns.
  const guard = createRegistrationGuard()
  const runtime = createRuntimeState({ configNs: configNamespace(ctx) })
  runtime.configure(readConfig(config))
  registerRoutes(ctx, config, guard, { runtime })
  const hub = createPanelEventsHub({ runtime })
  registerPanelEvents(ctx, config, guard, { runtime, hub })
  if (guard.degraded) {
    console.warn('muche: 副纤程（路由已被主纤程占用），跳过反向桥接；面板由主纤程服务，工具走主纤程的桥')
    guard.rollbackAsDegraded()
    hub.dispose()
    runtime.dispose()
    return
  }
  const stopReadiness = watchHttpReadiness({
    runtime,
    getConfig: () => readConfig(config),
    probe: (cfg, signal) => backendCallRaw({
      base: cfg.backendUrl, apiKey: cfg.apiKey, method: 'GET', path: '/auth/me',
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    }),
  })
  const bridge = registerDshBridge(ctx, config, {
    getContext: () => runtime.context(),
    onState: (state, context) => runtime.setBridge(context, state),
  })
  hub.configure(readConfig(config), runtime.context())
  // One saved-config transition drives HTTP fencing, the existing receive connection and
  // the scoped bridge. The browser never controls backend reconnection with a copied key.
  const offConfig = ctx.on('loader/volatile-update', () => {
    const cfg = readConfig(config)
    runtime.configure(cfg)
    const context = runtime.context()
    hub.configure(cfg, context)
    void bridge.refresh(cfg, context)
  })
  ctx.on('dispose', () => {
    offConfig?.()
    stopReadiness()
    hub.dispose()
    bridge.dispose()
    runtime.dispose()
  })
}
