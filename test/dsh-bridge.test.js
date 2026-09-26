/**
 * dsh 反向桥接回归（node --test）：后端下发 dsh_task → 本机执行 → dsh_result 回传。
 *
 * 覆盖：
 *  - round-trip：桥接以 channel=dsh-bridge 上线 → 服务端下发 → fake
 *    sessionController 建会话/prompt/事件收回复 → 服务端收到 ok 结果；
 *  - 会话复用：带 session_id 即跳过 create；
 *  - task_id 去重：同 id 重发不重复执行；
 *  - 执行失败：回 ok:false + error，不抛；
 *  - 无 apiKey：不起连接。
 *
 * 用本地 WebSocketServer 做后端，全程无真实 dsh。
 * 启停顺序：先停客户端（dispose）再关 server，反之互相等死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { registerDshBridge, requestDshBridgeRefresh } from '../lib/dsh-bridge.js'

function makeCtx({ backendUrl = '', apiKey = 'k-test' } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'muche-bridge-'))
  const config = { backendUrl, apiKey, workspacePath: tmp }
  const sessionEvents = []
  const created = []
  const prompted = []
  const disposeFns = []
  const ctx = {
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'ws-1' }),
    },
    sessionController: {
      create: async ({ workspaceId, agentPreset }) => {
        created.push({ workspaceId, agentPreset })
        return { sessionId: 'sess-new' }
      },
      prompt: async ({ requestId, sessionId, mode, content }, signal) => {
        prompted.push({ requestId, sessionId, mode, content })
        if (signal && signal.aborted) throw new Error('aborted')
        // 生产语义：prompt 返回只表示服务端受理，turn 事件随后才到总线。
        // 必须异步发射，否则执行核的订阅还没挂上就错过 turn/end。
        setImmediate(() => {
          for (const fn of sessionEvents) {
            fn({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '办好了' }] } } })
          }
          for (const fn of [...sessionEvents]) {
            fn({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          }
        })
      },
    },
    on: (ev, fn) => {
      // 生产契约：ctx.on 返回 disposer（waitForTurn 靠它退订）。
      if (ev === 'session/event') {
        sessionEvents.push(fn)
        return () => {
          const i = sessionEvents.indexOf(fn)
          if (i >= 0) sessionEvents.splice(i, 1)
        }
      }
      if (ev === 'dispose') disposeFns.push(fn)
      return () => {}
    },
    // 生产契约：未 inject 的服务走 ctx.get 取（市场形态软依赖）。
    get: (name) => ctx[name],
    _config: config,
    _dispose: disposeFns,
    _created: created,
    _prompted: prompted,
  }
  return ctx
}

/** 起一个 fake 后端：记录上线 URL，按需下发任务、等结果。 */
async function startFakeBackend() {
  const conns = []
  const wss = new WebSocketServer({ port: 0 })
  await new Promise((resolve) => wss.on('listening', resolve))
  const port = wss.address().port
  wss.on('connection', (sock, req) => {
    const url = req.url || ''
    const st = { sock, url, results: [], nextResult: null }
    conns.push(st)
    sock.on('message', (raw) => {
      let frame = null
      try { frame = JSON.parse(String(raw)) } catch { return }
      st.results.push(frame)
      if (st.nextResult) { const r = st.nextResult; st.nextResult = null; r(frame) }
    })
  })
  return {
    url: `http://127.0.0.1:${port}`,
    conns,
    sendTask(conn, frame) { conn.sock.send(JSON.stringify(frame)) },
    waitResult(conn, ms = 5000) {
      // 按类型过滤：同连接还有 dsh_session_created 等辅助帧（生产按帧分发同构），
      // 首帧不一定是结果，轮询匹配才收。
      const hit = conn.results.find((f) => f.type === 'dsh_result')
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { clearInterval(iv); reject(new Error('等 dsh_result 超时')) }, ms)
        const iv = setInterval(() => {
          const h = conn.results.find((f) => f.type === 'dsh_result')
          if (h) { clearTimeout(timer); clearInterval(iv); resolve(h) }
        }, 20)
      })
    },
    waitConn(ms = 5000) {
      if (conns.length) return Promise.resolve(conns[conns.length - 1])
      return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (conns.length) { clearInterval(timer); resolve(conns[conns.length - 1]) }
        }, 20)
        setTimeout(() => { clearInterval(timer); reject(new Error('桥接未上线')) }, ms)
      })
    },
    async close() { await new Promise((resolve) => wss.close(resolve)) },
  }
}

