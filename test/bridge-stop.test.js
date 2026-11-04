/** Bridge stop command: capability advert and stopped/unknown receipts (OI-191 P2-B). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRuntimeState } from '../lib/runtime-state.js'
import { registerDshBridge } from '../lib/dsh-bridge.js'

const CFG = { backendUrl: 'https://example.test/api', apiKey: 'test-key-a', workspacePath: '', bridgeId: 'test-host' }
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

function fixture(t) {
  const runtime = createRuntimeState({ configNs: 'bridge-stop-test', runtimeId: randomUUID() })
  runtime.configure({ backendUrl: CFG.backendUrl, apiKey: CFG.apiKey })
  const services = {}
  const listeners = new Map()
  let cancellationRequests = 0
  const emit = (type, data) => {
    for (const fn of listeners.get('session/event') || []) fn({ id: 'session' }, { type, data })
  }
  services.sessionController = {
    create: async () => ({ sessionId: 'session' }),
    prompt: async (request) => {
      emit('turn/start', { turn: 1 })
      emit('user/message', { turn: 1, source: { rpcId: request.requestId } })
      return { accepted: true }
    },
    cancel: () => { cancellationRequests += 1; return { accepted: true } },
  }
  services.workspaceRegistry = { resolveByPath: async () => ({ id: 'workspace' }) }
  const ctx = {
    get: (name) => services[name],
    settings: { update: async () => {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name)?.delete(fn)
    },
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') this.effects.push(dispose) },
    effects: [],
  }
  const created = []
  const bridge = registerDshBridge(ctx, { ...CFG }, {
    getContext: runtime.context,
    onState: (state, context) => { runtime.setBridge(context, state) },
    dependencyRetryDelays: [5, 10],
    createTransport: (opts) => {
      const transport = {
        opts, sent: [], disposed: false, state: { status: 'idle', ready: false },
        start() {},
        getState() { return { ...this.state } },
        status(state) { this.state = state; opts.onStatus?.(state) },
        ack(frame = { ok: true }) { opts.onHelloAck?.(frame) },
        dispose() { this.disposed = true; this.status({ status: 'closed', ready: false }) },
        sendFrame(frame) { if (this.state.status !== 'open') throw new Error('fake transport not open'); this.sent.push(frame) },
      }
      created.push(transport)
      return transport
    },
  })
  t.after(() => { bridge.dispose(); runtime.dispose() })
  return { bridge, runtime, created, emit, services, cancellationRequests: () => cancellationRequests, refresh: (next = CFG) => { runtime.configure(next); return bridge.refresh(next, runtime.context()) } }
}

async function ready(f) {
  await f.refresh()
  const transport = f.created[0]
  transport.status({ status: 'open', ready: false })
  transport.status({ status: 'open', ready: true })
  transport.ack({ ok: true })
  return transport
}

test('hello advertises assignment-cancel alongside the required capabilities', async (t) => {
  const f = fixture(t)
  const transport = await ready(f)
  const hello = transport.sent.find((frame) => frame.type === 'dsh_hello')
  assert.ok(hello)
  assert.ok(hello.capabilities.includes('assignment-cancel'))
  assert.ok(hello.capabilities.includes('receipts'))
})

test('stop requests native cancellation and confirms only after the owned turn ends aborted', async (t) => {
  const f = fixture(t)
  const transport = await ready(f)
  transport.opts.onTask({ type: 'dsh_task', task_id: 't-stop', run_id: 'r-stop', session_id: 'session', task: 'clean' })
  await flush()
  transport.opts.onStop({ type: 'dsh_stop', command_id: 'cmd-1', task_id: 't-stop', run_id: 'r-stop' })
  await flush()
  assert.equal(f.cancellationRequests(), 1)
  assert.equal(transport.sent.some((frame) => frame.type === 'dsh_stop_result'), false)
  f.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await flush()
  const reply = transport.sent.find((frame) => frame.type === 'dsh_stop_result' && frame.command_id === 'cmd-1')
  assert.ok(reply, 'stop result must be sent')
  assert.equal(reply.status, 'stopped')
  assert.equal(reply.ok, true)
  assert.equal(reply.task_id, 't-stop')
})

test('a naturally completed turn is not reported stopped in a stop race', async (t) => {
  const f = fixture(t)
  const transport = await ready(f)
  transport.opts.onTask({ type: 'dsh_task', task_id: 't-race', run_id: 'r-race', session_id: 'session', task: 'clean' })
  await flush()
  transport.opts.onStop({ type: 'dsh_stop', command_id: 'cmd-race', task_id: 't-race', run_id: 'r-race' })
  await flush()
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await flush()
  const reply = transport.sent.find((frame) => frame.type === 'dsh_stop_result' && frame.command_id === 'cmd-race')
  assert.equal(reply?.status, 'already_ended')
})

test('stop removes only this run’s unread appends and rejects later appends', async (t) => {
  const f = fixture(t)
  const transport = await ready(f)
  const inbox = {
    nextStep: [], nextTurn: [{ id: 'other', source: { rpcId: 'another-client' } }],
    remove(id) {
      for (const list of [this.nextStep, this.nextTurn]) {
        const index = list.findIndex((item) => item.id === id)
        if (index !== -1) { list.splice(index, 1); return true }
      }
      return false
    },
  }
  f.services.agents = { get: () => ({ inbox, steer: (message) => inbox.nextStep.push(message) }) }
  transport.opts.onTask({ type: 'dsh_task', task_id: 't-input', run_id: 'r-input', session_id: 'session', task: 'research' })
  await flush()
  transport.opts.onAppend({ type: 'dsh_append', append_id: 'a-1', run_id: 'r-input', session_id: 'session', task: 'followup' })
  await flush()
  assert.equal(inbox.nextStep.length, 1)
  assert.equal(transport.sent.find((frame) => frame.append_id === 'a-1')?.ok, true)
  transport.opts.onStop({ type: 'dsh_stop', command_id: 'stop-input', task_id: 't-input', run_id: 'r-input' })
  assert.equal(inbox.nextStep.length, 0)
  assert.equal(inbox.nextTurn[0].id, 'other')
  transport.opts.onAppend({ type: 'dsh_append', append_id: 'late', run_id: 'r-input', session_id: 'session', task: 'too late' })
  await flush()
  assert.equal(transport.sent.find((frame) => frame.append_id === 'late')?.code, 'admission_rejected')
  f.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await flush()
  assert.equal(transport.sent.find((frame) => frame.command_id === 'stop-input')?.status, 'stopped')
})

test('stop is unconfirmed if owned pending inputs cannot be checked', async (t) => {
  const f = fixture(t)
  const transport = await ready(f)
  const agent = { inbox: { nextStep: [], nextTurn: [], remove: () => true } }
  agent.steer = (message) => agent.inbox.nextStep.push(message)
  f.services.agents = { get: () => agent }
  transport.opts.onTask({ type: 'dsh_task', task_id: 't-unknown', run_id: 'r-unknown', session_id: 'session', task: 'research' })
  await flush()
  transport.opts.onAppend({ type: 'dsh_append', append_id: 'a-unknown', run_id: 'r-unknown', session_id: 'session', task: 'followup' })
  await flush()
  agent.inbox = null
  transport.opts.onStop({ type: 'dsh_stop', command_id: 'stop-unknown', task_id: 't-unknown', run_id: 'r-unknown' })
  await flush()
  assert.equal(transport.sent.find((frame) => frame.command_id === 'stop-unknown')?.status, 'unknown')
  f.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await flush()
  assert.equal(transport.sent.find((frame) => frame.type === 'dsh_result' && frame.run_id === 'r-unknown')?.code, 'unknown')
})

test('stop of an unknown assignment replies unknown', async (t) => {
  const f = fixture(t)
  const transport = await ready(f)
  transport.opts.onStop({ type: 'dsh_stop', command_id: 'cmd-2', task_id: 'missing', run_id: 'missing-run' })
  await flush()
  const reply = transport.sent.find((frame) => frame.type === 'dsh_stop_result')
  assert.ok(reply)
  assert.equal(reply.status, 'unknown')
})

test('session owner query uses the 0.2.2 passive state interface when inspect is absent', async (t) => {
  const f = fixture(t)
  const transport = await ready(f)
  f.services.sessionController.state = async ({ sessionId }) => {
    assert.equal(sessionId, 'existing')
    return { active: false }
  }
  transport.opts.onQuery({ type: 'dsh_session_query', command_id: 'q-1', session_id: 'existing' })
  await flush()
  assert.equal(transport.sent.find((frame) => frame.command_id === 'q-1')?.ok, true)
})
