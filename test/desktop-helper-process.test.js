import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHelperProcess } from '../lib/desktop/helper-process.js'

test('helper uses a private stdio channel, forwards messages and shuts down', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
  child.stdio = [null, child.stdout, child.stderr, child.stdin]
  child.kill = signal => { child.emit('exit', null, signal); return true }
  const sent = []; child.stdin.on('data', data => sent.push(String(data)))
  let spawnOptions; const received = []; const exits = []
  const helper = createHelperProcess({ exePath: 'electron', helperAppDir: 'helper', dshHome: 'home', env: { ELECTRON_RUN_AS_NODE: '1' },
    timeouts: { pingMs: 10000, pingMissLimit: 3, stopGraceMs: 10, stopKillMs: 10 },
    protocol: { maxLineBytes: 1024, messages: { helperToHost: ['hello', 'pong'] } },
    spawn: (_exe, _args, options) => { spawnOptions = options; return child },
    onMessage: msg => received.push(msg), onExit: info => exits.push(info) })
  helper.start()
  assert.equal(spawnOptions.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe', 'pipe'])
  assert.equal(spawnOptions.env.MUCHE_PIPE_FD, '3')
  child.stdout.write('{"type":"hello"}\n')
  assert.deepEqual(received, [{ type: 'hello' }])
  const stopped = helper.stop()
  child.emit('exit', 0, null)
  await stopped
  assert.match(sent.join(''), /"shutdown"/)
  assert.equal(exits.length, 1)
  assert.equal(exits[0].expected, true)
})
