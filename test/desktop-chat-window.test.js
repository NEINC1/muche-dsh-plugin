import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createChatWindowController, parseSetCookie } from '../desktop-helper/lib/chat-window.cjs'

function fixture({ dark = false, fetchImpl } = {}) {
  const windows = [], requests = [], cookieJar = []
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.webContents = new EventEmitter()
      this.webContents.session = {
        partition: 'muche-desktop-chat',
        cookies: { set: async cookie => { cookieJar.push(cookie) } },
        setPermissionRequestHandler: handler => { this.permissionHandler = handler },
        setPermissionCheckHandler: handler => { this.permissionCheck = handler },
      }
      this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn }
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    show() { this.shown = true; this.events = [...(this.events || []), 'show'] }
    focus() { this.focused = true }
    close() { this.destroyed = true; this.emit('closed') }
    async loadURL(value) { this.loads = [...(this.loads || []), value]; this.events = [...(this.events || []), 'load'] }
  }
  const fetchMock = fetchImpl || (async (url, init) => {
    requests.push({ url, init })
    return { status: 302, headers: { getSetCookie: () => ['dsh_session=abc123; Path=/; HttpOnly; SameSite=Lax'] } }
  })
  const controller = createChatWindowController({
    BrowserWindow: Window, fetch: fetchMock, nativeTheme: { shouldUseDarkColors: dark }, preloadDir: 'helper',
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
  })
  const pet = { getBounds: () => ({ x: 1500, y: 500, width: 220, height: 380 }) }
  return { controller, windows, requests, cookieJar, pet }
}

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve)) }

test('desktop chat writes the exchanged cookie and loads only the plugin page', async () => {
  const { controller, windows, requests, cookieJar, pet } = fixture()
  assert.equal(controller.open('http://127.0.0.1:3000/?token=test', pet), true)
  assert.equal(windows.length, 1)
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false)
  assert.equal(windows[0].options.webPreferences.partition, 'muche-desktop-chat')
  await settle()
  assert.deepEqual(requests.map(request => request.url), ['http://127.0.0.1:3000/?token=test'], 'the token is exchanged once')
  assert.equal(requests[0].init.redirect, 'manual', 'the exchange must not follow the app redirect')
  assert.deepEqual(cookieJar.map(cookie => [cookie.name, cookie.value, cookie.path, cookie.httpOnly]), [['dsh_session', 'abc123', '/', true]])
  assert.deepEqual(windows[0].loads, ['http://127.0.0.1:3000/api/muche/desktop-chat'], 'the DSH app itself is never rendered in the chat window')
  assert.equal(windows[0].shown, true)
  assert.deepEqual(windows[0].events, ['show', 'load'], 'the window appears before the page finishes loading')
  // Voice input needs the microphone; the isolated partition grants only that, only to this page.
  const grants = []
  windows[0].permissionHandler(windows[0].webContents, 'media', granted => grants.push(granted))
  windows[0].permissionHandler(windows[0].webContents, 'notifications', granted => grants.push(granted))
  windows[0].permissionHandler({}, 'media', granted => grants.push(granted))
  assert.deepEqual(grants, [true, false, false])
  assert.equal(windows[0].permissionCheck(windows[0].webContents, 'media'), true)
  assert.equal(windows[0].permissionCheck(windows[0].webContents, 'geolocation'), false)
  assert.equal(controller.open('http://127.0.0.1:3000/', pet), true)
  assert.equal(windows.length, 1); assert.equal(windows[0].focused, true)
  let blocked = false
  windows[0].webContents.emit('will-navigate', { preventDefault() { blocked = true } }, 'https://other.example/')
  assert.equal(blocked, true)
  controller.closeFrom({}); assert.equal(windows[0].destroyed, false)
  controller.closeFrom(windows[0].webContents); assert.equal(windows[0].destroyed, true)
  assert.equal(controller.open('javascript:alert(1)', pet), false)
  controller.dispose()
})

test('the voice window stays hidden, out of the taskbar, and accepts commands', async () => {
  const { controller, windows, pet } = fixture()
  assert.equal(controller.open('http://127.0.0.1:3000/?token=test', pet, { show: false }), true)
  await settle()
  assert.equal(windows[0].options.skipTaskbar, true, 'the voice window leaves no taskbar entry')
  assert.equal(windows[0].shown, undefined, 'a voice turn never shows the window')
  const sent = []
  windows[0].webContents.send = (channel, payload) => sent.push([channel, payload])
  assert.equal(controller.sendCommand({ command: 'voice-start' }), true)
  assert.deepEqual(sent, [['muche:voice', { command: 'voice-start' }]])
  assert.equal(controller.owns(windows[0].webContents), true)
  assert.equal(controller.owns({}), false)
  controller.closeFrom(windows[0].webContents)
  assert.equal(controller.sendCommand({ command: 'voice-stop' }), false, 'a closed window accepts no command')
})

test('desktop chat window background follows the system theme', () => {
  const light = fixture()
  light.controller.open('http://127.0.0.1:3000/?token=test', light.pet)
  assert.equal(light.windows[0].options.backgroundColor, '#ffffff')
  const dark = fixture({ dark: true })
  dark.controller.open('http://127.0.0.1:3000/?token=test', dark.pet)
  assert.equal(dark.windows[0].options.backgroundColor, '#1b1c1f')
})

test('desktop chat closes itself when the cookie exchange fails', async () => {
  const noCookie = fixture({ fetchImpl: async () => ({ status: 401, headers: { getSetCookie: () => [] } }) })
  noCookie.controller.open('http://127.0.0.1:3000/?token=test', noCookie.pet)
  await settle()
  assert.equal(noCookie.windows[0].destroyed, true, 'an unusable window is closed instead of left blank')
  assert.equal(noCookie.windows[0].loads, undefined, 'nothing is rendered without authentication')
  assert.equal(noCookie.cookieJar.length, 0)
})

test('set-cookie attributes survive the exchange', () => {
  const cookie = parseSetCookie('dsh_session=v; Path=/app; Domain=example.test; Secure; HttpOnly; SameSite=Strict; Max-Age=600', 'https://example.test')
  assert.deepEqual(
    { name: cookie.name, value: cookie.value, path: cookie.path, domain: cookie.domain, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite },
    { name: 'dsh_session', value: 'v', path: '/app', domain: 'example.test', secure: true, httpOnly: true, sameSite: 'strict' },
  )
  assert.ok(cookie.expirationDate > Date.now() / 1000)
  assert.throws(() => parseSetCookie('broken', 'https://example.test'))
})
