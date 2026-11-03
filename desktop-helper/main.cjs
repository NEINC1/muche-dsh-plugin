const { app, BrowserWindow, ipcMain, screen, nativeTheme, globalShortcut } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createDecoder, encode } = require('./lib/protocol.cjs')
const { windowSizeFor, clampToWorkArea } = require('./lib/geometry.cjs')
const { beginDrag, moveDrag } = require('./lib/drag.cjs')
const { createChatWindowController } = require('./lib/chat-window.cjs')
const protocol = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'desktop', 'protocol.json'), 'utf8'))
for (const level of ['log', 'info', 'warn', 'error']) console[level] = (...args) => process.stderr.write(args.map(String).join(' ') + '\n')
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
app.setPath('userData', path.join(home, 'muche-desktop', 'helper-user-data'))
// Windows 的透明分层窗在 DWM 硬件合成下有已知缺陷：拖拽移动时窗口四周出现黑边，透明窗互相覆盖时
// 内容丢失（dsh-pet / dsh-whale-pixel-pet 的实测结论与规避方式）。桌宠只播轻量动画、聊天页是普通
// 表单，改走软件合成即可规避，不影响其它进程。
if (process.platform === 'win32') app.disableHardwareAcceleration()
// 隐藏窗口/无手势时也要能自动播放待机动画；缺失时表现为"立绘不动"。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
let win = null, asset = null, drag = null, hostTimer = null, windowReady = false, mediaReady = false, readySent = false
// The pet's DIP size is decided once at init and re-asserted on every position commit, so a
// display change during a drag can never leave the artwork at another scale.
let dims = null, smokeCursor = null
const send = msg => { if (process.stdout.writable) process.stdout.write(encode(msg)) }
const error = (code, text) => { console.warn(code, text); send({ type: 'error', code, text }) }
const chat = createChatWindowController({ BrowserWindow, screen, nativeTheme, preloadDir: __dirname,
  showWindows: process.env.MUCHE_HELPER_SMOKE_OFFSCREEN !== '1',
  onError: () => send({ type: 'chat-error' }),
  onReady: current => {
    if (process.env.MUCHE_HELPER_CHAT_SMOKE !== '1') return
    let checks = 0
    const check = async () => {
      if (current.isDestroyed()) return
      try {
        const visible = await current.webContents.executeJavaScript("(() => { const panel = document.querySelector('[data-muche-desktop-chat]'); if (!window.mucheDesktopChat?.active || !panel?.querySelector('button')) return false; const rect = panel.getBoundingClientRect(); return rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1 })()")
        if (visible) {
          if (process.env.MUCHE_HELPER_CHAT_SMOKE_PNG) {
            const image = await current.webContents.capturePage()
            fs.writeFileSync(process.env.MUCHE_HELPER_CHAT_SMOKE_PNG, image.toPNG())
          }
          console.info('muche-chat-smoke: ready=true')
          send({ type: 'chat-smoke', ready: true }); return
        }
      } catch (e) { console.warn('chat smoke probe failed', e.name) }
      if (++checks < 150) setTimeout(check, 100)
      else { console.warn('muche-chat-smoke: ready=false'); send({ type: 'chat-smoke', ready: false }) }
    }
    void check()
  } })

// ── 桌面级语音：立绘在桌面上时，Alt+Q 开始说话 / 再按一次发送，Alt+Z 取消 ──
// 快捷键是系统级的（人不用先点聊天框），但录音、发送、播放都发生在聊天页里——那页有鉴权、
// 有麦克风权限、有和聊天完全相同的上行链路。所以这里只做三件事：注册热键、按需建一个**不显示**
// 的窗口、把指令转发进去。太短的录音由页面按误触丢弃（它才知道实际时长）。
const VOICE_TOGGLE_KEY = 'Alt+Q'
const VOICE_CANCEL_KEY = 'Alt+Z'
let voiceShortcutsRegistered = false
let voiceArmed = false       // 下一次 Alt+Q 是"开始"还是"发送"（主进程乐观翻转，页面状态回来再校准）
let voiceRequest = null      // 窗口还没建好时，等地址回来要补发的指令

