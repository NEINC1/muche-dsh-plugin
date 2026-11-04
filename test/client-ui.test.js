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
async function mountPanel({ desktopMode = false, tasks = [], stopResult = null, taskResponse = null } = {}) {
  const win = new Window({ url: 'http://127.0.0.1:19387/' })
  let desktopCloses = 0
  if (desktopMode) win.mucheDesktopChat = { active: true, close() { desktopCloses++ } }
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
    httpCalls.push({ url: String(url), method: init.method || 'GET', body: init.body })
    if (String(url).includes('/runtime')) return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: runtime.getSnapshot() }) }
    if (String(url).includes('/chat/history')) return { ok: true, status: 200, json: async () => ({ ok: true, messages: [], has_more: false, context: runtime.context() }) }
    if (String(url).includes('/tasks/stop')) {
      const context = runtime.context()
      const result = typeof stopResult === 'function' ? await stopResult() : stopResult
      return { ok: true, status: 200, json: async () => ({ ...result, context }) }
    }
    if (String(url).includes('/tasks')) {
      const context = runtime.context()
      const values = taskResponse ? await taskResponse() : tasks
      return { ok: true, status: 200, json: async () => ({ ok: true, tasks: values, context }) }
    }
    if (String(url).includes('/desktop')) return { ok: true, status: 202, json: async () => ({ ok: true, accepted: true, snapshot: runtime.getSnapshot() }) }
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
  const disposers = []
  // The client fiber releases registrations through ctx.effect, not through a 'dispose' event.
  module.apply({
    get: (name) => name === 'slots' ? slots : configForms,
    on: () => () => {},
    effect: (setup) => { const dispose = setup(); if (typeof dispose === 'function') disposers.push(dispose) },
  }, {})
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
        renders['muche-menu'] ? react.createElement(() => renders['muche-menu']()) : null,
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
    await act(async () => {
      const button = [...win.document.querySelectorAll('button')].find(node => node.textContent === '打开聊天面板')
      assert.ok(button, 'the desktop-unavailable menu offers chat')
      button.click()
    })
  }
  // Host-published runtime frames arrive outside React, so they are wrapped in act() here.
  const pushRuntime = () => act(() => { for (const source of [...sources]) if (!source.closed) source.send({ type: 'runtime', snapshot: runtime.getSnapshot() }) })
  const text = () => win.document.body.textContent || ''
  return {
    win, runtime, react, httpCalls, sources, open, pushRuntime, text, render, act, desktopCloses: () => desktopCloses,
    restore: () => {
      act(() => root.unmount())
      for (const dispose of disposers) dispose()
      runtime.dispose()
      win.happyDOM.abort()
      globalThis.IS_REACT_ACT_ENVIRONMENT = savedAct
      Object.assign(globalThis, saved)
    },
  }
}

test('task panel shows recorded results and reports an unconfirmed stop', async () => {
  const panel = await mountPanel({
    tasks: [
      { task_id: 'done', goal: '检查电脑游戏', stage_label: '已完成', active: false, can_stop: false,
        assignments: [{ run_id: 'r1', status: 'succeeded', result_text: '游戏甲\n游戏乙' }] },
      { task_id: 'running', goal: '调研 AI', stage_label: '执行中', active: true, can_stop: true },
    ],
    stopResult: { ok: false, result: { action: 'unsupported' } },
  })
  try {
    await panel.open()
    await panel.act(async () => {
      panel.win.document.querySelector('[aria-label="任务列表"]').click()
      await tick()
    })
    assert.equal(panel.text().includes('继续'), false)
    const details = [...panel.win.document.querySelectorAll('button')].filter(node => node.textContent === '详情')
    await panel.act(async () => details[0].click())
    assert.match(panel.text(), /游戏甲\s*游戏乙/)
    const stop = [...panel.win.document.querySelectorAll('button')].find(node => node.textContent === '停止')
    await panel.act(async () => { stop.click(); await tick() })
    assert.match(panel.text(), /宿主插件尚不支持确认停止/)
    const calls = panel.httpCalls.filter(call => call.url.includes('/tasks/stop'))
    assert.equal(calls.length, 1)
    assert.equal(JSON.parse(calls[0].body).task_id, 'running')
    assert.equal(panel.httpCalls.filter(call => call.url.includes('/api/muche/chat')).length, 0)
  } finally { panel.restore() }
})

