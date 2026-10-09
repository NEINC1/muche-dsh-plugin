/** Pure wire contract shared by the host projection and its browser mirror. */
import { classifyFailure, HOST_UNAVAILABLE } from './errors.js'

export function sameRuntimeContext(a, b) {
  return !!a && !!b && a.runtimeId === b.runtimeId && a.configNs === b.configNs && a.generation === b.generation
}
export function isRuntimeSnapshot(value) {
  return value?.schema === 1 && typeof value.runtimeId === 'string' && !!value.runtimeId
    && typeof value.configNs === 'string' && !!value.configNs
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && Number.isSafeInteger(value.seq) && value.seq >= 0
    && ['connecting', 'online', 'offline'].includes(value.chat?.phase)
    && !!value.configuration && !!value.bridge
}
export function projectClientRuntime(snapshot, delivery) {
  const phase = delivery.status === 'offline' || snapshot?.chat.phase === 'offline' ? 'offline'
    : snapshot?.chat.phase === 'online' && delivery.synced ? 'online' : 'connecting'
  const problem = snapshot?.configuration.code ? snapshot.problem
    : delivery.status === 'offline' ? classifyFailure({ code: HOST_UNAVAILABLE }) : snapshot?.problem || null
  return {
    phase,
    label: phase === 'online' ? '在线' : phase === 'offline' ? '离线' : '连接中',
    problem,
    context: snapshot ? { runtimeId: snapshot.runtimeId, configNs: snapshot.configNs, generation: snapshot.generation } : null,
    snapshot,
  }
}

/** Suppress only the same structural cause, never unrelated input/operation errors. */
export function isSameProblem(failure, problem) {
  if (!failure || !problem) return false
  const structural = new Set(['config', 'connection', 'host', 'access'])
  return failure.kind === problem.kind && (structural.has(failure.kind) || failure.code === problem.code)
}
