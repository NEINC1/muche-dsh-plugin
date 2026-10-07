/** Real WS contract, fake upstream host; no provider/network credentials. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { registerDshBridge } from '../lib/dsh-bridge.js'

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'muche-host-'))
  const listeners = new Set(), disposers = [], waterfall = {}, prompts = [], frames = []
  const wss = new WebSocketServer({ port: 0 })
  await new Promise((r) => wss.on('listening', r))
  let socket
  wss.on('connection', (ws) => { socket = ws; ws.on('message', (raw) => frames.push(JSON.parse(String(raw)))) })
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
  registerDshBridge(ctx, { backendUrl: `http://127.0.0.1:${wss.address().port}`, apiKey: 'test-only', workspacePath: directory, bridgeId: randomUUID() })
  async function wait(predicate) {
    const until = Date.now() + 2000
    while (!predicate()) { if (Date.now() >= until) throw new Error('fixture timeout'); await new Promise((r) => setTimeout(r, 5)) }
    return frames.find(predicate)
  }
  await wait(() => frames.some((f) => f.type === 'dsh_hello'))
  const send = (frame) => socket.send(JSON.stringify(frame))
  const find = async (type, match = () => true) => { await wait(() => frames.some((f) => f.type === type && match(f))); return frames.find((f) => f.type === type && match(f)) }
  const start = async (extra = {}) => { send({ type: 'dsh_task', task_id: 'task', run_id: 'run', task: 'work', ...extra }); await find('dsh_task_started') }
  const finish = () => { emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } }); emit('turn/end', { turn: 1, reason: { kind: 'completed' } }) }
  return { frames, send, find, start, finish, emit, waterfall, prompts, controller, listeners, close: async () => { for (const fn of disposers) fn(); socket?.close(); await new Promise((r) => wss.close(r)); rmSync(directory, { recursive: true, force: true }) } }
}

test('hello, admission and final result are separate authoritative observations', async () => {
  const f = await fixture()
  try { await f.start(); assert.equal(f.frames.find((x) => x.type === 'dsh_hello').protocol, 2); assert.ok(!f.frames.some((x) => x.type === 'dsh_result')); f.finish(); assert.equal((await f.find('dsh_result')).reply, 'done'); assert.equal(f.listeners.size, 0) } finally { await f.close() }
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
