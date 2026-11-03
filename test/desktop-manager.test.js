import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopManager } from '../lib/desktop/manager.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
test('show, crash recovery and hide preserve desired state and restart the helper', async () => {
  let saved = { visible: false, x: null, y: null }, launches = 0
  const snapshots = [], commands = []
  const stateFile = { read: () => saved, write: value => { saved = value }, dispose() {} }
  const helpers = []
  const manager = createDesktopManager({ stateFile, runtimeState: { setDesktop: value => snapshots.push(value) }, getChatUrl: () => 'http://127.0.0.1:3000/?token=test',
    hostSupport: { supported: true }, protocol: { protocol: 1, app: 'helper' }, assetPath: 'asset',
    runtimeConfig: { window: { bodyHeight: 360, padding: 8 }, timeouts: { readyMs: 100, shownMs: 100, restartBaseMs: 1, restartMaxAttempts: 3, stableResetMs: 10000 } },
    electronRuntime: { ensure: async () => ({ exePath: 'fake' }) }, logger: { info() {}, warn() {} },
    helperFactory: options => {
      const helper = { start() { launches++; queueMicrotask(() => options.onMessage({ type: 'hello', protocol: 1, app: 'helper' })) },
        send(message) { commands.push(message); if (message.type === 'init') queueMicrotask(() => options.onMessage({ type: 'ready' })); if (message.type === 'show') queueMicrotask(() => options.onMessage({ type: 'shown', bounds: { x: 12, y: 34 } })); return true },
        stop: async () => {}, crash: () => options.onExit({ expected: false }), click: () => options.onMessage({ type: 'clicked' }) }
      helpers.push(helper); return helper
    } })
  await manager.show()
  assert.equal(manager.snapshot().state, 'visible')
  assert.deepEqual(saved, { visible: true, x: 12, y: 34 })
  helpers[0].click(); assert.deepEqual(commands.filter(x => x.type === 'open-chat'), [{ type: 'open-chat', url: 'http://127.0.0.1:3000/?token=test' }])
  helpers[0].crash()
  await new Promise(resolve => setTimeout(resolve, 20)); await tick()
  assert.equal(launches, 2)
  assert.equal(manager.snapshot().state, 'visible')
  helpers[0].click()
  assert.equal(commands.filter(x => x.type === 'open-chat').length, 1, 'a stale helper cannot open chat after replacement')
  helpers[1].click()
  assert.equal(commands.filter(x => x.type === 'open-chat').length, 2)
  await manager.hide()
  assert.equal(manager.snapshot().state, 'idle')
  assert.equal(saved.visible, false)
  await manager.dispose()
  assert.ok(snapshots.length > 1)
})

test('a helper asking for the chat url gets the live authenticated url back', async () => {
  const commands = []
  let chatUrl = 'http://127.0.0.1:3000/?token=first'
  let ask = () => {}
  const manager = createDesktopManager({
    stateFile: { read: () => ({ visible: false, x: null, y: null }), write() {}, dispose() {} },
    runtimeState: { setDesktop() {} }, getChatUrl: () => chatUrl,
    hostSupport: { supported: true }, protocol: { protocol: 1, app: 'helper' }, assetPath: 'asset',
    runtimeConfig: { window: { bodyHeight: 360, padding: 8 }, timeouts: { readyMs: 100, shownMs: 100, restartBaseMs: 1, restartMaxAttempts: 3, stableResetMs: 10000 } },
    electronRuntime: { ensure: async () => ({ exePath: 'fake' }) }, logger: { info() {}, warn() {} },
    helperFactory: options => {
      ask = () => options.onMessage({ type: 'chat-url-request' })
      return {
        start() { queueMicrotask(() => options.onMessage({ type: 'hello', protocol: 1, app: 'helper' })) },
        send(message) {
          commands.push(message)
          if (message.type === 'init') queueMicrotask(() => options.onMessage({ type: 'ready' }))
          if (message.type === 'show') queueMicrotask(() => options.onMessage({ type: 'shown', bounds: { x: 0, y: 0 } }))
          return true
        },
        stop: async () => {},
      }
    },
  })
  await manager.show()
  chatUrl = 'http://127.0.0.1:3000/?token=second'
  ask()
  const replies = commands.filter(command => command.type === 'chat-url')
  assert.equal(replies.length, 1, 'the host answers every request once')
  assert.equal(replies[0].url, 'http://127.0.0.1:3000/?token=second', 'the url is minted at request time, not cached')
  await manager.dispose()
})

test('an unavailable chat url answers empty so the helper can report it instead of hanging', async () => {
  const commands = []
  let ask = () => {}
  const manager = createDesktopManager({
    stateFile: { read: () => ({ visible: false, x: null, y: null }), write() {}, dispose() {} },
    runtimeState: { setDesktop() {} }, getChatUrl: () => { throw new Error('no connection') },
    hostSupport: { supported: true }, protocol: { protocol: 1, app: 'helper' }, assetPath: 'asset',
    runtimeConfig: { window: { bodyHeight: 360, padding: 8 }, timeouts: { readyMs: 100, shownMs: 100, restartBaseMs: 1, restartMaxAttempts: 3, stableResetMs: 10000 } },
    electronRuntime: { ensure: async () => ({ exePath: 'fake' }) }, logger: { info() {}, warn() {} },
    helperFactory: options => {
      ask = () => options.onMessage({ type: 'chat-url-request' })
      return {
        start() { queueMicrotask(() => options.onMessage({ type: 'hello', protocol: 1, app: 'helper' })) },
        send(message) {
          commands.push(message)
          if (message.type === 'init') queueMicrotask(() => options.onMessage({ type: 'ready' }))
          if (message.type === 'show') queueMicrotask(() => options.onMessage({ type: 'shown', bounds: { x: 0, y: 0 } }))
          return true
        },
        stop: async () => {},
      }
    },
  })
  await manager.show()
  ask()
  assert.deepEqual(commands.filter(command => command.type === 'chat-url'), [{ type: 'chat-url', url: '' }])
  await manager.dispose()
})

