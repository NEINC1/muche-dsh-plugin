/**
 * dsh 反向桥接：用户本机插件的出站常驻 WS（`channel=dsh-bridge`）。
 *
 * 方向：后端拨不进用户机器（NAT），所以不建任何入站隧道。本模块在插件所在
 * dsh 进程内持一条到后端的出站长连接；后端把该用户的 `dsh_task` 从这条连接
 * 递下来，本模块经 `dsh-call.js` 的执行核在**本机**建会话执行，结果以
 * `dsh_result` 原路回传。传输类为 `backend_ws.js` 的 `BackendWs`
 * （ping/重连/开关语义与面板 WS 一致，通道名不同故后端额度池独立）。
 *
 * 启动条件：settings 配了 `apiKey` 即起；无 key 即停。配置保存后经
 * `requestDshBridgeRefresh` 换连（ctx 不允许挂属性故用模块级单例）。
 *
 * 任务语义（一任务只执行一次）：`task_id` 进程内去重，同 id 重发直接忽略；
 * 结果只回传一次，直发失败（桥已断）即丢弃——断连的在途任务由后端终结，
 * 本侧不进离线缓冲。桥断时中止本机在途执行（AbortController，复用 HTTP
 * 时代"请求关闭即 abort"的既定路径），不留孤儿计算。
 * 同会话串行：同一 `session_id` 的任务按到达序串行执行（后任务等前任务的
 * turn/end 监听退订后再 prompt）。`dsh-call.js` 的 waitForTurn 只按
 * sessionId 过滤，并发 prompt 同一会话会同时吃到第一个 turn/end 而串扰
 * （一真一假、真 turn 丢失），故必须在桥接层串行；新会话（无 session_id）
 * 彼此独立，可并发。
 */
import { BackendWs } from './backend_ws.js'
import { readConfig } from './config.js'
import { executeDshTask } from './dsh-call.js'
import { randomUUID } from 'node:crypto'

// 去重集合上限（防常驻进程内存缓慢增长；最早的先逐出）。
const MAX_SEEN_TASK_IDS = 200

// 各主纤程 refresh 注册表：配置保存后全部重刷（幂等）。旧单例 hook 在双挂载下
// 只刷最后一个纤程，主纤程换 key 后不断连——收成集合，dispose 即摘除。
const refreshHooks = new Set()
export function requestDshBridgeRefresh() {
  if (refreshHooks.size === 0) return Promise.resolve()
  return Promise.allSettled([...refreshHooks].map((fn) => {
    try {
      return fn()
    } catch {
      // 单纤程失败不影响其他纤程的重刷。
      return undefined
    }
  })).then(() => undefined)
}

// 纤程状态聚合（/api/muche/status 与契约测试的唯一消费口）：数组而非单值，
// 双挂载下后写的副纤程不覆盖主纤程；dispose 即摘除，不留幽灵。
const fiberStates = new Set()
export function getDshBridgeStatus() {
  return {
    fibers: [...fiberStates].map((s) => ({
      mode: s.mode,
      reason: s.reason,
      deps: { ...s.deps },
      bridge: s.bridge ? s.bridge.getState() : { status: 'idle', lastError: '', buffered: 0, oldestTs: 0 },
    })),
  }
}

// 依赖缺失时的有界自愈窗口：宿主各行异步挂载，apply 时刻缺失不代表永远缺失
// （2026-09-23 桌面端静默丢桥根因）。计时器全部 unref + dispose 清理，
// 不拖住事件循环（OI-025 教训）；耗尽后静默等下一次配置保存触发。
const DEP_RETRY_DELAYS_MS = [5000, 15000, 30000]

