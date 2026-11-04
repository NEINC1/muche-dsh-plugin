import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BackendWs } from '../lib/backend_ws.js'

test('the actual backend transport dispatches a stop frame to the registered handler', () => {
  let socket
  class Socket extends EventEmitter {
    static OPEN = 1
    constructor() { super(); this.readyState = 0; socket = this }
    send() {}
    terminate() { this.readyState = 3 }
  }
  const frames = []
  const ws = new BackendWs({
    backendUrl: 'https://example.test', apiKey: 'test', WebSocket: Socket,
    onStop: (frame) => frames.push(frame),
  })
  ws.start()
  socket.readyState = 1
  socket.emit('open')
  socket.emit('message', JSON.stringify({ type: 'hello' }))
  socket.emit('message', JSON.stringify({ type: 'dsh_stop', task_id: 'run-1' }))
  ws.dispose()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].task_id, 'run-1')
})