async function shutdown(ctx, backend) {
  for (const fn of ctx._dispose) { try { await fn() } catch { /* 忽略 */ } }
  for (const c of backend.conns) { try { c.sock.close() } catch { /* 忽略 */ } }
  await backend.close()
}

test('round-trip：上线通道正确，下发→本机执行→ok 回传', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    assert.match(conn.url, /channel=dsh-bridge/)
    assert.match(conn.url, /token=k-test/)
    backend.sendTask(conn, { type: 'dsh_task', task_id: 't-1', task: '整理目录' })
    const res = await backend.waitResult(conn)
    assert.equal(res.task_id, 't-1')
    assert.equal(res.ok, true)
    assert.equal(res.reply, '办好了')
    assert.equal(res.session_id, 'sess-new')
    assert.equal(ctx._created.length, 1)
    assert.equal(ctx._prompted[0].sessionId, 'sess-new')
    assert.equal(ctx._prompted[0].mode, 'queue')
  } finally {
    await shutdown(ctx, backend)
  }
})

test('会话复用：带 session_id 即跳过 create', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    backend.sendTask(conn, { type: 'dsh_task', task_id: 't-2', task: '继续', session_id: 'sess-old' })
    const res = await backend.waitResult(conn)
    assert.equal(res.ok, true)
    assert.equal(res.session_id, 'sess-old')
    assert.equal(ctx._created.length, 0)
    assert.equal(ctx._prompted[0].sessionId, 'sess-old')
  } finally {
    await shutdown(ctx, backend)
  }
})

test('task_id 去重：同 id 重发不重复执行', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    const frame = { type: 'dsh_task', task_id: 't-3', task: '只跑一次' }
    backend.sendTask(conn, frame)
    await backend.waitResult(conn)
    backend.sendTask(conn, frame)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(ctx._prompted.length, 1)
    const results = conn.results.filter((f) => f.type === 'dsh_result')
    assert.equal(results.length, 1)
  } finally {
    await shutdown(ctx, backend)
  }
})

test('执行失败：回 ok:false + error，不抛', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  ctx.sessionController.prompt = async () => { throw new Error('turn 炸了') }
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    backend.sendTask(conn, { type: 'dsh_task', task_id: 't-4', task: '必败' })
    const res = await backend.waitResult(conn)
    assert.equal(res.ok, false)
    assert.match(res.error, /turn 炸了/)
  } finally {
    await shutdown(ctx, backend)
  }
})

test('无 apiKey：不起桥接连接', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url, apiKey: '' })
  try {
    registerDshBridge(ctx, ctx._config)
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(backend.conns.length, 0)
    // 配上 key 后 refresh 即上线
    // 配上 key 后 refresh 即上线（官方：表单写入提交进引用后触发 refresh）
    ctx._config.apiKey = 'k-late'
    await requestDshBridgeRefresh()
    const conn = await backend.waitConn()
    assert.match(conn.url, /token=k-late/)
  } finally {
    await shutdown(ctx, backend)
  }
})

