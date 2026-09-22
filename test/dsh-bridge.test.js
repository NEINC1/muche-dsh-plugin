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
  const settings = {
    muche: { backendUrl, apiKey, workspacePath: tmp },
  }
  const sessionEvents = []
  const created = []
  const prompted = []
  const disposeFns = []
  const ctx = {
    settings: {
      register() {},
      get: (ns) => settings[ns],
      update: async (ns, patch) => Object.assign(settings[ns], patch),
    },
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
    _settings: settings,
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
      const hit = conn.results.find((f) => f.type === 'dsh_result')
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { conn.nextResult = null; reject(new Error('等 dsh_result 超时')) }, ms)
        conn.nextResult = (frame) => { clearTimeout(timer); resolve(frame) }
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
    registerDshBridge(ctx)
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
    registerDshBridge(ctx)
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
    registerDshBridge(ctx)
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
    registerDshBridge(ctx)
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
    registerDshBridge(ctx)
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(backend.conns.length, 0)
    // 配上 key 后 refresh 即上线
    await ctx.settings.update('muche', { apiKey: 'k-late' })
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
    registerDshBridge(ctx)
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
    registerDshBridge(ctx)
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
    assert.equal(ctx._prompted[0].mode, 'queue')
    assert.match(ctx._prompted[0].content[0].text, /再扫360残留/)
    assert.equal(conn.results.filter((f) => f.type === 'dsh_result').length, 0)
  } finally {
    await shutdown(ctx, backend)
  }
})
