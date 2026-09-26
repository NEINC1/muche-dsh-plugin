/**
 * 小沐调用 dsh 的本地执行核（进程内直调，见下）+ 反向桥接由 dsh-bridge.js 承接。
 *
 * 传输方向：后端不再 HTTP 直调本机插件路由；用户本机插件经出站桥接 WS
 * （`channel=dsh-bridge`）收 `dsh_task`，在本文件 `executeDshTask` 里执行，
 * 结果原路回传。后端按用户路由，无按用户回调用地址配置。
 *
 * 执行机制（按 dsh tag 源码编写：进程内直调）：
 * 新版 Web/API 走进程级 bootstrap token + 签名 Cookie 鉴权，经 `webServer.register()`
 * 注册的自定义路由**不自动继承**鉴权；插件内 fetch 自调 `/api/session/create`
 * 不带 Cookie 即 401。治本：与官方 `ui-deliverables/present-open.ts` 同构——
 * Host 进程内直调 `ctx.sessionController.create/prompt`（`TypertRemoteService` 的
 * `@Remote` 方法即普通实例方法，进程内直调零鉴权、零 wire 复制）。
 * 真源：`packages/api/session-controller/src/index.ts`（`@Remote('create'/'prompt')`）、
 * `src/types.ts`（`SessionCreateRequest`/`SessionPromptRequest`）。
 *
 * - 拿回复：**进程内事件订阅**——`ctx.on('session/event')` 与官方 `compaction` 等包
 *   同一条事件总线（`packages/core/session/src/index.ts:72` 类型声明）；过滤目标
 *   sessionId，收 `assistant/message` 文本，`turn/end` 按 `reason.kind` 判定完成
 *   （零轮询、无 WS 断线丢帧窗口）。
 *   事件词汇真源：`packages/core/session/src/types.ts`（`SessionEventMap`；
 *   `reason.kind` ∈ completed/aborted/blocked/error/max-tokens/interrupted）。
 *
 * 每用户隔离：每个用户的 dsh 实例装自己的插件，会话建在用户自己的 dsh 里，
 * 侧边栏可见、可旁观。
 *
 * 专用工作区：所有小沐会话归属 `~/muche-dsh-workspace`
 * （Config.workspacePath 可配置，Windows 兼容零路径硬编码），与用户代码
 * 目录隔离；标题由 dsh 自动生成（不固定不手动设置）。
 *
 * 预设（按 tag 定）：旧 `code` 预设已不存在，功能全的对应项为
 * `ptc`（`packages/preset/agent-presets/presets/ptc/preset.yml`）。
 * 生产化时应为小沐调用建受限 preset（只读工具集 + 独立工作区），见 PROGRESS。
 */
import { randomUUID } from 'node:crypto'

import { ensureWorkspace } from './workspace.js'

// turn 超时是防挂死兜底，不是业务时限：dsh agent 干实事（多步工具调用）一轮
// 可能远超 3 分钟。超时对齐 3h：长任务继续等结果、不丢弃；
// 排序闭合 插件 turn(3h) < 后端等待(3h+60s) < 后端 durable 执行 lease(3h+180s)。
export const TURN_TIMEOUT_MS = 3 * 3600 * 1000

// 默认预设：dsh 新版的功能全预设为 `ptc`（旧 `code` 已移除）。
export const DEFAULT_AGENT_PRESET = 'ptc'

/**
 * 等一个会话的回复（进程内事件订阅，与官方 compaction 等包同一条事件总线）。
 * 收集 assistant 文本；`turn/end` 按 `reason.kind` 判定完成或失败；
 * 超时抛错（调用方降级）。
 * 事件词汇真源：`packages/core/session/src/types.ts`（`SessionEventMap`：
 * `assistant/message` 数据形 `{turn, step, message:{content}, stream, usage?}`，
 * `turn/end` 数据形 `{turn, reason:{kind}}`；旧 `turn/error`/`stream/error`
 * 在新词汇中不存在）。
 */