test('task panel fences old tasks and delayed stop receipts when the account changes', async () => {
  const tasks = [{ task_id: 'old', goal: '旧账户任务', stage_label: '执行中', active: true, can_stop: true }]
  let finishStop
  const panel = await mountPanel({ tasks, stopResult: () => new Promise(resolve => { finishStop = resolve }) })
  try {
    await panel.open()
    await panel.act(async () => { panel.win.document.querySelector('[aria-label="任务列表"]').click(); await tick() })
    assert.match(panel.text(), /旧账户任务/)
    await panel.act(async () => {
      [...panel.win.document.querySelectorAll('button')].find(node => node.textContent === '停止').click()
      await tick()
    })
    assert.match(panel.text(), /正在确认停止结果/)
    tasks.splice(0, tasks.length, { task_id: 'new', goal: '新账户任务', stage_label: '执行中', active: true, can_stop: true })
    panel.runtime.configure({ ...CFG, apiKey: 'another-panel-test-key' })
    panel.pushRuntime()
    await panel.act(async () => { await tick() })
    assert.doesNotMatch(panel.text(), /旧账户任务|正在确认停止结果/)
    assert.match(panel.text(), /新账户任务/)
    await panel.act(async () => { finishStop({ ok: true, result: { action: 'stopped' } }); await tick() })
    assert.doesNotMatch(panel.text(), /旧账户任务|任务已停止/)
    assert.match(panel.text(), /新账户任务/)
  } finally { panel.restore() }
})

test('a late task refresh cannot restore an older running status', async () => {
  let holdNext = false
  let finishOld
  let tasks = [{ task_id: 'job', goal: '任务', stage_label: '执行中', active: true, can_stop: true }]
  const panel = await mountPanel({ taskResponse: () => {
    if (holdNext) { holdNext = false; return new Promise(resolve => { finishOld = resolve }) }
    return tasks
  } })
  try {
    await panel.open()
    await panel.act(async () => { panel.win.document.querySelector('[aria-label="任务列表"]').click(); await tick() })
    assert.match(panel.text(), /执行中/)
    holdNext = true
    await panel.act(async () => { panel.win.document.querySelector('[aria-label="任务列表"]').click(); await tick() })
    tasks = [{ task_id: 'job', goal: '任务', stage_label: '已停止', active: false, can_stop: false }]
    await panel.act(async () => { panel.win.document.querySelector('[aria-label="任务列表"]').click(); await tick() })
    assert.match(panel.text(), /已停止/)
    await panel.act(async () => {
      finishOld([{ task_id: 'job', goal: '任务', stage_label: '执行中', active: true, can_stop: true }])
      await tick()
    })
    assert.match(panel.text(), /已停止/)
    assert.doesNotMatch(panel.text(), /执行中/)
  } finally { panel.restore() }
})

// The official settings shell renders its launcher as the account menu; the 设置 item is the
// only entry that opens settings. Settings has no public open service, so the menu must follow
// that item — and must not fake a keydown, which Desktop's native adapter ignores.
function accountLauncher(panel, { label = '账号菜单' } = {}) {
  const button = panel.win.document.createElement('button')
  button.setAttribute('aria-haspopup', 'menu')
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-expanded', 'false')
  const opened = []
  button.addEventListener('click', () => {
    button.setAttribute('aria-expanded', 'true')
    const menu = panel.win.document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = panel.win.document.createElement('button')
    item.setAttribute('role', 'menuitem')
    item.textContent = '设置'
    item.addEventListener('click', () => { opened.push(item) })
    menu.appendChild(item)
    panel.win.document.body.appendChild(menu)
  })
  panel.win.document.body.appendChild(button)
  return { button, opened }
}
const settle = async (condition, ms = 600) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
}

test('menu opens DSH settings through the official account launcher', async () => {
  const panel = await mountPanel()
  try {
    const launcher = accountLauncher(panel)
    let shortcut
    panel.win.addEventListener('keydown', event => { if (event.code === 'Comma') shortcut = event })
    const entry = [...panel.win.document.querySelectorAll('button')].find(node => node.textContent === '小沐')
    await panel.act(async () => entry.click())
    assert.ok(panel.win.document.querySelector('[data-muche-menu]'))
    await panel.act(async () => [...panel.win.document.querySelectorAll('[data-muche-menu] [role="menuitem"]')].find(node => node.textContent === '设置').click())
    await settle(() => launcher.opened.length === 1)
    assert.equal(launcher.opened.length, 1, 'the official 设置 item opens settings')
    assert.equal(shortcut, undefined, 'no synthetic keydown is dispatched')
  } finally { panel.restore() }
})

test('menu sends desktop display requests', async () => {
  const panel = await mountPanel()
  try {
    panel.runtime.setDesktop({ available: true, state: 'idle', visible: false, code: '', text: '', progress: '' })
    await panel.act(async () => { for (const source of panel.sources) source.open() })
    panel.pushRuntime()
    const entry = [...panel.win.document.querySelectorAll('button')].find(node => node.textContent === '小沐')
    await panel.act(async () => entry.click())
    assert.equal(panel.text().includes('连接中'), false, 'entry opens only the menu')
    await panel.act(async () => [...panel.win.document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === '显示小沐').click())
    const request = panel.httpCalls.find(call => call.url.includes('/desktop'))
    assert.deepEqual(JSON.parse(request.body), { action: 'show' })
  } finally { panel.restore() }
})

