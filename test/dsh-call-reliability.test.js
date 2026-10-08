import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeDshTask } from '../lib/dsh-call.js'

function fixture(prompt) {
  const path = mkdtempSync(join(tmpdir(), 'muche-turn-'))
  const listeners = new Set()
  const subscriptions = new Map()
  const emit = (type, data) => {
    for (const fn of [...(subscriptions.get('session/event') || [])]) fn({ id: 'existing' }, { type, data })
  }
  const claim = (message, turn, sessionId = 'existing') => {
    for (const fn of [...(subscriptions.get('agent/inbox/claimed') || [])]) fn({ agent: { id: sessionId, session: { id: sessionId } }, message, turn })
  }
  const services = {
    workspaceRegistry: { resolveByPath: async () => ({ id: 'workspace' }) },
    sessionController: { prompt: (req, signal) => prompt(emit, listeners, req, signal, claim) },
  }
  return {
    ctx: { get: (key) => services[key], on: (name, fn) => {
      listeners.add(fn)
      if (!subscriptions.has(name)) subscriptions.set(name, new Set())
      subscriptions.get(name).add(fn)
      return () => { listeners.delete(fn); subscriptions.get(name).delete(fn) }
    } },
    config: { workspacePath: path }, listeners, cleanup: () => rmSync(path, { recursive: true, force: true }),
  }
}

test('prompt admission can finish a turn before prompt returns', async () => {
  const f = fixture(async (emit, listeners, req) => {
    assert.equal(listeners.size, 2, 'must subscribe to inbox and session before admission')
    emit('turn/start', { turn: 1 })
    emit('user/message', { source: { kind: 'user', rpcId: req.requestId } })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return { accepted: true }
  })
  try {
    const result = await executeDshTask(f.ctx, f.config, { task: 'work', session_id: 'existing', signal: new AbortController().signal, timeoutMs: 50 })
    assert.equal(result.reply, 'done')
    assert.equal(f.listeners.size, 0)
  } finally { f.cleanup() }
})

test('failed prompt admission removes its subscription', async () => {
  const f = fixture(async () => { throw Object.assign(new Error('deleted'), { code: 'session/not-found' }) })
  try {
    await assert.rejects(executeDshTask(f.ctx, f.config, { task: 'work', session_id: 'existing', signal: new AbortController().signal }), (e) => e.code === 'session_missing' && e.admitted === false)
    assert.equal(f.listeners.size, 0)
  } finally { f.cleanup() }
})

test('output limit preserves partial text and is not completed', async () => {
  const f = fixture(async (emit, _listeners, req) => {
    emit('turn/start', { turn: 1 })
    emit('user/message', { source: { kind: 'user', rpcId: req.requestId } })
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'partial' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    return { accepted: true }
  })
  try {
    await assert.rejects(executeDshTask(f.ctx, f.config, { task: 'work', session_id: 'existing', signal: new AbortController().signal, timeoutMs: 50 }), (e) => e.code === 'output_limit' && e.partial === 'partial')
  } finally { f.cleanup() }
})

test('unknown admission failure retains uncertainty rather than declaring no execution', async () => {
  const f = fixture(async () => { throw new Error('connection closed after prompt dispatch') })
  try {
    await assert.rejects(executeDshTask(f.ctx, f.config, { task: 'work', session_id: 'existing', signal: new AbortController().signal }), (e) => e.code === 'unknown' && e.admitted === null)
    assert.equal(f.listeners.size, 0)
  } finally { f.cleanup() }
})

test('pre-aborted request never submits a prompt', async () => {
  let prompts = 0
  const f = fixture(async () => { prompts++ })
  const ac = new AbortController()
  ac.abort()
  try {
    await assert.rejects(executeDshTask(f.ctx, f.config, { task: 'work', session_id: 'existing', signal: ac.signal }), (e) => e.code === 'cancelled' && e.admitted === false)
    assert.equal(prompts, 0)
    assert.equal(f.listeners.size, 0)
  } finally { f.cleanup() }
})

test('waiting for a decision pauses execution time and foreign turns cannot complete the task', async () => {
  let emit, waiting = true
  const f = fixture(async (events, _listeners, req) => {
    emit = events
    emit('turn/start', { turn: 1 })
    emit('user/message', { source: { rpcId: req.requestId } })
    emit('turn/end', { turn: 99, reason: { kind: 'completed' } })
    return { accepted: true }
  })
  try {
    const task = executeDshTask(f.ctx, f.config, { task: 'work', session_id: 'existing', signal: new AbortController().signal, timeoutMs: 20, isWaiting: () => waiting })
    await new Promise((r) => setTimeout(r, 70))
    waiting = false
    emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'continued' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.equal((await task).reply, 'continued')
    assert.equal(f.listeners.size, 0)
  } finally { f.cleanup() }
})

for (const [kind, code] of [['blocked', 'blocked'], ['error', 'execution_error'], ['aborted', 'cancelled'], ['interrupted', 'interrupted'], ['max-tokens', 'output_limit'], ['completed', null]]) {
  test(`claimed prompt can end as ${kind} without a user/message`, async () => {
    const f = fixture(async (emit, _listeners, req, _signal, claim) => {
      emit('turn/start', { turn: 1 })
      claim({ source: { kind: 'user', rpcId: req.requestId } }, 1)
      emit('turn/end', { turn: 1, reason: { kind, error: { message: 'pre-step terminal' } } })
      return { accepted: true }
    })
    const turns = []
    try {
      const task = executeDshTask(f.ctx, f.config, { task: 'work', session_id: 'existing', signal: new AbortController().signal, timeoutMs: 50, onTurnStarted: turn => turns.push(['start', turn]), onTurnEnded: turn => turns.push(['end', turn]) })
      if (code) await assert.rejects(task, error => error.code === code && error.admitted === true)
      else assert.equal((await task).reply, '')
      assert.deepEqual(turns, [['start', 1], ['end', 1]])
      assert.equal(f.listeners.size, 0)
    } finally { f.cleanup() }
  })
}

test('foreign pre-step claim cannot bind or finish the owned task', async () => {
  const f = fixture(async (emit, _listeners, req, _signal, claim) => {
    emit('turn/start', { turn: 1 })
    claim({ source: { rpcId: 'foreign-request' } }, 1)
    emit('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    claim({ source: { rpcId: req.requestId } }, 2, 'other-session')
    emit('turn/end', { turn: 2, reason: { kind: 'error' } })
    emit('turn/start', { turn: 3 })
    claim({ source: { rpcId: req.requestId } }, 3)
    emit('user/message', { source: { rpcId: req.requestId } })
    emit('assistant/message', { turn: 3, message: { content: [{ type: 'text', text: 'own result' }] } })
    emit('turn/end', { turn: 3, reason: { kind: 'completed' } })
    return { accepted: true }
  })
  const turns = []
  try {
    const result = await executeDshTask(f.ctx, f.config, { task: 'work', session_id: 'existing', signal: new AbortController().signal, timeoutMs: 50, onTurnStarted: turn => turns.push(turn) })
    assert.equal(result.reply, 'own result')
    assert.deepEqual(turns, [3])
    assert.equal(f.listeners.size, 0)
  } finally { f.cleanup() }
})