test('同会话串行：同一 session_id 两任务各得其 turn，不串扰', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  // 每轮 prompt 按序回不同文本：并发串扰时两任务会同时吃到第一轮而同文。
  let n = 0
  ctx.sessionController.prompt = async ({ requestId, sessionId, mode, content }, signal) => {
    ctx._prompted.push({ requestId, sessionId, mode, content })
    n += 1
    const myN = n
    if (signal && signal.aborted) throw new Error('aborted')
    setImmediate(() => {
      // 注意：必须经 ctx.on 注册的同一条事件总线发射，与生产一致。
      const fns = [...(ctx._sessionEvents || [])]
      for (const fn of fns) {
        fn({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `reply-${myN}` }] } } })
      }
      for (const fn of [...fns]) {
        fn({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
      }
    })
  }
  // 暴露事件订阅表给上面的发射器（makeCtx 把订阅存在闭包里，这里改从 ctx 上取）。
  const origOn = ctx.on
  ctx._sessionEvents = []
  ctx.on = (ev, fn) => {
    if (ev === 'session/event') {
      ctx._sessionEvents.push(fn)
      return () => {
        const i = ctx._sessionEvents.indexOf(fn)
        if (i >= 0) ctx._sessionEvents.splice(i, 1)
      }
    }
    return origOn(ev, fn)
  }
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    backend.sendTask(conn, { type: 'dsh_task', task_id: 't-s1', task: '第一件', session_id: 'sess-same' })
    backend.sendTask(conn, { type: 'dsh_task', task_id: 't-s2', task: '第二件', session_id: 'sess-same' })
    const [r1, r2] = await Promise.all([
      backend.waitResult(conn, 5000).then(async (first) => {
        // 等第二个结果：fake 后端的 waitResult 只取首个 dsh_result，需轮询。
        const second = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('等第二个 dsh_result 超时')), 5000)
          const iv = setInterval(() => {
            const hits = conn.results.filter((f) => f.type === 'dsh_result')
            if (hits.length >= 2) { clearTimeout(timer); clearInterval(iv); resolve(hits[1]) }
          }, 20)
        })
        return [first, second]
      }),
    ]).then(([pair]) => pair)
    assert.equal(r1.task_id, 't-s1')
    assert.equal(r2.task_id, 't-s2')
    assert.equal(r1.reply, 'reply-1')
    assert.equal(r2.reply, 'reply-2')
    assert.equal(ctx._prompted.length, 2)
  } finally {
    await shutdown(ctx, backend)
  }
})

test('追单 append：向同一会话追消息，只发 prompt、不另起 waiter、不回 dsh_result', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    // append_id 去重：重发直接忽略，不重复 prompt。
    const frame = { type: 'dsh_append', append_id: 'a-1', session_id: 'sess-live', task: '再扫360残留' }
    backend.sendTask(conn, frame)
    backend.sendTask(conn, frame)
    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等 dsh_append_result 超时')), 5000)
      const iv = setInterval(() => {
        const hit = conn.results.find((f) => f.type === 'dsh_append_result')
        if (hit) { clearTimeout(timer); clearInterval(iv); resolve(hit) }
      }, 20)
    })
    assert.equal(ack.append_id, 'a-1')
    assert.equal(ack.ok, true)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(ctx._prompted.length, 1)
    assert.equal(ctx._prompted[0].sessionId, 'sess-live')
    assert.equal(ctx._prompted[0].mode, 'steer')
    assert.match(ctx._prompted[0].content[0].text, /再扫360残留/)
    assert.equal(conn.results.filter((f) => f.type === 'dsh_result').length, 0)
  } finally {
    await shutdown(ctx, backend)
  }
})