function makeManager({ ensure, factory, stateFile } = {}) {
  return createDesktopManager({
    runtimeState: { setDesktop() {} }, publish() {},
    stateFile: stateFile || { read: () => ({ visible: false, x: null, y: null }), write() {}, dispose() {} },
    electronRuntime: { ensure: ensure || (async () => ({ exePath: 'fake' })) },
    hostSupport: { supported: true }, helperFactory: factory, protocol: { protocol: 1, app: 'helper' }, assetPath: 'asset',
    runtimeConfig: { window: { bodyHeight: 360, padding: 8 }, timeouts: { readyMs: 50, shownMs: 50, restartBaseMs: 1, restartMaxAttempts: 2, stableResetMs: 10000 } },
    logger: { info() {}, warn() {} },
  })
}

test('synchronous spawn failure resolves as failed without leaking a rejected handshake', async () => {
  const manager = makeManager({ factory: () => ({ start() { throw new Error('spawn failed') }, stop: async () => {} }) })
  await manager.show()
  assert.equal(manager.snapshot().state, 'failed')
  assert.equal(manager.snapshot().code, 'HELPER_START_FAILED')
  await tick()
  await manager.dispose()
})

test('a synchronous protocol write failure does not leak a rejected readiness waiter', async () => {
  const manager = makeManager({ factory: options => ({ start() { queueMicrotask(() => options.onMessage({ type: 'hello', protocol: 1, app: 'helper' })) }, send() { throw new Error('write failed') }, stop: async () => {} }) })
  await manager.show()
  assert.equal(manager.snapshot().state, 'failed')
  await tick()
  await manager.dispose()
})

test('helper exit immediately after shown cannot commit a visible window', async () => {
  const manager = makeManager({ factory: options => ({
    start() { queueMicrotask(() => options.onMessage({ type: 'hello', protocol: 1, app: 'helper' })) },
    send(message) {
      if (message.type === 'init') queueMicrotask(() => options.onMessage({ type: 'ready' }))
      if (message.type === 'show') queueMicrotask(() => { options.onMessage({ type: 'shown', bounds: { x: 0, y: 0 } }); options.onExit({ expected: false }) })
    },
    stop: async () => {},
  }) })
  await manager.show()
  assert.equal(manager.snapshot().state, 'failed')
  assert.equal(manager.snapshot().visible, false)
  await manager.dispose()
})

test('hiding during download cancels the eventual spawn and preserves the hidden preference', async () => {
  let finishDownload, launches = 0, saved
  const ensure = () => new Promise(resolve => { finishDownload = resolve })
  const manager = makeManager({ ensure, factory: () => { launches++; throw new Error('must not spawn') },
    stateFile: { read: () => ({ visible: false, x: null, y: null }), write: value => { saved = value }, dispose() {} } })
  const showing = manager.show()
  await tick()
  const hiding = manager.hide()
  finishDownload({ exePath: 'fake' })
  await Promise.all([showing, hiding])
  assert.equal(launches, 0)
  assert.equal(manager.snapshot().state, 'idle')
  assert.equal(saved.visible, false)
  await manager.dispose()
})

test('dispose flushes the preference before waiting for the helper to exit', async () => {
  let disposedState = false, releaseStop
  const manager = makeManager({ stateFile: { read: () => ({ visible: false, x: null, y: null }), write() {}, dispose() { disposedState = true } },
    factory: options => ({ start() { queueMicrotask(() => options.onMessage({ type: 'hello', protocol: 1, app: 'helper' })) },
      send(message) { if (message.type === 'init') queueMicrotask(() => options.onMessage({ type: 'ready' })); if (message.type === 'show') queueMicrotask(() => options.onMessage({ type: 'shown', bounds: { x: 0, y: 0 } })) },
      stop: () => new Promise(resolve => { releaseStop = resolve }) }) })
  await manager.show()
  const disposing = manager.dispose()
  assert.equal(disposedState, true)
  releaseStop(); await disposing
})

test('a failed restart is retried until the bounded recovery succeeds', async () => {
  let launches = 0, crashFirst
  const manager = makeManager({ factory: options => {
    const number = ++launches
    if (number === 1) crashFirst = () => options.onExit({ expected: false })
    return {
      start() {
        if (number === 2) throw new Error('temporary spawn failure')
        queueMicrotask(() => options.onMessage({ type: 'hello', protocol: 1, app: 'helper' }))
      },
      send(message) {
        if (message.type === 'init') queueMicrotask(() => options.onMessage({ type: 'ready' }))
        if (message.type === 'show') queueMicrotask(() => options.onMessage({ type: 'shown', bounds: { x: 1, y: 2 } }))
      },
      stop: async () => {},
    }
  } })
  await manager.show()
  crashFirst()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(launches, 3)
  assert.equal(manager.snapshot().state, 'visible')
  await manager.dispose()
})
