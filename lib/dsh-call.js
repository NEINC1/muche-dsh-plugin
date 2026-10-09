/** DSH execution uses the owning prompt rpcId, subscribes before admission and cleans every exit. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ensureWorkspace } from './workspace.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const PROTOCOL = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'))
export const TURN_TIMEOUT_MS = 3 * 3600 * 1000
export const DEFAULT_AGENT_PRESET = 'ptc'

export function failure(error, { admitted = false, partial = '', sessionId = '' } = {}) {
  const source = error?.source_code || error?.code || error?.data?.code || 'unknown'
  const codes = {
    'session/not-found': 'session_missing', 'session/model-unavailable': 'model_unavailable',
    'session/agent-busy': 'admission_rejected', 'session/writer-held': 'admission_rejected',
    'agent-preset/conflict': 'admission_rejected', 'gateway/bad-request': 'admission_rejected',
  }
  const code = codes[source] || (PROTOCOL.errors[source] ? source : 'unknown')
  return Object.assign(new Error(String(error?.message || error)), { code, source_code: source, admitted, partial, sessionId })
}

function waitForTurn(ctx, sessionId, requestId, signal, timeoutMs, isWaiting, onTurnStarted, onTurnEnded, ownsContinuation, isContinuationPending) {
  let cancel
  const disposers = []
  let timer
  let ownTurn = null
  let currentTurn = null
  let finished = false
  let activeMs = 0
  let lastTick = Date.now()
  const texts = []
  const promise = new Promise((resolve, reject) => {
    function finish(error) {
      if (finished) return
      finished = true
      clearInterval(timer)
      for (const dispose of disposers.splice(0)) dispose()
      signal.removeEventListener('abort', onAbort)
      if (ownTurn !== null) onTurnEnded?.(ownTurn)
      if (error) reject(failure(error, { admitted: true, partial: texts.join('\n').trim(), sessionId }))
      else resolve({ texts })
    }
    const onAbort = () => {
      if (ownTurn !== null) {
        try { ctx.get('sessionController')?.cancel?.({ sessionId }) } catch (error) { console.error('muche dsh-call: cancel unavailable', String(error?.message || error)) }
      }
      finish(Object.assign(new Error('execution observer interrupted; cancellation result unconfirmed'), { code: 'interrupted' }))
    }
    cancel = (error) => finish(error)
    const bindTurn = (turn, source) => {
      if (finished || ownTurn !== null || (source?.rpcId !== requestId && !ownsContinuation?.(source)) || !Number.isInteger(turn)) return
      ownTurn = turn
      onTurnStarted?.(ownTurn)
    }
    disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (agent?.id === sessionId) bindTurn(turn, message?.source)
    }))
    disposers.push(ctx.on('session/event', (session, event) => {
      if (session?.id !== sessionId || finished) return
      const data = event.data || {}
      if (event.type === 'turn/start') currentTurn = data.turn
      if (event.type === 'user/message') bindTurn(data.turn ?? currentTurn, data.source)
      if (ownTurn === null || data.turn !== ownTurn) return
      if (event.type === 'assistant/message') {
        for (const b of data.message?.content || []) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      } else if (event.type === 'turn/end') {
        const kind = data.reason?.kind
        const codes = { aborted: 'cancelled', blocked: 'blocked', interrupted: 'interrupted', 'max-tokens': 'output_limit', error: 'execution_error' }
        if (kind === 'completed' && isContinuationPending()) { ownTurn = null; return }
        finish(kind === 'completed' ? null : Object.assign(new Error(data.reason?.error?.message || kind || 'invalid turn end'), { code: codes[kind] || 'protocol_error' }))
      }
    }))
    timer = setInterval(() => {
      const now = Date.now()
      if (!isWaiting()) activeMs += now - lastTick
      lastTick = now
      if (activeMs >= timeoutMs) finish(Object.assign(new Error('active execution timeout'), { code: 'execution_timeout' }))
    }, Math.min(1000, timeoutMs))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  // Admission may fail before anyone awaits the listener promise.
  promise.catch(() => {})
  return { promise, cancel, get observedAdmission() { return ownTurn !== null } }
}

export async function promptSession(ctx, sessionId, text, signal, mode = 'queue', requestId = `muche-dsh-${randomUUID()}`) {
  const sc = ctx.get('sessionController')
  if (!sc) throw Object.assign(new Error('sessionController unavailable'), { code: 'host_not_ready' })
  return sc.prompt({ requestId, sessionId, mode, content: [{ type: 'text', text }] }, signal)
}

/** Plain-text steering has no await between origin validation and the public Agent inbox. */
export function steerOwnedTurn(ctx, sessionId, text, requestId, ownsTurn) {
  const agent = ctx.get('agents')?.get(sessionId)
  if (!agent) throw Object.assign(new Error('active Agent registry unavailable'), { code: 'host_not_ready' })
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } })
  if (!ownsTurn()) throw Object.assign(new Error('the owned turn ended before append admission'), { code: 'admission_rejected' })
  agent.steer(message)
  return { accepted: true }
}

export async function executeDshTask(ctx, config, { task, session_id, agentPreset, signal, onSessionCreated, onAdmitted, onTurnStarted, onTurnEnded, ownsContinuation, taskId = randomUUID(), timeoutMs = TURN_TIMEOUT_MS, isWaiting = () => false, isContinuationPending = () => false }) {
  const text = typeof task === 'string' ? task.trim() : ''
  if (!text) throw failure(Object.assign(new Error('missing task'), { code: 'admission_rejected' }))
  let sessionId = session_id || ''
  let waiter
  let admitted = false
  let promptAttempted = false
  try {
    signal.throwIfAborted()
    if (!sessionId) {
      const { workspaceId } = await ensureWorkspace(ctx, config)
      const sc = ctx.get('sessionController')
      if (!sc) throw Object.assign(new Error('sessionController unavailable'), { code: 'host_not_ready' })
      const result = await sc.create({ workspaceId, agentPreset: agentPreset || DEFAULT_AGENT_PRESET })
      if (!result?.sessionId) throw Object.assign(new Error('missing session identity'), { code: 'protocol_error' })
      sessionId = result.sessionId
    }
    onSessionCreated?.(sessionId)
    const requestId = `muche-dsh-${taskId}`
    waiter = waitForTurn(ctx, sessionId, requestId, signal, timeoutMs, isWaiting, onTurnStarted, onTurnEnded, ownsContinuation, isContinuationPending)
    signal.throwIfAborted()
    promptAttempted = true
    await promptSession(ctx, sessionId, text, signal, 'queue', requestId)
    admitted = true
    onAdmitted?.(sessionId)
    const { texts } = await waiter.promise
    return { reply: texts.join('\n').trim(), sessionId }
  } catch (error) {
    waiter?.cancel(error)
    if (signal.aborted && (error?.name === 'AbortError' || typeof error?.code !== 'string')) error = Object.assign(new Error('execution observer cancelled'), { code: admitted ? 'interrupted' : 'cancelled' })
    const observed = failure(error, { partial: error?.partial || '', sessionId })
    const rejected = ['session_missing', 'model_unavailable', 'admission_rejected', 'host_not_ready'].includes(observed.code)
    const certainty = admitted || waiter?.observedAdmission ? true : rejected || !promptAttempted ? false : null
    throw failure(error, { admitted: certainty, partial: error?.partial || '', sessionId })
  }
}