test('占位追单：首轮未结束无真 id 时按 run_id 命中在途会话（steer）', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  // 手动 turn：prompt 只记录不发射，append 到达时 turn 仍在途。
  ctx.sessionController.prompt = async ({ requestId, sessionId, mode, content }, signal) => {
    ctx._prompted.push({ requestId, sessionId, mode, content })
    if (signal && signal.aborted) throw new Error('aborted')
  }
  // 捕获事件订阅（与串行用例同一手法），结尾手动关 turn。
  const origOn = ctx.on
  ctx._sessionEvents = []
  ctx.on = (ev, fn) => {
    if (ev === 'session/event') {
      ctx._sessionEvents.push(fn)
      return () => {
        const i = ctx._sessionEvents.indexOf(fn)
        if (i >= 0) ctx._sessionEvents.splice(i, 1)
      }
    }
    return origOn(ev, fn)
  }
  const waitFor = (cond, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待超时:' + what)), 5000)
    const iv = setInterval(() => {
      let ok = false
      try { ok = cond() } catch { /* 继续等 */ }
      if (ok) { clearTimeout(timer); clearInterval(iv); resolve() }
    }, 20)
  })
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    // 新会话任务（无 session_id、带 run_id）：后端占位行尚无真 id。
    backend.sendTask(conn, { type: 'dsh_task', task_id: 't-live', run_id: 'r-live', task: '全盘扫描' })
    await waitFor(() => ctx._prompted.length >= 1, '首条 prompt')
    assert.equal(ctx._prompted[0].mode, 'queue')
    // 早期上报：后端回填占位行用。
    await waitFor(
      () => conn.results.some((f) => f.type === 'dsh_session_created' && f.run_id === 'r-live'),
      'dsh_session_created 上报',
    )
    const created = conn.results.find((f) => f.type === 'dsh_session_created')
    assert.equal(created.session_id, 'sess-new')
    // 追单不带 session_id、只带 run_id：必须命中同一会话 steer 追入。
    backend.sendTask(conn, { type: 'dsh_append', append_id: 'a-run', run_id: 'r-live', task: '汇报进度' })
    await waitFor(() => ctx._prompted.length >= 2, '追单 prompt')
    assert.equal(ctx._prompted[1].sessionId, 'sess-new')
    assert.equal(ctx._prompted[1].mode, 'steer')
    assert.match(ctx._prompted[1].content[0].text, /汇报进度/)
    await waitFor(
      () => conn.results.some((f) => f.type === 'dsh_append_result' && f.append_id === 'a-run' && f.ok === true),
      '追单回执 ok',
    )
    // 手动关 turn：首轮结果只出一个。
    for (const fn of [...ctx._sessionEvents]) {
      fn({ id: 'sess-new' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }
    const res = await backend.waitResult(conn)
    assert.equal(res.ok, true)
    assert.equal(res.session_id, 'sess-new')
  } finally {
    await shutdown(ctx, backend)
  }
})

test('追单无在途会话：诚实回未知，不伪造送达、不 prompt', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    backend.sendTask(conn, { type: 'dsh_append', append_id: 'a-ghost', run_id: 'r-gone', task: '追一个不存在的' })
    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等 dsh_append_result 超时')), 5000)
      const iv = setInterval(() => {
        const hit = conn.results.find((f) => f.type === 'dsh_append_result')
        if (hit) { clearTimeout(timer); clearInterval(iv); resolve(hit) }
      }, 20)
    })
    assert.equal(ack.ok, false)
    assert.match(ack.error, /未知会话/)
    assert.equal(ctx._prompted.length, 0)
  } finally {
    await shutdown(ctx, backend)
  }
})

test('追单转向不可用：回落 queue 重试，不静默丢', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  let calls = 0
  ctx.sessionController.prompt = async ({ requestId, sessionId, mode, content }, signal) => {
    ctx._prompted.push({ requestId, sessionId, mode, content })
    if (signal && signal.aborted) throw new Error('aborted')
    calls += 1
    if (calls === 1) throw new Error('session/steer-unavailable: current turn no longer accepts steering')
  }
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    backend.sendTask(conn, { type: 'dsh_append', append_id: 'a-fb', session_id: 'sess-fb', task: '补一句' })
    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等 dsh_append_result 超时')), 5000)
      const iv = setInterval(() => {
        const hit = conn.results.find((f) => f.type === 'dsh_append_result')
        if (hit) { clearTimeout(timer); clearInterval(iv); resolve(hit) }
      }, 20)
    })
    assert.equal(ack.ok, true)
    assert.equal(ctx._prompted.length, 2)
    assert.equal(ctx._prompted[0].mode, 'steer')
    assert.equal(ctx._prompted[1].mode, 'queue')
  } finally {
    await shutdown(ctx, backend)
  }
})

