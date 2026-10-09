/** Real WS contract, fake upstream host; no provider/network credentials. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { registerDshBridge } from '../lib/dsh-bridge.js'
import { createRuntimeState } from '../lib/runtime-state.js'

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'muche-host-'))
  const listeners = new Set(), disposers = [], waterfall = {}, prompts = [], frames = [], connections = []
  const wss = new WebSocketServer({ port: 0 })
  await new Promise((r) => wss.on('listening', r))
  let socket
  wss.on('connection', (ws, request) => {
    socket = ws
    const connection = { socket: ws, apiKey: new URL(request.url, 'http://fixture.test').searchParams.get('token'), frames: [] }
    connections.push(connection)
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw))
      frames.push(frame)
      connection.frames.push(frame)
      // 真实后端行为：收到 dsh_hello 即回登记确认。
      if (frame.type === 'dsh_hello') ws.send(JSON.stringify({ type: 'dsh_hello_ack', ok: true, host_id: frame.host_id, protocol: frame.protocol }))
    })
    ws.send(JSON.stringify({ type: 'hello' }))
  })
  const emit = (type, data) => { for (const fn of [...listeners]) fn({ id: 'session' }, { type, data }) }
  const controller = {
    create: async () => ({ sessionId: 'session' }),
    inspect: async (id) => { if (id !== 'session') throw Object.assign(new Error('deleted'), { code: 'session/not-found' }); return { sessionId: id } },
    prompt: async (req) => {
      prompts.push(req)
      if (req.mode === 'queue') { emit('turn/start', { turn: prompts.length }); emit('user/message', { source: { kind: 'user', rpcId: req.requestId } }) }
      return { accepted: true }
    },
  }
  const ctx = {
    get: (name) => name === 'sessionController' ? controller : name === 'workspaceRegistry' ? { resolveByPath: async () => ({ id: 'workspace' }) } : name === 'agents' ? { get: (sid) => sid === 'session' ? { steer: (message) => { prompts.push({ mode: 'steer', sessionId: sid, content: message.content, requestId: message.source.rpcId }) } } : undefined } : undefined,
    on: (name, fn) => {
      if (name === 'session/event') { listeners.add(fn); return () => listeners.delete(fn) }
      if (name === 'dispose') disposers.push(fn)
      else waterfall[name] = fn
      return () => { delete waterfall[name] }
    },
  }
  const config = { backendUrl: `http://127.0.0.1:${wss.address().port}`, apiKey: 'test-only', workspacePath: directory, bridgeId: randomUUID() }
  const runtime = createRuntimeState({ configNs: 'bridge-ws-test' })
  runtime.configure(config)
  const bridge = registerDshBridge(ctx, config, { getContext: runtime.context, onState: (state, context) => runtime.setBridge(context, state) })
  async function wait(predicate) {
    const until = Date.now() + 2000
    while (!predicate()) { if (Date.now() >= until) throw new Error('fixture timeout'); await new Promise((r) => setTimeout(r, 5)) }
    return frames.find(predicate)
  }
  await wait(() => frames.some((f) => f.type === 'dsh_hello'))
  await wait(() => bridge.getState().phase === 'ready')
  const send = (frame) => socket.send(JSON.stringify(frame))
  const find = async (type, match = () => true) => { await wait(() => frames.some((f) => f.type === type && match(f))); return frames.find((f) => f.type === type && match(f)) }
  const findIn = async (connection, type, match = () => true) => { await wait(() => connection.frames.some((frame) => frame.type === type && match(frame))); return connection.frames.find((frame) => frame.type === type && match(frame)) }
  const switchConfig = async (patch) => {
    Object.assign(config, patch)
    runtime.configure(config)
    await bridge.refresh(config, runtime.context())
    await wait(() => connections.at(-1)?.apiKey === config.apiKey && bridge.getState().phase === 'ready')
    const connection = connections.at(-1)
    await findIn(connection, 'dsh_hello')
    return connection
  }
  const start = async (extra = {}) => { send({ type: 'dsh_task', task_id: 'task', run_id: 'run', task: 'work', ...extra }); await find('dsh_task_started', (frame) => frame.task_id === (extra.task_id || 'task')) }
  const finish = () => { emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } }); emit('turn/end', { turn: 1, reason: { kind: 'completed' } }) }
  return { frames, connections, send, find, findIn, switchConfig, wait, start, finish, emit, waterfall, prompts, controller, bridge, runtime, listeners, close: async () => { for (const fn of disposers) fn(); runtime.dispose(); for (const connection of connections) connection.socket.close(); await new Promise((r) => wss.close(r)); rmSync(directory, { recursive: true, force: true }) } }
}

test('hello, admission and final result are separate authoritative observations', async () => {
  const f = await fixture()
  try {
    assert.equal(f.bridge.getState().phase, 'ready')
    assert.equal(f.bridge.getState().startupComplete, true)
    assert.equal(f.frames.filter((x) => x.type === 'dsh_hello').length, 1, '真实 hello 的第二次 open 状态不得重复登记')
    await f.start()
    assert.equal(f.frames.find((x) => x.type === 'dsh_hello').protocol, 2)
    assert.ok(!f.frames.some((x) => x.type === 'dsh_result'))
    f.finish()
    assert.equal((await f.find('dsh_result')).reply, 'done')
    assert.equal(f.listeners.size, 0)
  } finally { await f.close() }
})

test('disposing a host cannot start another queued provider turn', async () => {
  const f = await fixture()
  await f.start({ session_id: 'session' })
  f.send({ type: 'dsh_task', task_id: 'queued', run_id: 'next', session_id: 'session', task: 'queued work' })
  await new Promise((r) => setTimeout(r, 10))
  await f.close()
  assert.equal(f.prompts.length, 1)
  assert.equal(f.listeners.size, 0)
})

test('a queued request cannot intercept or steer another UI turn in the same session', async () => {
  const f = await fixture()
  let requestId
  f.controller.prompt = async (req) => { f.prompts.push(req); requestId = req.requestId; return { accepted: true } }
  try {
    await f.start({ session_id: 'session' })
    f.emit('turn/start', { turn: 0 })
    f.emit('user/message', { source: { rpcId: 'foreign-ui-request' } })
    assert.equal(f.waterfall['approval/request']({ agent: { id: 'session' }, callId: 'foreign' }, () => 'other-ui'), 'other-ui')
    const append = { type: 'dsh_append', append_id: 'pending', run_id: 'run', session_id: 'session', task: 'followup' }
    f.send(append)
    assert.equal((await f.find('dsh_append_result')).code, 'turn_pending')
    assert.equal(f.prompts.length, 1)
    f.emit('turn/start', { turn: 1 })
    f.emit('user/message', { source: { rpcId: requestId } })
    f.send(append)
    assert.equal((await f.find('dsh_append_result', (x) => x.ok)).ok, true)
    const answer = f.waterfall['approval/request']({ agent: { id: 'session' }, callId: 'own' }, () => 'other-ui')
    const question = await f.find('dsh_interactive')
    f.send({ type: 'dsh_decide', command_id: 'own-answer', run_id: 'run', interactive_id: question.interactive_id, outcome: 'allowed-once' })
    assert.equal(await answer, 'allowed-once')
    f.finish()
    await f.find('dsh_result')
  } finally { await f.close() }
})

test('missing session retains upstream code and admission certainty', async () => {
  const f = await fixture()
  try {
    f.controller.prompt = async () => { throw Object.assign(new Error('deleted'), { code: 'session/not-found' }) }
    f.send({ type: 'dsh_task', task_id: 'task', run_id: 'run', session_id: 'gone', task: 'work' })
    const result = await f.find('dsh_result')
    assert.equal(result.code, 'session_missing'); assert.equal(result.source_code, 'session/not-found'); assert.equal(result.admitted, false); assert.equal(f.listeners.size, 0)
  } finally { await f.close() }
})

test('approval resolver exists before report and decision receipt replays after removal', async () => {
  const f = await fixture()
  try {
    await f.start()
    const answer = f.waterfall['approval/request']({ agent: { id: 'session' }, callId: 'call', reason: 'work' }, () => 'other')
    const up = await f.find('dsh_interactive')
    const command = { type: 'dsh_decide', command_id: 'command', run_id: 'run', interactive_id: up.interactive_id, outcome: 'allowed-once' }
    f.send(command); assert.equal(await answer, 'allowed-once'); assert.equal((await f.find('dsh_decide_result')).ok, true)
    f.send(command); await new Promise((r) => setTimeout(r, 20)); assert.equal(f.frames.filter((x) => x.type === 'dsh_decide_result' && x.ok).length, 2)
    f.send({ ...command, outcome: 'rejected' }); assert.equal((await f.find('dsh_decide_result', (x) => !x.ok)).code, 'command_conflict')
    f.finish()
  } finally { await f.close() }
})

test('repeated question IDs are different occurrences and invalid answers keep resolver open', async () => {
  const f = await fixture()
  try {
    await f.start()
    const req = { agent: { id: 'session' }, questions: [{ id: 'q', question: 'choose', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] }
    const first = f.waterfall['user-questions/request'](req, () => 'other')
    const up = await f.find('dsh_interactive')
    f.send({ type: 'dsh_decide', command_id: 'bad', run_id: 'run', interactive_id: up.interactive_id, answer: { answers: [{ id: 'q', selected: ['X'] }] } })
    assert.equal((await f.find('dsh_decide_result')).code, 'invalid_answer')
    const good = { answers: [{ id: 'q', selected: ['A'] }] }
    f.send({ type: 'dsh_decide', command_id: 'good', run_id: 'run', interactive_id: up.interactive_id, answer: good }); assert.deepEqual(await first, good)
    const second = f.waterfall['user-questions/request'](req, () => 'other')
    second.catch(() => {})
    const up2 = await f.find('dsh_interactive', (x) => x.interactive_id !== up.interactive_id)
    assert.notEqual(up2.interactive_id, up.interactive_id)
    f.finish(); await assert.rejects(second, /turn ended/)
  } finally { await f.close() }
})

test('wrong run cannot resolve an owned occurrence; unrelated sessions pass through', async () => {
  const f = await fixture()
  try {
    await f.start()
    assert.equal(f.waterfall['approval/request']({ agent: { id: 'other' } }, () => 'ui'), 'ui')
    const p = f.waterfall['approval/request']({ agent: { id: 'session' } }, () => 'ui')
    const up = await f.find('dsh_interactive')
    f.send({ type: 'dsh_decide', command_id: 'wrong', run_id: 'other-run', interactive_id: up.interactive_id, outcome: 'allowed-once' })
    assert.equal((await f.find('dsh_decide_result')).code, 'interactive_expired'); f.finish(); assert.equal(await p, 'unavailable')
  } finally { await f.close() }
})

test('followup requires a live owned turn, uses steer and acknowledges actual admission', async () => {
  const f = await fixture()
  try {
    await f.start()
    const command = { type: 'dsh_append', append_id: 'append', run_id: 'run', session_id: 'session', task: 'extra' }
    f.send(command); assert.equal((await f.find('dsh_append_result')).ok, true); assert.equal(f.prompts[1].mode, 'steer')
    f.send(command); await new Promise((r) => setTimeout(r, 20)); assert.equal(f.prompts.length, 2)
    f.finish(); await f.find('dsh_result')
    f.send({ ...command, append_id: 'late' }); assert.equal((await f.find('dsh_append_result', (x) => x.append_id === 'late')).code, 'admission_rejected'); assert.equal(f.prompts.length, 2)
  } finally { await f.close() }
})

test('recovery query returns existing result and never opens another turn', async () => {
  const f = await fixture()
  try {
    await f.start(); f.finish(); await f.find('dsh_result')
    f.send({ type: 'dsh_session_query', command_id: 'query', task_id: 'task' })
    const result = await f.find('dsh_session_query_result'); assert.equal(result.stage, 'finished'); assert.equal(result.result.reply, 'done'); assert.equal(f.prompts.length, 1)
  } finally { await f.close() }
})

test('真实 WS A 在途→B：任务/交互/迟到查询不跨配置，原缓存只在 A 可读', async () => {
  const f = await fixture()
  const taskId = randomUUID(), queuedId = randomUUID(), appendId = randomUUID(), decisionId = randomUUID(), inspectId = randomUUID()
  let resolveInspect
  const oldSignal = new AbortController()
  try {
    const a = f.connections[0]
    await f.start({ task_id: taskId, run_id: 'run-a', session_id: 'session' })
    f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'private-a-partial' }] } })
    const append = { type: 'dsh_append', append_id: appendId, run_id: 'run-a', session_id: 'session', task: 'a followup' }
    f.send(append)
    assert.equal((await f.findIn(a, 'dsh_append_result', (frame) => frame.append_id === appendId)).ok, true)
    const answer = f.waterfall['approval/request']({ agent: { id: 'session' }, callId: 'applied-a' }, () => 'ui')
    const applied = await f.findIn(a, 'dsh_interactive')
    const decision = { type: 'dsh_decide', command_id: decisionId, run_id: 'run-a', interactive_id: applied.interactive_id, outcome: 'allowed-once' }
    f.send(decision)
    assert.equal(await answer, 'allowed-once')
    assert.equal((await f.findIn(a, 'dsh_decide_result', (frame) => frame.command_id === decisionId)).ok, true)
    const pendingAnswer = f.waterfall['approval/request']({ agent: { id: 'session' }, callId: 'waiting-a', signal: oldSignal.signal }, () => 'ui')
    await f.findIn(a, 'dsh_interactive', (frame) => frame.interactive_id !== applied.interactive_id)
    f.controller.inspect = () => new Promise((resolve) => { resolveInspect = resolve })
    f.send({ type: 'dsh_session_query', command_id: inspectId, session_id: 'session' })
    await f.wait(() => !!resolveInspect)
    f.send({ type: 'dsh_task', task_id: queuedId, run_id: 'queued-a', session_id: 'session', task: 'queued a side effect' })
    f.send({ type: 'dsh_session_query', command_id: 'a-query-queued', task_id: queuedId })
    assert.equal((await f.findIn(a, 'dsh_session_query_result', (frame) => frame.command_id === 'a-query-queued')).stage, 'active')

    const b = await f.switchConfig({ apiKey: 'test-key-b' })
    assert.equal(await pendingAnswer, 'unavailable')
    assert.equal(f.prompts.length, 2, '配置切换本身不重执行任务/追加')
    f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'late-private-a' }] } })
    f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    resolveInspect({ sessionId: 'session' })
    f.send({ type: 'dsh_session_query', command_id: 'b-query-a', task_id: taskId })
    const unknown = await f.findIn(b, 'dsh_session_query_result', (frame) => frame.command_id === 'b-query-a')
    assert.equal(unknown.stage, 'unknown')
    assert.equal(unknown.ok, false)
    assert.equal(unknown.result, undefined)
    f.send({ type: 'dsh_session_query', command_id: 'b-query-queued', task_id: queuedId })
    assert.equal((await f.findIn(b, 'dsh_session_query_result', (frame) => frame.command_id === 'b-query-queued')).stage, 'unknown')
    f.send({ type: 'dsh_session_query', command_id: 'b-query-append', task_id: appendId })
    assert.equal((await f.findIn(b, 'dsh_session_query_result', (frame) => frame.command_id === 'b-query-append')).stage, 'unknown')
    f.send(decision)
    const rejectedDecision = await f.findIn(b, 'dsh_decide_result', (frame) => frame.command_id === decisionId)
    assert.equal(rejectedDecision.ok, false)
    assert.equal(rejectedDecision.code, 'interactive_expired', '不能 replay A 已应用授权的 ACK')
    f.send(append)
    const rejectedAppend = await f.findIn(b, 'dsh_append_result', (frame) => frame.append_id === appendId)
    assert.equal(rejectedAppend.ok, false)
    assert.equal(rejectedAppend.code, 'admission_rejected', '不能 replay A 追加受理的 ACK')
    assert.equal(f.prompts.length, 2)
    assert.ok(!b.frames.some((frame) => frame.type === 'dsh_result' && frame.task_id === taskId))
    assert.ok(!b.frames.some((frame) => frame.command_id === inspectId))
    assert.ok(!JSON.stringify(b.frames).includes('private-a'))

    const bTask = randomUUID()
    f.send({ type: 'dsh_task', task_id: bTask, run_id: 'run-b', session_id: 'session', task: 'fresh b work' })
    await f.findIn(b, 'dsh_task_started', (frame) => frame.task_id === bTask)
    const newAnswer = f.waterfall['approval/request']({ agent: { id: 'session' }, callId: 'waiting-b' }, () => 'ui')
    let resolved = false
    newAnswer.then(() => { resolved = true })
    const currentQuestion = await f.findIn(b, 'dsh_interactive', (frame) => frame.run_id === 'run-b')
    oldSignal.abort()
    await Promise.resolve()
    assert.equal(resolved, false, '旧 resolver cleanup 不得删除/解决新配置交互')
    f.send({ type: 'dsh_decide', command_id: randomUUID(), run_id: 'run-b', interactive_id: currentQuestion.interactive_id, outcome: 'allowed-once' })
    assert.equal(await newAnswer, 'allowed-once')

    const againA = await f.switchConfig({ apiKey: 'test-only' })
    f.send({ type: 'dsh_session_query', command_id: 'a-recover-task', task_id: taskId })
    const recovered = await f.findIn(againA, 'dsh_session_query_result', (frame) => frame.command_id === 'a-recover-task')
    assert.equal(recovered.stage, 'finished')
    assert.equal(recovered.result.code, 'interrupted')
    assert.equal(recovered.result.admitted, true)
    assert.equal(recovered.result.reply, 'private-a-partial')
    f.send({ type: 'dsh_session_query', command_id: 'a-recover-queued', task_id: queuedId })
    const cancelled = await f.findIn(againA, 'dsh_session_query_result', (frame) => frame.command_id === 'a-recover-queued')
    assert.equal(cancelled.result.code, 'cancelled')
    assert.equal(cancelled.result.admitted, false)
    f.send({ type: 'dsh_session_query', command_id: 'a-recover-append', task_id: appendId })
    assert.equal((await f.findIn(againA, 'dsh_session_query_result', (frame) => frame.command_id === 'a-recover-append')).result.ok, true)
    f.send(decision)
    assert.equal((await f.findIn(againA, 'dsh_decide_result', (frame) => frame.command_id === decisionId)).ok, true)
    assert.equal(f.prompts.length, 3, '恢复只读查询/原回执重放不得自动开新轮')
  } finally { resolveInspect?.(); oldSignal.abort(); await f.close() }
})

test('同 host 跨 key scoped cache 共用原 200 终态边界，懒清最旧而不跨域读取', async () => {
  const f = await fixture()
  try {
    const a = f.connections[0]
    const ids = Array.from({ length: 200 }, () => randomUUID())
    for (const commandId of ids) f.send({ type: 'dsh_decide', command_id: commandId, run_id: 'gone-a', interactive_id: 'gone', outcome: 'allowed-once' })
    await f.findIn(a, 'dsh_decide_result', (frame) => frame.command_id === ids.at(-1))
    const b = await f.switchConfig({ apiKey: 'test-key-b' })
    const bId = randomUUID()
    f.send({ type: 'dsh_decide', command_id: bId, run_id: 'gone-b', interactive_id: 'gone', outcome: 'allowed-once' })
    await f.findIn(b, 'dsh_decide_result', (frame) => frame.command_id === bId)
    f.send({ type: 'dsh_session_query', command_id: 'b-cannot-read-a', task_id: ids.at(-1) })
    assert.equal((await f.findIn(b, 'dsh_session_query_result', (frame) => frame.command_id === 'b-cannot-read-a')).stage, 'unknown')
    const againA = await f.switchConfig({ apiKey: 'test-only' })
    f.send({ type: 'dsh_session_query', command_id: 'a-pruned-oldest', task_id: ids[0] })
    assert.equal((await f.findIn(againA, 'dsh_session_query_result', (frame) => frame.command_id === 'a-pruned-oldest')).stage, 'unknown')
    f.send({ type: 'dsh_session_query', command_id: 'a-retained-latest', task_id: ids.at(-1) })
    const retained = await f.findIn(againA, 'dsh_session_query_result', (frame) => frame.command_id === 'a-retained-latest')
    assert.equal(retained.stage, 'finished')
    assert.equal(retained.result.code, 'interactive_expired')
    assert.equal(f.prompts.length, 0)
  } finally { await f.close() }
})

test('真实 WS 悬挂 prompt 忽略 abort 不锁 B 启动，迟到 A admission/result 留原 scope', async () => {
  const f = await fixture()
  const taskId = randomUUID()
  let releasePrompt
  try {
    const a = f.connections[0]
    f.controller.prompt = async (request) => {
      f.prompts.push(request)
      f.emit('turn/start', { turn: 1 })
      f.emit('user/message', { turn: 1, source: { rpcId: request.requestId } })
      await new Promise((resolve) => { releasePrompt = resolve })
      return { accepted: true }
    }
    const task = { type: 'dsh_task', task_id: taskId, run_id: 'held-a', session_id: 'session', task: 'side effect' }
    f.send(task)
    await f.findIn(a, 'dsh_session_created', (frame) => frame.task_id === taskId)
    await f.wait(() => !!releasePrompt)
    const b = await f.switchConfig({ apiKey: 'test-key-b' })
    assert.equal(f.bridge.getState().phase, 'ready')
    assert.equal(f.listeners.size, 0)
    assert.ok(!b.frames.some((frame) => frame.type === 'dsh_task_started' && frame.task_id === taskId))
    releasePrompt()
    await new Promise((resolve) => setImmediate(resolve))
    f.send({ type: 'dsh_session_query', command_id: 'b-held-query', task_id: taskId })
    const unknown = await f.findIn(b, 'dsh_session_query_result', (frame) => frame.command_id === 'b-held-query')
    assert.equal(unknown.stage, 'unknown')
    assert.equal(unknown.result, undefined)
    assert.ok(!b.frames.some((frame) => frame.type === 'dsh_result' && frame.task_id === taskId))
    f.send(task)
    const refused = await f.findIn(b, 'dsh_result', (frame) => frame.task_id === taskId)
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'unknown')
    assert.equal(refused.admitted, null)
    assert.equal(refused.reply, undefined, '不得泄露原 scope 的技术结果')
    assert.equal(f.prompts.length, 1, '换 key 后无法证实归属，不能重复执行已知副作用任务')
    const againA = await f.switchConfig({ apiKey: 'test-only' })
    f.send({ type: 'dsh_session_query', command_id: 'a-held-query', task_id: taskId })
    const recovered = await f.findIn(againA, 'dsh_session_query_result', (frame) => frame.command_id === 'a-held-query')
    assert.equal(recovered.stage, 'finished')
    assert.equal(recovered.result.code, 'interrupted')
    assert.equal(recovered.result.admitted, true)
    f.send(task)
    assert.equal((await f.findIn(againA, 'dsh_result', (frame) => frame.task_id === taskId)).code, 'interrupted')
    assert.equal(f.prompts.length, 1, '同原 scope 重发只 replay，不能重复副作用')
  } finally { releasePrompt?.(); await f.close() }
})