function waitForTurn(ctx, sessionId, signal, timeoutMs = TURN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const texts = []
    const disposer = ctx.on('session/event', (session, event) => {
      if (!session || session.id !== sessionId) return
      try {
        if (event.type === 'assistant/message') {
          const blocks = event.data && event.data.message && event.data.message.content
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
            }
          }
        } else if (event.type === 'turn/end') {
          const reason = event.data && event.data.reason
          const kind = reason && reason.kind ? reason.kind : 'completed'
          done()
          if (kind === 'completed' || kind === 'max-tokens') {
            resolve({ texts: [...texts] })
          } else if (kind === 'aborted') {
            reject(new Error('dsh turn 已取消'))
          } else if (kind === 'blocked') {
            reject(new Error('dsh turn 被阻塞'))
          } else if (kind === 'interrupted') {
            reject(new Error('dsh turn 已中断（崩溃孤儿轮补关）'))
          } else {
            const detail = reason && reason.error
              ? String(reason.error.message || JSON.stringify(reason.error)).slice(0, 300)
              : kind
            reject(new Error(`dsh turn 失败: ${detail}`))
          }
        }
      } catch (error) {
        done()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    const onAbort = () => {
      done()
      reject(new Error('dsh-call 已取消'))
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error(`dsh 会话 ${sessionId} 超时（${timeoutMs}ms 无 turn/end）`))
    }, timeoutMs)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      disposer()
    }
    signal.addEventListener('abort', onAbort)
  })
}

/**
 * 建会话（进程内直调 sessionController.create，与人用客户端同一实现）。
 * 复用语义：有 session_id 即跳过本步（调用方保证会话存在）。
 */
async function createSession(ctx, workspaceId, agentPreset) {
  const sc = ctx.get('sessionController')
  if (!sc) throw new Error('缺少 sessionController，反向桥接不可用')
  const value = await sc.create({ workspaceId, agentPreset })
  if (!value || !value.sessionId) throw new Error('dsh session.create 未返回 sessionId')
  return value.sessionId
}

/**
 * 发消息（进程内直调 sessionController.prompt，与人用客户端同一实现）。
 * requestId 为 client-minted 幂等身份（服务端按 rpcId 去重，
 * 同 id 重发回 accepted 不重复执行，真源 commands.ts:321）。
 * signal 必传：prompt(request, signal) 无 signal 即 `throwIfAborted` 崩溃。
 * mode 语义（上游 agent 原语）：`queue` = 下一轮（人按发送键的同一路径）；
 * `steer` = 当前轮下一个 step 边界（闲时自动开新轮）。在途追加必须用
 * `steer`——`queue` 进的是下一轮，在途 waiter 只等首轮 `turn/end`，
 * 追加轮会变成无人收的孤儿，“单结果”不成立。
 */
async function promptSession(ctx, sessionId, text, signal, mode = 'queue') {
  const sc = ctx.get('sessionController')
  if (!sc) throw new Error('缺少 sessionController，反向桥接不可用')
  await sc.prompt({
    requestId: `muche-dsh-${randomUUID()}`,
    sessionId,
    mode,
    content: [{ type: 'text', text }],
  }, signal)
}

/**
 * 本地执行核（桥接与历史 HTTP 路由共用，当前唯一调用方为 dsh-bridge.js）。
 *
 * 步骤：专用工作区（幂等）→ 会话复用（有 session_id 即延续）或新建 →
 * queue 发消息（与人按发送键同一路径）→ 进程内事件订阅等 turn/end。
 * signal 由调用方提供（桥接：任务执行期常开；取消语义由调用方决定）。
 *
 * @returns {{reply: string, sessionId: string}} reply 为空时填占位（调用方如实回传）。
 */
export async function executeDshTask(ctx, config, { task, session_id, agentPreset, signal, onSessionCreated }) {
  const text = typeof task === 'string' ? task.trim().slice(0, 4000) : ''
  if (!text) throw new Error('缺少 task')
  // 0. 专用工作区(幂等:目录存在 + dsh 工作区实体存在)
  const { workspaceId } = await ensureWorkspace(ctx, config)
  // 1. 会话:复用(有 session_id -> 跳过 create,上下文延续)或新建
  //    （复用/新开由小沐在 session 别名里决定，系统只执行不判断）
  let sessionId = typeof session_id === 'string' && session_id ? session_id : ''
  if (!sessionId) {
    // 建在专用工作区(路径单一真源在 workspace.js);标题不设——dsh 自动生成,侧边栏可读
    sessionId = await createSession(ctx, workspaceId, agentPreset || DEFAULT_AGENT_PRESET)
    // 新建落定即通知调用方（桥接层登记在途映射＋上报后端回填占位行；只调一次）。
    if (typeof onSessionCreated === 'function') onSessionCreated(sessionId)
  }
  // 2. 发消息(queue 模式 = 人按发送键的同一路径)
  await promptSession(ctx, sessionId, text, signal)
  // 3. 进程内事件订阅等回复(零轮询)
  const { texts } = await waitForTurn(ctx, sessionId, signal)
  const reply = texts.join('\n').trim()
  return { reply: reply || '（dsh 未返回文本）', sessionId }
}

export { promptSession }