test('WP2 turn/end 六终态收敛：成功透传，失败带因，不 stuck', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  // 按序消费 reason 队列：每轮 prompt 发一条 turn/end。
  const reasons = [
    { kind: 'completed', text: '成了', ok: true },
    { kind: 'max-tokens', text: '截断但可用', ok: true },
    { kind: 'aborted', ok: false, match: /取消/ },
    { kind: 'blocked', ok: false, match: /阻塞/ },
    { kind: 'interrupted', ok: false, match: /中断/ },
    { kind: 'error', error: { message: 'boom-wp2' }, ok: false, match: /boom-wp2/ },
  ]
  let n = 0
  const origOn = ctx.on
  ctx._sessionEvents = []
  ctx.on = (ev, fn) => {
    if (ev === 'session/event') {
      ctx._sessionEvents.push(fn)
      return () => {
        const i = ctx._sessionEvents.indexOf(fn)
        if (i >= 0) ctx._sessionEvents.splice(i, 1)
      }
    }
    return origOn(ev, fn)
  }
  ctx.sessionController.prompt = async ({ requestId, sessionId, mode, content }, signal) => {
    ctx._prompted.push({ requestId, sessionId, mode, content })
    if (signal && signal.aborted) throw new Error('aborted')
    const spec = reasons[n++]
    setImmediate(() => {
      const fns = [...ctx._sessionEvents]
      if (spec.text) {
        for (const fn of fns) {
          fn({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: spec.text }] } } })
        }
      }
      const reason = { kind: spec.kind }
      if (spec.error) reason.error = spec.error
      for (const fn of [...fns]) {
        fn({ id: sessionId }, { type: 'turn/end', data: { reason } })
      }
    })
  }
  const waitTask = (taskId, ms = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等结果超时:' + taskId)), ms)
    const iv = setInterval(() => {
      const hit = conn.results.find((f) => f.type === 'dsh_result' && f.task_id === taskId)
      if (hit) { clearTimeout(timer); clearInterval(iv); resolve(hit) }
    }, 20)
  })
  let conn
  try {
    registerDshBridge(ctx, ctx._config)
    conn = await backend.waitConn()
    for (let i = 0; i < reasons.length; i++) {
      const taskId = `t-term-${i}`
      backend.sendTask(conn, { type: 'dsh_task', task_id: taskId, task: '事项' + i })
      const res = await waitTask(taskId)
      const spec = reasons[i]
      assert.equal(res.ok, spec.ok, `终态 ${spec.kind} ok 收敛错误`)
      if (spec.ok) {
        assert.match(res.reply, new RegExp(spec.text))
      } else {
        assert.match(res.error, spec.match)
      }
    }
    // 六轮各执行一次，无 stuck（prompt 六次，结果六个）。
    assert.equal(ctx._prompted.length, reasons.length)
    assert.equal(conn.results.filter((f) => f.type === 'dsh_result').length, reasons.length)
  } finally {
    await shutdown(ctx, backend)
  }
})