function deliverVoice(payload) {
  if (chat.sendCommand(payload)) return
  if (voiceRequest) return
  voiceRequest = payload
  send({ type: 'chat-url-request' })
}
// 立绘上的语音状态：主进程先乐观亮起（隐藏窗口要几百毫秒才建好），页面随后上报真实状态校准。
function notifyPetVoice(state) {
  if (win && !win.isDestroyed()) win.webContents.send('muche:voice-state', state)
}
function onVoiceToggle() {
  voiceArmed = !voiceArmed
  notifyPetVoice(voiceArmed ? 'recording' : 'sending')
  deliverVoice({ command: voiceArmed ? 'voice-start' : 'voice-stop' })
}
function registerVoiceShortcuts() {
  if (voiceShortcutsRegistered) return
  // 离屏冒烟/e2e 跑在用户桌面里：别为了测试把 Alt+Q 抢走。
  if (process.env.MUCHE_HELPER_SMOKE_OFFSCREEN === '1') return
  try {
    const toggle = globalShortcut.register(VOICE_TOGGLE_KEY, onVoiceToggle)
    const cancel = globalShortcut.register(VOICE_CANCEL_KEY, () => {
      if (!voiceArmed) return
      voiceArmed = false
      notifyPetVoice('idle')
      deliverVoice({ command: 'voice-cancel' })
    })
    if (!toggle || !cancel) throw new Error('shortcut occupied')
    voiceShortcutsRegistered = true
    console.info('muche voice: shortcuts registered')
  } catch (failure) {
    globalShortcut.unregisterAll()
    console.warn('muche voice: shortcuts unavailable', failure?.message || failure)
    error('SHORTCUT_UNAVAILABLE', '语音快捷键被占用')
  }
}
function unregisterVoiceShortcuts() {
  voiceArmed = false
  if (!voiceShortcutsRegistered) return
  voiceShortcutsRegistered = false
  globalShortcut.unregisterAll()
}

