import { spawn as nodeSpawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createDecoder, encode } = require('../../desktop-helper/lib/protocol.cjs')

export function createHelperProcess({ exePath, helperAppDir, hostPid = process.pid, dshHome, env = process.env, logger = console, onMessage = () => {}, onExit = () => {}, timeouts, protocol, spawn = nodeSpawn }) {
  let child, stopping = false, stopFlight, pingTimer, missed = 0, exited = false
  function send(message) {
    const input = child?.stdio?.[3]
    if (!input?.writable) return false
    try { input.write(encode(message)); return true }
    catch (error) { logger.warn('muche desktop: stdin write failed', error?.message || error); return false }
  }
  function finish(info) {
    if (exited) return
    exited = true
    if (pingTimer) clearInterval(pingTimer)
    onExit({ ...info, expected: stopping })
  }
  function start() {
    if (child) throw new Error('helper already started')
    const cleanEnv = { ...env, MUCHE_HELPER: '1', MUCHE_HOST_PID: String(hostPid), DSH_HOME: dshHome, MUCHE_PIPE_FD: '3' }
    delete cleanEnv.ELECTRON_RUN_AS_NODE
    child = spawn(exePath, [helperAppDir], { cwd: dshHome, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true })
    const decoder = createDecoder({ maxLineBytes: protocol.maxLineBytes, onError: reason => logger.warn('muche desktop: protocol', reason), onMessage: msg => {
      if (msg?.type === 'pong') { missed = 0; return }
      if (!protocol.messages.helperToHost.includes(msg?.type)) { logger.warn('muche desktop: unknown helper message'); return }
      onMessage(msg)
    } })
    child.stdout.on('data', data => decoder.write(data))
    child.stderr.on('data', data => logger.warn('muche desktop:', String(data).trim()))
    child.stdio[3].on('error', error => logger.warn('muche desktop: command pipe error', error.message))
    child.once('error', error => finish({ code: null, signal: null, error }))
    child.once('exit', (code, signal) => finish({ code, signal }))
    pingTimer = setInterval(() => {
      if (++missed > timeouts.pingMissLimit) { logger.warn('muche desktop: helper heartbeat timed out'); child.kill('SIGKILL'); return }
      send({ type: 'ping' })
    }, timeouts.pingMs)
    pingTimer.unref?.()
  }
  function stop() {
    if (stopFlight) return stopFlight
    if (!child || exited) return Promise.resolve()
    stopping = true
    if (pingTimer) clearInterval(pingTimer)
    stopFlight = new Promise(resolve => {
      let first, second, settled = false
      const done = () => { if (settled) return; settled = true; clearTimeout(first); clearTimeout(second); resolve() }
      child.once('exit', done); child.once('error', done)
      send({ type: 'shutdown' })
      first = setTimeout(() => {
        child.kill('SIGTERM')
        if (!settled) second = setTimeout(() => { child.kill('SIGKILL'); done() }, timeouts.stopKillMs)
      }, timeouts.stopGraceMs)
    })
    return stopFlight
  }
  return { start, send, stop }
}