test('WP3 授权拦截：命中在途小沐会话即认领，他会话透传', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  // prompt 只记录不发射，turn 常年在途；捕获 waterfall 拦截器。
  ctx.sessionController.prompt = async ({ requestId, sessionId, mode, content }, signal) => {
    ctx._prompted.push({ requestId, sessionId, mode, content })
    if (signal && signal.aborted) throw new Error('aborted')
  }
  const origOn = ctx.on
  ctx._waterfall = {}
  ctx.on = (ev, fn, opts) => {
    if (ev === 'approval/request' || ev === 'user-questions/request') {
      ctx._waterfall[ev] = { fn, opts }
      return () => { delete ctx._waterfall[ev] }
    }
    return origOn(ev, fn, opts)
  }
  const waitFor = (cond, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待超时:' + what)), 5000)
    const iv = setInterval(() => {
      let ok = false
      try { ok = cond() } catch { /* 继续等 */ }
      if (ok) { clearTimeout(timer); clearInterval(iv); resolve() }
    }, 20)
  })
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    // prepend 先于转发器/UI（spike1 顺序保证）。
    assert.equal(ctx._waterfall['approval/request'].opts.prepend, true)
    assert.equal(ctx._waterfall['user-questions/request'].opts.prepend, true)
    backend.sendTask(conn, { type: 'dsh_task', task_id: 't-i1', run_id: 'r-i1', task: '删文件' })
    await waitFor(() => ctx._prompted.length >= 1, '首条 prompt')
    // 他会话：一律 next() 透传，不拦截。
    const delegated = await ctx._waterfall['approval/request'].fn(
      { agent: { id: 'sess-stranger' }, toolName: 'bash' },
      () => Promise.resolve('ui-delegated'),
    )
    assert.equal(delegated, 'ui-delegated')
    assert.ok(!conn.results.some((f) => f.type === 'dsh_interactive'))
    // 自有会话：认领，上行 dsh_interactive，等决议。
    const approvalP = ctx._waterfall['approval/request'].fn(
      { agent: { id: 'sess-new' }, toolName: 'bash', callId: 'call-1', reason: '删文件' },
      () => Promise.resolve('ui-must-not-run'),
    )
    await waitFor(
      () => conn.results.some((f) => f.type === 'dsh_interactive' && f.kind === 'approval'),
      'dsh_interactive 上行',
    )
    const up = conn.results.find((f) => f.type === 'dsh_interactive')
    assert.equal(up.run_id, 'r-i1')
    assert.equal(up.session_id, 'sess-new')
    assert.equal(up.interactive_id, 'r-i1:approval:call-1')
    assert.equal(up.payload.toolName, 'bash')
    // 后端决议放行：waterfall 认领值原样返回。
    backend.sendTask(conn, {
      type: 'dsh_decide', run_id: 'r-i1',
      interactive_id: 'r-i1:approval:call-1', outcome: 'allowed-once', answer: null,
    })
    assert.equal(await approvalP, 'allowed-once')
  } finally {
    await shutdown(ctx, backend)
  }
})

