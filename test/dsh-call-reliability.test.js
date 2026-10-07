import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeDshTask } from '../lib/dsh-call.js'

function fixture(prompt) {
  const path = mkdtempSync(join(tmpdir(), 'muche-turn-'))
  const listeners = new Set()
  const emit = (type, data) => {
    for (const fn of [...listeners]) fn({ id: 'existing' }, { type, data })
  }
  const services = {
    workspaceRegistry: { resolveByPath: async () => ({ id: 'workspace' }) },
    sessionController: { prompt: (...args) => prompt(emit, listeners, ...args) },
  }
  return {
    ctx: { get: (key) => services[key], on: (_, fn) => { listeners.add(fn); return () => listeners.delete(fn) } },
    config: { workspacePath: path }, listeners, cleanup: () => rmSync(path, { recursive: true, force: true }),
  }
}

test('prompt admission can finish a turn before prompt returns', async () => {
  const f = fixture(async (emit, listeners, req) => {
    assert.equal(listeners.size, 1, 'must subscribe before admission')
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