export function registerDshBridge(ctx) {
  // 市场安装形态：桥接依赖走 ctx.get 可选——缺失时桥接停用（状态可见）、
  // 面板照常，整插件不进 waiting。依赖检查推迟到每次 refresh（启动/重存配置/
  // 有界重试），不再在 apply 时刻一判终身（桌面端启动顺序竞态曾致静默丢桥）。
  // 热路径只要 sessionController + workspaceRegistry；sessionQuery 只给
  // listWorkspaceSessions 用（当前无热路径调用方），缺时该函数返回 []。
  let disposed = false
  const seenTaskIds = new Set()
  const inflight = new Map() // task_id -> AbortController（桥断时中止本机执行）
  const sessionChains = new Map() // session_id -> tail promise（同会话串行）
  let depRetryTimer = null
  let depRetries = 0

  const bridge = new BackendWs({
    channel: 'dsh-bridge',
    onTask: (frame) => { void handleTask(frame) },
    onAppend: (frame) => { void handleAppend(frame) },
    onStatus: (st) => {
      if (st.status === 'closed' || st.status === 'idle') abortInflight('桥接已断开')
    },
  })

  // 本纤程状态（status 聚合的唯一写入点，随纤程消亡）。
  const state = {
    mode: 'starting',
    reason: '',
    deps: { sessionController: false, workspaceRegistry: false },
    bridge,
  }
  fiberStates.add(state)

  function readCfg() {
    return readConfig(ctx)
  }

  function hostUsable() {
    try {
      readCfg()
      return !disposed
    } catch {
      return false
    }
  }

  function rememberTaskId(taskId) {
    if (seenTaskIds.has(taskId)) return false
    seenTaskIds.add(taskId)
    if (seenTaskIds.size > MAX_SEEN_TASK_IDS) {
      const oldest = seenTaskIds.values().next()
      if (!oldest.done) seenTaskIds.delete(oldest.value)
    }
    return true
  }

  function abortInflight(reason) {
    for (const [taskId, ac] of inflight) {
      inflight.delete(taskId)
      try { ac.abort(new Error(reason)) } catch { /* 已结束 */ }
    }
  }

  function reply(taskId, payload) {
    try {
      bridge.sendFrame({ type: 'dsh_result', task_id: taskId, ...payload })
    } catch (error) {
      // 桥已断：结果无人收，后端会终结在途任务；本侧只记日志。
      console.error('muche dsh-bridge: 结果回传失败（桥已断）task=' + taskId.slice(0, 16),
        String(error && error.message ? error.message : error))
    }
  }

  async function handleTask(frame) {
    if (!hostUsable()) return
    const taskId = typeof frame.task_id === 'string' ? frame.task_id : ''
    if (!taskId) return
    if (!rememberTaskId(taskId)) return // 去重：同 id 重发不重复执行
    const sessionId = typeof frame.session_id === 'string' ? frame.session_id : ''
    if (sessionId) {
      // 同会话串行：排到该会话队尾，前任务结束（含监听退订）后才跑。
      const prev = sessionChains.get(sessionId) || Promise.resolve()
      const next = prev.then(() => runTask(frame, taskId), () => runTask(frame, taskId))
      sessionChains.set(sessionId, next)
      try { await next } finally {
        if (sessionChains.get(sessionId) === next) sessionChains.delete(sessionId)
      }
      return
    }
    await runTask(frame, taskId)
  }

  async function runTask(frame, taskId) {
    if (!hostUsable()) {
      reply(taskId, {
        ok: false,
        reply: '',
        session_id: typeof frame.session_id === 'string' ? frame.session_id : '',
        error: '插件已卸载',
      })
      return
    }
    const ac = new AbortController()
    inflight.set(taskId, ac)
    try {
      const { reply: text, sessionId } = await executeDshTask(ctx, {
        task: frame.task,
        session_id: frame.session_id,
        agentPreset: frame.agentPreset,
        signal: ac.signal,
      })
      reply(taskId, { ok: true, reply: text, session_id: sessionId })
    } catch (error) {
      console.error('muche dsh-bridge: 任务执行失败 task=' + taskId.slice(0, 16),
        String(error && error.message ? error.message : error))
      reply(taskId, {
        ok: false,
        reply: '',
        session_id: typeof frame.session_id === 'string' ? frame.session_id : '',
        error: String(error && error.message ? error.message : error).slice(0, 300),
      })
    } finally {
      inflight.delete(taskId)
    }
  }

  // 追单 append 链（与同会话 task 串行链独立）：append 必须趁在途 turn
  // 没结束时发出去才能并进同一轮，故不排在 task 链后；多个 append 之间
  // 按到达序串行。只发 prompt（queue 模式，人按发送键同一路径），不等
  // turn/end——在途 waiter 会收到合并后的最终结果，最终只出一个结果。
  // 若 turn 已结束才到（竞态），该 prompt 会另起一轮且无人收，需记日志；
  // 后端 DB 并单 + 执行用最新请求已覆盖绝大多数窗口。
  const appendChains = new Map() // session_id -> tail promise（append 间串行）

  async function handleAppend(frame) {
    if (!hostUsable()) return
    const appendId = typeof frame.append_id === 'string' ? frame.append_id : ''
    if (!appendId) return
    if (!rememberTaskId(appendId)) return // 去重：同 id 重发不重复执行
    const sessionId = typeof frame.session_id === 'string' ? frame.session_id : ''
    const text = typeof frame.task === 'string' ? frame.task.trim().slice(0, 4000) : ''
    if (!sessionId || !text) {
      ackAppend(appendId, sessionId, false, '缺少 session_id/task')
      return
    }
    const prev = appendChains.get(sessionId) || Promise.resolve()
    const next = prev.then(() => runAppend(frame, appendId, sessionId, text), () => runAppend(frame, appendId, sessionId, text))
    appendChains.set(sessionId, next)
    try { await next } finally {
      if (appendChains.get(sessionId) === next) appendChains.delete(sessionId)
    }
  }

  async function runAppend(frame, appendId, sessionId, text) {
    if (!hostUsable()) {
      ackAppend(appendId, sessionId, false, '插件已卸载')
      return
    }
    try {
      // 常开 signal：只满足 prompt 必传 signal 的接口要求，不主动取消；
      // 追消息进 queue 后即返回，在途 waiter 收最终合并结果。
      const ac = new AbortController()
      inflight.set(appendId, ac)
      try {
        const sc = ctx.get('sessionController')
        if (!sc) throw new Error('缺少 sessionController，反向桥接不可用')
        await sc.prompt({
          requestId: `muche-dsh-append-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, ac.signal)
      } finally {
        inflight.delete(appendId)
      }
      ackAppend(appendId, sessionId, true, '')
    } catch (error) {
      console.error('muche dsh-bridge: 追单发送失败 append=' + appendId.slice(0, 16),
        String(error && error.message ? error.message : error))
      ackAppend(appendId, sessionId, false,
        String(error && error.message ? error.message : error).slice(0, 300))
    }
  }

  function ackAppend(appendId, sessionId, ok, error) {
    try {
      bridge.sendFrame({ type: 'dsh_append_result', append_id: appendId, session_id: sessionId, ok, error: String(error || '').slice(0, 300) })
    } catch {
      // 桥已断：后端会从日志看到缺失；本侧只记日志。
      console.error('muche dsh-bridge: 追单回执发送失败（桥已断）append=' + String(appendId).slice(0, 16))
    }
  }

  function depsOk() {
    const sc = ctx.get('sessionController')
    const wr = ctx.get('workspaceRegistry')
    state.deps = { sessionController: !!sc, workspaceRegistry: !!wr }
    return !!sc && !!wr
  }

  function clearDepRetry() {
    if (depRetryTimer) {
      clearTimeout(depRetryTimer)
      depRetryTimer = null
    }
  }

  function scheduleDepRetry() {
    if (disposed || depRetryTimer || depRetries >= DEP_RETRY_DELAYS_MS.length) return
    const delay = DEP_RETRY_DELAYS_MS[depRetries++]
    depRetryTimer = setTimeout(() => {
      depRetryTimer = null
      void refresh()
    }, delay)
    // 不拖住事件循环：重试只是自愈尝试，进程退出/测试结束不等它。
    if (typeof depRetryTimer.unref === 'function') depRetryTimer.unref()
  }

  async function refresh() {
    if (disposed || !hostUsable()) return
    if (!depsOk()) {
      const missing = [
        !state.deps.sessionController && 'sessionController',
        !state.deps.workspaceRegistry && 'workspaceRegistry',
      ].filter(Boolean).join('/')
      state.mode = 'disabled'
      state.reason = `缺少本地执行依赖（${missing}）：宿主行尚未挂载，有界自愈中，重存配置立即重试`
      bridge.stop()
      scheduleDepRetry()
      return
    }
    clearDepRetry()
    depRetries = 0
    const cfg = readCfg()
    if (!cfg.apiKey) {
      state.mode = 'waiting-key'
      state.reason = '未配置 API key：去 设置 → 小沐 填写保存'
      bridge.stop()
      return
    }
    const normUrl = String(cfg.backendUrl || '').replace(/\/+$/, '')
    if (bridge.apiKey !== cfg.apiKey || String(bridge.backendUrl || '').replace(/\/+$/, '') !== normUrl) {
      // 换 key/换地址即换连：不断旧连就是下一轮半残。
      bridge.stop()
    }
    bridge.backendUrl = cfg.backendUrl
    bridge.apiKey = cfg.apiKey
    bridge.start()
    state.mode = 'active'
    state.reason = ''
  }

  refreshHooks.add(refresh)

  // 插件加载即起（有 key 才真连，无 key 时 start 内部保持 stopped）。
  void refresh()

  ctx.on('dispose', () => {
    disposed = true
    refreshHooks.delete(refresh)
    fiberStates.delete(state)
    clearDepRetry()
    abortInflight('插件卸载')
    bridge.dispose()
  })
}
