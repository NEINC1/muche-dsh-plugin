// client-ui 依赖 react.act（仅 development 包导出）。本机 shell 全局
// NODE_ENV=production 会让 React 切到生产包导致 act 缺失——这是测试进程的
// 解析条件问题，不是被测面板代码的 Bug。这里只收敛本测试进程的条件，
// 不改被测代码、不放宽断言。react 走动态 import，赋值先于首次加载生效。
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'production') {
  process.env.NODE_ENV = 'test'
}
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { createRuntimeState } from '../lib/runtime-state.js'

const CFG = { backendUrl: 'https://panel.test', apiKey: 'panel-test-key' }
const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Mounts the real built panel bundle in a DOM and lets the test act as the host: it owns the
 * runtime snapshot the SSE route would publish, and pushes real runtime frames into the
 * EventSource the bundle opened. No source rewriting and no private state poking.
 */
async function mountPanel() {
  const win = new Window({ url: 'http://127.0.0.1:19387/' })
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource }
  const react = await import('react')
  const reactDom = await import('react-dom/client')
  // Effects must flush before assertions, so React needs its act environment flag.
  const savedAct = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const sources = []
  const runtime = createRuntimeState({ configNs: 'muche', runtimeId: 'panel-test' })
  runtime.configure(CFG)
  const httpCalls = []
  const fetchStub = async (url, init = {}) => {
    httpCalls.push({ url: String(url), method: init.method || 'GET' })
    if (String(url).includes('/runtime')) return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: runtime.getSnapshot() }) }
    if (String(url).includes('/chat/history')) return { ok: true, status: 200, json: async () => ({ ok: true, messages: [], has_more: false, context: runtime.context() }) }
    return { ok: true, status: 200, json: async () => ({ ok: false, code: 'HTTP_ERROR', error: 'unexpected' }) }
  }
  const makeEventSource = (path) => {
    const source = {
      path, readyState: 0, closed: false,
      onopen: null, onmessage: null, onerror: null,
      close() { this.closed = true; this.readyState = 2 },
      open() { this.readyState = 1; this.onopen?.() },
      send(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) },
    }
    sources.push(source)
    return source
  }
  globalThis.window = win
  globalThis.document = win.document
  globalThis.fetch = fetchStub
  globalThis.EventSource = function EventSourceShim(path) { return makeEventSource(path) }
  win.EventSource = globalThis.EventSource
  win.fetch = fetchStub
  const modules = []
  const loader = { load: (entry) => modules.push(entry) }
  win.__ModuleLoader__ = loader
  globalThis.__ModuleLoader__ = loader
  win.eval(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'))
  const entry = modules.at(-1)
  assert.ok(entry?.factory, 'the built bundle registers its client module')
  // The real loader hands the factory a module resolver; react comes from the host page.
  const module = entry.factory((name) => {
    assert.equal(name, 'react')
    return react
  })
  const renders = {}
  const slots = {
    // The host resolves slot dependencies and runs the registered factory.
    inject: (_name, setup) => setup(),
    register: (spec, render) => { renders[spec.id] = render; return () => {} },
  }
  const configForms = { get: () => ({ getSnapshot: () => ({ status: 'idle', value: {}, revision: 0 }), subscribe: () => () => {}, mutate: async () => {} }) }
  module.apply({ get: (name) => (name === 'slots' ? slots : configForms), on: () => () => {} }, {})
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const root = reactDom.createRoot(container)
  // act() so effects (which start the runtime client) flush before any assertion.
  const act = react.act || (await import('react')).act
  const render = () => {
    act(() => {
      root.render(react.createElement('div', null,
        renders['muche-entry'] ? react.createElement(() => renders['muche-entry']({ wide: true })) : null,
        renders['muche-chat-panel'] ? react.createElement(() => renders['muche-chat-panel']()) : null,
      ))
    })
  }
  render()
  await tick()
  const open = async () => {
    let clicked = false
    await act(async () => {
      for (const node of [...win.document.body.querySelectorAll('button')]) {
        if (node.textContent === '小沐') { node.click(); clicked = true; break }
      }
    })
    assert.equal(clicked, true, 'the sidebar entry exists and opens the panel')
  }
  // Host-published runtime frames arrive outside React, so they are wrapped in act() here.
  const pushRuntime = () => act(() => { for (const source of sources) if (!source.closed) source.send({ type: 'runtime', snapshot: runtime.getSnapshot() }) })
  const text = () => win.document.body.textContent || ''
  return {
    win, runtime, react, httpCalls, sources, open, pushRuntime, text, render, act,
    restore: () => {
      globalThis.IS_REACT_ACT_ENVIRONMENT = savedAct
      Object.assign(globalThis, saved)
    },
  }
}