test('desktop chat view opens the same panel without a duplicate close button', async () => {
  const panel = await mountPanel({ desktopMode: true })
  try {
    assert.equal(panel.text().includes('连接中'), true)
    // The desktop window chrome owns closing; an inner × would be a second close.
    const close = [...panel.win.document.querySelectorAll('button')].find(node => node.textContent === '×')
    assert.equal(close, undefined)
    assert.equal(panel.desktopCloses(), 0)
  } finally { panel.restore() }
})

test('Alt+Q records and sends a voice turn while Alt+Z discards it', async () => {
  const panel = await mountPanel()
  try {
    await panel.open()
    // The runtime context must be live before a voice turn can be posted (same gate as text).
    await panel.act(async () => { for (const source of panel.sources) source.open() })
    panel.pushRuntime()
    const stopped = []
    const microphones = []
    const contexts = []
    panel.win.navigator.mediaDevices = { getUserMedia: async () => { microphones.push(1); return { getTracks: () => [{ stop: () => stopped.push(1) }] } } }
    class FakeContext {
      constructor() { this.sampleRate = 48000; this.destination = {}; contexts.push(this) }
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createScriptProcessor() { this.processor = { onaudioprocess: null, connect() {}, disconnect() {} }; return this.processor }
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
      close() { return Promise.resolve() }
    }
    panel.win.AudioContext = FakeContext
    const speakInto = (context, samples = 48000) => context.processor.onaudioprocess({ inputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(samples).fill(0.2) } })
    const altQ = () => panel.win.dispatchEvent(new panel.win.KeyboardEvent('keydown', { code: 'KeyQ', altKey: true }))
    const altZ = () => panel.win.dispatchEvent(new panel.win.KeyboardEvent('keydown', { code: 'KeyZ', altKey: true }))

    await panel.act(async () => { altQ(); await tick() })
    assert.equal(microphones.length, 1, 'Alt+Q starts recording')
    assert.equal(panel.text().includes('正在听'), true)

    await panel.act(async () => { altZ(); await tick() })
    assert.equal(stopped.length, 1, 'Alt+Z releases the microphone')
    assert.equal(panel.text().includes('正在听'), false, 'the recording prompt disappears')
    assert.equal(panel.httpCalls.some(call => String(call.body || '').includes('"audio"')), false, 'a cancelled recording is never sent')

    await panel.act(async () => { altQ(); await tick() })
    await panel.act(async () => { speakInto(contexts.at(-1)); await tick() })
    await panel.act(async () => { altQ(); await tick() })
    const sent = panel.httpCalls.filter(call => call.url.includes('/api/muche/chat'))
    assert.equal(sent.length, 1, `the second Alt+Q sends exactly one turn (sent=${sent.length} mics=${microphones.length} stopped=${stopped.length})`)
    assert.match(String(sent[0].body), /"audio":"[A-Za-z0-9+/=]+"/, 'the turn carries WAV base64 audio')
    assert.equal(stopped.length, 2, 'the microphone is released on send')

    // 误触：连按两下、录音太短，不发出去，只提示。
    await panel.act(async () => { altQ(); await tick() })
    await panel.act(async () => { speakInto(contexts.at(-1), 4800); await tick() })
    await panel.act(async () => { altQ(); await tick() })
    assert.equal(panel.httpCalls.filter(call => call.url.includes('/api/muche/chat')).length, 1, 'a too-short recording is not sent')
    assert.equal(panel.text().includes('说话太短'), true, 'the panel explains why nothing was sent')
  } finally { panel.restore() }
})

test('settings clicks the plain trigger the shell renders without the account feature', async () => {
  const panel = await mountPanel()
  try {
    const hostButton = panel.win.document.createElement('button')
    hostButton.setAttribute('aria-label', '设置')
    hostButton.setAttribute('aria-haspopup', 'dialog')
    let clicks = 0
    hostButton.addEventListener('click', () => { clicks++ })
    panel.win.document.body.appendChild(hostButton)
    const entry = [...panel.win.document.querySelectorAll('button')].find(node => node.textContent === '小沐')
    await panel.act(async () => entry.click())
    await panel.act(async () => [...panel.win.document.querySelectorAll('[data-muche-menu] [role="menuitem"]')].find(node => node.textContent === '设置').click())
    await settle(() => clicks === 1)
    assert.equal(clicks, 1)
  } finally { panel.restore() }
})

test('settings without a host launcher never reopens the plugin menu', async () => {
  const panel = await mountPanel()
  try {
    const entry = [...panel.win.document.querySelectorAll('button')].find(node => node.textContent === '小沐')
    await panel.act(async () => entry.click())
    await panel.act(async () => [...panel.win.document.querySelectorAll('[data-muche-menu] [role="menuitem"]')].find(node => node.textContent === '设置').click())
    await settle(() => false, 300)
    assert.equal(panel.win.document.querySelector('[data-muche-menu]'), null, 'its own entry is not treated as the launcher')
  } finally { panel.restore() }
})

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
