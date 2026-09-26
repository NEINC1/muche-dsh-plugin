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
import { Config, importLegacyConfig } from './config.js'
import { registerRoutes } from './routes.js'
import { registerWsProxy } from './ws-proxy.js'
import { registerPanelEvents } from './panel-events.js'
import { registerDshBridge, requestDshBridgeRefresh } from './dsh-bridge.js'
import { createRegistrationGuard } from './register-guard.js'

export { Config }
export const name = 'muche-dsh-plugin'

// workspaceRegistry（dsh-workspace 插件，进程内工作区实体）与 sessionQuery
// （dsh-session-query，readTitle）由 web profile 基础层提供，桥接执行核用它
// 归拢小沐会话到专用工作区并读取自动生成标题。
// sessionController（dsh-api-session-controller，TypertRemoteService）由基础层提供，
// 桥接执行核进程内直调其 create/prompt（与人用客户端同一实现，零 wire 复制；
// 新版自定义路由不继承 Cookie 鉴权，进程内 fetch 自调即 401）。
// connection（dsh-client-connection）提供公网化鉴权门（requestRejection），
// /api/muche/* 与 ws-proxy upgrade 先行过门（与官方 open-in-app 同构）。
//
// 市场安装形态：顶层只硬依赖面板生死线
// （settings/webServer/connection）；反向桥接依赖走
// ctx.get 可选——缺失时桥接停用、面板照常，整插件不进 waiting。
export const inject = ['settings', 'webServer', 'connection']

export function apply(ctx, config) {
  void importLegacyConfig(ctx, config)
  // 双挂载守卫（2026-09-23 桌面端事故：bundles #muche + 市场 #mkt-muche 同进程
  // 双 apply，第二份撞重复路由曾致纤程暴死、桥永不启动）。主纤程唯一执行：
  // 副纤程只挂面板（由主纤程的路由服务），跳过桥接，不抢任务执行权。
  const guard = createRegistrationGuard()
  registerRoutes(ctx, config, guard)
  registerWsProxy(ctx, config, guard)
  // 面板事件下行（dsh-app:// 等非 http(s) 页原生 WS 不可用，SSE 替代）：
  // 与路由/代理同一守卫，双挂载撞重复同样降级，不中断桥接。
  registerPanelEvents(ctx, config, guard)
  if (guard.degraded) {
    console.warn('muche: 副纤程（路由已被主纤程占用），跳过反向桥接；面板由主纤程服务，工具走主纤程的桥')
    return
  }
  registerDshBridge(ctx, config)
  // 官方表单写入是 volatile-only 更新，不重挂插件：出站连接靠这条官方事件重建。
  // 面板 WS 靠客户端订阅官方配置镜像重启（见 client.js），不经此处。
  ctx.on('loader/volatile-update', () => {
    void requestDshBridgeRefresh()
  })
}
