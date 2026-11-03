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
  services.sessionController = {
    create: async () => ({ sessionId: 'session' }),
    prompt: async () => {},
  }
  services.workspaceRegistry = { resolveByPath: async () => ({ id: 'workspace' }) }
  const ctx = {
    get: (name) => services[name],
    settings: { update: async () => {} },
    on() { return () => {} },
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
  return { bridge, runtime, created, refresh: (next = CFG) => { runtime.configure(next); return bridge.refresh(next, runtime.context()) } }
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

test('stop aborts the running assignment and replies stopped', async (t) => {
  const f = fixture(t)
  const transport = await ready(f)
  transport.opts.onTask({ type: 'dsh_task', task_id: 't-stop', run_id: 'r-stop', task: 'clean' })
  await flush()
  transport.opts.onStop({ type: 'dsh_stop', command_id: 'cmd-1', task_id: 't-stop', run_id: 'r-stop' })
  await flush()
  const reply = transport.sent.find((frame) => frame.type === 'dsh_stop_result' && frame.command_id === 'cmd-1')
  assert.ok(reply, 'stop result must be sent')
  assert.equal(reply.status, 'stopped')
  assert.equal(reply.task_id, 't-stop')
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