test('the panel starts in connecting and only reports online after a synchronized ready snapshot', async () => {
  const panel = await mountPanel()
  try {
    await panel.open()
    assert.equal(panel.text().includes('连接中'), true, 'startup state is visible, not hidden and not offline')
    assert.equal(panel.text().includes('在线'), false, 'an unsynchronized panel never claims online')
    for (const source of panel.sources) source.open()
    await tick(); await tick()
    const context = panel.runtime.context()
    panel.runtime.observeHttp(context, { ok: true }, { ticket: panel.runtime.beginHttp() })
    panel.runtime.setReceive(context, { status: 'open', ready: true })
    panel.pushRuntime()
    await tick()
    assert.equal(panel.text().includes('在线'), true, 'HTTP reachability plus a real receive hello shows online')
    assert.equal(panel.text().includes('请检查配置'), false)
  } finally { panel.restore() }
})

test('a network interruption shows reconnection wording and clears itself on recovery alone', async () => {
  const panel = await mountPanel()
  try {
    await panel.open()
    for (const source of panel.sources) source.open()
    await tick(); await tick()
    const context = panel.runtime.context()
    panel.runtime.observeHttp(context, { ok: true }, { ticket: panel.runtime.beginHttp() })
    panel.runtime.setReceive(context, { status: 'open', ready: true })
    panel.pushRuntime()
    await tick()
    panel.runtime.setReceive(context, { status: 'closed', code: 'NETWORK' })
    panel.pushRuntime()
    await tick()
    assert.equal(panel.text().includes('连接暂时中断，正在重连'), true)
    assert.equal(panel.text().includes('请检查配置'), false, 'a dropped connection is never reported as a configuration fault')
    panel.runtime.setReceive(context, { status: 'open', ready: true })
    panel.pushRuntime()
    await tick()
    assert.equal(panel.text().includes('连接暂时中断，正在重连'), false, 'recovery clears the banner without another successful message')
  } finally { panel.restore() }
})

test('quota exhaustion keeps the panel online and shows only the quota notice', async () => {
  const panel = await mountPanel()
  try {
    await panel.open()
    for (const source of panel.sources) source.open()
    await tick(); await tick()
    const context = panel.runtime.context()
    panel.runtime.observeHttp(context, { ok: true }, { ticket: panel.runtime.beginHttp() })
    panel.runtime.setReceive(context, { status: 'open', ready: true })
    panel.pushRuntime()
    await tick()
    assert.equal(panel.text().includes('在线'), true)
    panel.runtime.observeHttp(context, { ok: false, status: 429, code: 'message_quota_exhausted', reset_at: '2099-01-01T00:00:00Z' }, { ticket: panel.runtime.beginHttp(), operation: 'chat' })
    panel.pushRuntime()
    await tick()
    assert.equal(panel.text().includes('在线'), true, 'exhausted quota is an independent notice, not an outage')
    assert.equal(panel.text().includes('离线'), false)
  } finally { panel.restore() }
})

test('a settled bridge fault is shown once and disappears with its own recovery, without hiding chat', async () => {
  const panel = await mountPanel()
  try {
    await panel.open()
    for (const source of panel.sources) source.open()
    await tick(); await tick()
    const context = panel.runtime.context()
    panel.runtime.observeHttp(context, { ok: true }, { ticket: panel.runtime.beginHttp() })
    panel.runtime.setReceive(context, { status: 'open', ready: true })
    panel.pushRuntime()
    assert.equal(panel.text().includes('在线'), true, 'a bridge fault never makes a ready chat look offline')
    assert.equal(panel.text().includes('请检查配置'), false, 'startup silence means no configuration claim')
    panel.runtime.setBridge(context, { phase: 'starting', startupComplete: false })
    panel.pushRuntime()
    await tick()
    assert.equal(panel.text().includes('本机'), false, 'a starting bridge stays silent')
    panel.runtime.setBridge(context, { phase: 'fault', startupComplete: true, code: 'BRIDGE_STARTUP' })
    panel.pushRuntime()
    await tick()
    const faultText = panel.text()
    assert.equal(faultText.includes('本机 dsh 启动失败'), true, 'a settled bridge fault is visible')
    assert.equal(faultText.split('本机 dsh 启动失败').length - 1, 1, 'the same cause is never shown twice')
    panel.runtime.setBridge(context, { phase: 'ready', startupComplete: true })
    panel.pushRuntime()
    await tick()
    assert.equal(panel.text().includes('本机 dsh 启动失败'), false, 'bridge recovery clears the banner by itself')
    assert.equal(panel.text().includes('在线'), true)
  } finally { panel.restore() }
})