// Screen DIP is the only drag coordinate space: renderer client coordinates are window
// relative and must never be mixed into it. A smoke run supplies a synthetic cursor because
// the OS cursor cannot be moved from a headless check.
const cursorPoint = () => smokeCursor || screen.getCursorScreenPoint()
function onPointer(point) {
  if (!point) return
  if (point.kind === 'down') { drag = beginDrag(win.getBounds(), cursorPoint()); return }
  if (!drag) return
  if (point.kind === 'move') {
    const next = moveDrag(drag, cursorPoint())
    if (!next.moved) return
    drag.moved = true; win.setBounds({ x: next.x, y: next.y, width: dims.width, height: dims.height }, false); return
  }
  if (point.kind === 'up' || point.kind === 'cancel') {
    const moved = drag.moved; drag = null
    if (moved) { clamp(); const bounds = win.getBounds(); send({ type: 'moved', x: bounds.x, y: bounds.y }); return 'moved' }
    if (point.kind === 'up') { send({ type: 'clicked' }); return 'clicked' }
  }
  return null
}
function dragSmoke() {
  if (!win || win.isDestroyed() || drag) return null
  const steps = 12, cycles = 3, origin = screen.getCursorScreenPoint(), sizes = []
  try {
    for (let cycle = 0; cycle < cycles; cycle++) {
      const start = win.getBounds()
      smokeCursor = { x: origin.x, y: origin.y }
      onPointer({ kind: 'down' })
      for (let step = 1; step <= steps; step++) {
        smokeCursor = { x: origin.x - step * 12, y: origin.y - step * 4 }
        onPointer({ kind: 'move' })
      }
      onPointer({ kind: 'up' })
      const bounds = win.getBounds()
      sizes.push({ width: bounds.width, height: bounds.height })
      win.setBounds({ x: start.x, y: start.y, width: dims.width, height: dims.height }, false)
    }
  } finally { smokeCursor = null }
  // A release without movement is the click that opens chat; assert it on the same path.
  smokeCursor = { x: origin.x, y: origin.y }
  onPointer({ kind: 'down' })
  const click = onPointer({ kind: 'up' })
  smokeCursor = null
  return { sizes, steps, cycles, click }
}
const areas = () => screen.getAllDisplays().map(display => display.workArea)
// 点击穿透与"不进任务栏"是同一个窗口状态。Windows 的 skipTaskbar 是一次性 ITaskbarList::DeleteTab，
// 窗口再被激活/显示时会被加回任务栏——表现就是鼠标一进立绘，任务栏冒出 Electron 默认图标的按钮，
// 离开又消失。所以两者只在同一个出口里成对发生；立绘本身也不该抢焦点（focusable: false）。
function setInteractive(inside) {
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(!inside, { forward: true })
  win.setSkipTaskbar(true)
}
function reportReady() { if (!readySent && windowReady && mediaReady) { readySent = true; send({ type: 'ready' }) } }
function clamp() {
  if (!win || win.isDestroyed() || !dims) return
  const bounds = win.getBounds()
  const pos = clampToWorkArea({ ...bounds, areas: areas() })
  win.setBounds({ ...pos, width: dims.width, height: dims.height }, false)
}
function init(msg) {
  console.info('initializing desktop window')
  if (msg.protocol !== protocol.protocol || win) return error('PROTOCOL_MISMATCH', '桌面协议不匹配')
  const fallback = path.join(__dirname, 'assets', 'placeholder.svg')
  let size
  try {
    const image = fs.readFileSync(msg.assetPath || '')
    const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'dsh-pet-idle.json'), 'utf8'))
    const c = metadata.crop
    if (image.length < 4 || image.readUInt32BE(0) !== 0x1a45dfa3 || !c || ![metadata.videoWidth, metadata.videoHeight, c.x, c.y, c.width, c.height].every(Number.isFinite) || c.width <= 0 || c.height <= 0 || c.x < 0 || c.y < 0 || c.x + c.width > metadata.videoWidth || c.y + c.height > metadata.videoHeight) throw new Error('invalid desktop animation')
    size = { width: c.width, height: c.height }
    asset = { kind: 'video', url: `data:video/webm;base64,${image.toString('base64')}`, ...metadata, padding: msg.window.padding }
  } catch (e) {
    console.warn('asset unavailable; using placeholder')
    asset = { kind: 'image', url: `data:image/svg+xml;base64,${fs.readFileSync(fallback).toString('base64')}`, padding: msg.window.padding }
    size = { width: 220, height: 400 }
  }
  dims = windowSizeFor({ imageWidth: size.width, imageHeight: size.height, bodyHeight: msg.window.bodyHeight, padding: msg.window.padding })
  const pos = clampToWorkArea({ ...dims, x: msg.window.x, y: msg.window.y, areas: areas() })
  win = new BrowserWindow({ ...dims, ...pos, show: false, transparent: true, backgroundColor: '#00000000', frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, hasShadow: false, focusable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } })
  setInteractive(false)
  // 立绘窗口没有自己的右键菜单；交给渲染端自绘之前，先屏蔽 Electron/Chromium 的默认菜单。
  win.webContents.on('context-menu', event => event.preventDefault())
  // Creation rounds the requested DIP size differently from setBounds at fractional display
  // scales; normalize once so the first drag cannot change the artwork's scale.
  win.setBounds({ ...pos, width: dims.width, height: dims.height }, false)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.once('ready-to-show', () => { windowReady = true; reportReady() })
  win.on('closed', () => { console.info('desktop window closed'); win = null; app.quit() })
  win.loadFile(path.join(__dirname, 'index.html')).catch(e => error('PAGE_LOAD_FAILED', e.message))
}
function handle(msg) {
  if (!msg || typeof msg.type !== 'string') return
  if (msg.type === 'init') return init(msg)
  if (msg.type === 'ping') return send({ type: 'pong' })
  if (msg.type === 'shutdown') return app.quit()
  if (msg.type === 'open-chat' && win) { chat.open(msg.url, win); return }
  // 语音轮：宿主现取的鉴权地址 → 建一个不显示的聊天页，加载完成后补发那条待办指令。
  if (msg.type === 'chat-url' && win) {
    const pending = voiceRequest
    voiceRequest = null
    if (!msg.url) { error('CHAT_UNAVAILABLE', '聊天窗口暂时不可用'); return }
    const opened = chat.open(msg.url, win, { show: false, onLoaded: () => { if (pending) chat.sendCommand(pending) } })
    if (!opened) error('CHAT_UNAVAILABLE', '聊天窗口暂时不可用')
    return
  }
  if (msg.type === 'show' && win) {
    if (process.env.MUCHE_HELPER_SMOKE_OFFSCREEN !== '1') { win.showInactive(); win.setSkipTaskbar(true) }
    // 立绘在桌面上时才占这两个系统热键；隐藏/退出时一并释放。
    registerVoiceShortcuts()
    send({ type: 'shown', bounds: win.getBounds() })
    if (process.env.MUCHE_HELPER_SMOKE === '1') {
      win.webContents.capturePage().then(first => setTimeout(() => {
        if (!win || win.isDestroyed()) return
        win.webContents.capturePage().then(async second => {
          const firstPng = first.toPNG(), png = second.toPNG()
          if (process.env.MUCHE_HELPER_SMOKE_PNG) fs.writeFileSync(process.env.MUCHE_HELPER_SMOKE_PNG, png)
          const dragResult = process.env.MUCHE_HELPER_DRAG_SMOKE === '1' ? dragSmoke() : null
          // 语音状态必须在立绘上看得见：推一次 recording，读回徽标的可见性与文案。
          let voiceBadge = null
          try {
            win.webContents.send('muche:voice-state', 'recording')
            await new Promise(resolve => setTimeout(resolve, 60))
            voiceBadge = await win.webContents.executeJavaScript("(() => { const badge = document.getElementById('voice-badge'); return badge ? getComputedStyle(badge).display !== 'none' && badge.textContent.includes('正在听') : false })()")
            if (process.env.MUCHE_HELPER_SMOKE_PNG) {
              const image = await win.webContents.capturePage()
              fs.writeFileSync(process.env.MUCHE_HELPER_SMOKE_PNG.replace(/\.png$/, '') + '-voice.png', image.toPNG())
            }
          } catch (e) { console.warn('voice badge probe failed', e.name) }
          send({ type: 'smoke', pngBytes: png.length, animated: !firstPng.equals(png), drag: dragResult, voiceBadge })
        }).catch(e => error('SMOKE_FAILED', e.message))
      }, 800)).catch(e => error('SMOKE_FAILED', e.message))
    }
    if (process.env.MUCHE_HELPER_CHAT_SMOKE === '1') setTimeout(() => send({ type: 'clicked' }), 100)
    return
  }
  console.warn('unknown command', msg.type)
}
const decoder = createDecoder({ maxLineBytes: protocol.maxLineBytes, onMessage: handle, onError: reason => console.warn(reason) })
const input = process.env.MUCHE_PIPE_FD ? new (require('node:net').Socket)({ fd: Number(process.env.MUCHE_PIPE_FD), readable: true, writable: false }) : process.stdin
input.on('data', chunk => decoder.write(chunk))
input.on('end', () => { console.info('host pipe ended'); app.quit() })
input.on('close', () => { console.info('host pipe closed'); app.quit() })
input.on('error', e => { console.warn('host pipe failed', e.message); app.quit() })
ipcMain.handle('muche:asset', event => event.sender === win?.webContents ? asset : '')
ipcMain.on('muche:media-ready', event => { if (event.sender === win?.webContents) { mediaReady = true; reportReady() } })
ipcMain.on('muche:media-error', event => { if (event.sender === win?.webContents) error('ASSET_MISSING', '桌宠动画加载失败') })
ipcMain.on('muche:chat-close', event => chat.closeFrom(event.sender))
// 页面是唯一知道"现在到底在不在录音"的一方；主进程只按它上报的状态决定 Alt+Z 要不要处理。
// 页面是唯一知道"现在到底在不在录音"的一方：它报 idle（麦克风失败/已发送）就把开关校准回来，
// 避免下一次 Alt+Q 被当成"发送"而什么都不发；同时把真实状态转给立绘显示。
ipcMain.on('muche:voice-state', (event, state) => {
  if (!chat.owns(event.sender)) return
  voiceArmed = state === 'recording'
  notifyPetVoice(state === 'recording' ? 'recording' : 'idle')
})
ipcMain.on('muche:interactive', (event, inside) => {
  if (event.sender === win?.webContents && !drag && typeof inside === 'boolean') setInteractive(inside)
})
ipcMain.on('muche:pointer', (event, point) => {
  if (event.sender === win?.webContents) onPointer(point)
})
// 版本只有一处真源：随包发布的 package.json（这里不再手抄字面量，免得发版时漂移）。
const appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
app.whenReady().then(() => {
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, clamp)
  send({ type: 'hello', protocol: protocol.protocol, app: protocol.app, version: appVersion })
  const host = Number(process.env.MUCHE_HOST_PID)
  if (Number.isSafeInteger(host) && host > 0) hostTimer = setInterval(() => { try { process.kill(host, 0) } catch (e) { console.warn('host unavailable', e.code); app.quit() } }, 2000)
})
app.on('before-quit', () => {
  console.info('desktop helper quitting')
  unregisterVoiceShortcuts()
  chat.dispose()
  if (hostTimer) clearInterval(hostTimer)
})
app.on('window-all-closed', () => { console.info('all windows closed'); app.quit() })