test('WP3 提问拦截：答案原样回 waterfall，桥断失败闭环', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  ctx.sessionController.prompt = async ({ requestId, sessionId, mode, content }, signal) => {
    ctx._prompted.push({ requestId, sessionId, mode, content })
    if (signal && signal.aborted) throw new Error('aborted')
  }
  const origOn = ctx.on
  ctx._waterfall = {}
  ctx.on = (ev, fn, opts) => {
    if (ev === 'approval/request' || ev === 'user-questions/request') {
      ctx._waterfall[ev] = { fn, opts }
      return () => { delete ctx._waterfall[ev] }
    }
    return origOn(ev, fn, opts)
  }
  const waitFor = (cond, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待超时:' + what)), 5000)
    const iv = setInterval(() => {
      let ok = false
      try { ok = cond() } catch { /* 继续等 */ }
      if (ok) { clearTimeout(timer); clearInterval(iv); resolve() }
    }, 20)
  })
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    backend.sendTask(conn, { type: 'dsh_task', task_id: 't-i2', run_id: 'r-i2', task: '清磁盘' })
    await waitFor(() => ctx._prompted.length >= 1, '首条 prompt')
    const questionP = ctx._waterfall['user-questions/request'].fn(
      {
        agent: { id: 'sess-new' },
        questions: [{ id: 'q1', question: '删吗？', options: [{ label: '删' }, { label: '留' }] }],
      },
      () => Promise.resolve('ui-must-not-run'),
    )
    await waitFor(
      () => conn.results.some((f) => f.type === 'dsh_interactive' && f.kind === 'question'),
      'dsh_interactive 上行',
    )
    const up = conn.results.find((f) => f.type === 'dsh_interactive' && f.kind === 'question')
    assert.equal(up.interactive_id, 'r-i2:question:q1')
    assert.equal(up.payload.questions[0].options.length, 2)
    const answer = { answers: [{ id: 'q1', selected: ['删'] }] }
    backend.sendTask(conn, {
      type: 'dsh_decide', run_id: 'r-i2',
      interactive_id: 'r-i2:question:q1', outcome: null, answer,
    })
    assert.deepEqual(await questionP, answer)
    // 新挂起在桥断时失败闭环：授权回 unavailable。
    const approvalP = ctx._waterfall['approval/request'].fn(
      { agent: { id: 'sess-new' }, toolName: 'bash', callId: 'call-9' },
      () => Promise.resolve('ui-must-not-run'),
    )
    await waitFor(
      () => conn.results.some((f) => f.type === 'dsh_interactive' && f.interactive_id === 'r-i2:approval:call-9'),
      '第二个挂起上行',
    )
    for (const fn of ctx._dispose) { try { await fn() } catch { /* 忽略 */ } }
    assert.equal(await approvalP, 'unavailable')
  } finally {
    await shutdown(ctx, backend)
  }
})

test('WP3 turn 终结清掉该 run 的交互等待（不留 treo tool）', async () => {
  const backend = await startFakeBackend()
  const ctx = makeCtx({ backendUrl: backend.url })
  ctx.sessionController.prompt = async ({ requestId, sessionId, mode, content }, signal) => {
    ctx._prompted.push({ requestId, sessionId, mode, content })
    if (signal && signal.aborted) throw new Error('aborted')
  }
  const origOn = ctx.on
  ctx._sessionEvents = []
  ctx._waterfall = {}
  ctx.on = (ev, fn, opts) => {
    if (ev === 'session/event') {
      ctx._sessionEvents.push(fn)
      return () => {
        const i = ctx._sessionEvents.indexOf(fn)
        if (i >= 0) ctx._sessionEvents.splice(i, 1)
      }
    }
    if (ev === 'approval/request' || ev === 'user-questions/request') {
      ctx._waterfall[ev] = { fn, opts }
      return () => { delete ctx._waterfall[ev] }
    }
    return origOn(ev, fn, opts)
  }
  const waitFor = (cond, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待超时:' + what)), 5000)
    const iv = setInterval(() => {
      let ok = false
      try { ok = cond() } catch { /* 继续等 */ }
      if (ok) { clearTimeout(timer); clearInterval(iv); resolve() }
    }, 20)
  })
  try {
    registerDshBridge(ctx, ctx._config)
    const conn = await backend.waitConn()
    backend.sendTask(conn, { type: 'dsh_task', task_id: 't-pend', run_id: 'r-pend', task: '删文件' })
    await waitFor(() => ctx._prompted.length >= 1, '首条 prompt')
    const approvalP = ctx._waterfall['approval/request'].fn(
      { agent: { id: 'sess-new' }, toolName: 'bash', callId: 'call-1' },
      () => Promise.resolve('ui-must-not-run'),
    )
    await waitFor(
      () => conn.results.some((f) => f.type === 'dsh_interactive'),
      'dsh_interactive 上行',
    )
    // turn 先结束了（后端没回决议）：等待必须终结，不能 treo。
    for (const fn of [...ctx._sessionEvents]) {
      fn({ id: 'sess-new' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }
    assert.equal(await approvalP, 'unavailable')
    const res = await backend.waitResult(conn)
    assert.equal(res.ok, true)
  } finally {
    await shutdown(ctx, backend)
  }
})
