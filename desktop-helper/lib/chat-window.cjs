const path = require('node:path')
const { clampToWorkArea } = require('./geometry.cjs')

/**
 * 聊天窗 = 隔离 partition 里的一个同源页面。认证与呈现分开：
 * DSH 的鉴权 URL 只在 GET 时换发 Cookie。这里在主进程用一次 fetch 换到 Set-Cookie，写进聊天窗
 * 自己的 session，再加载插件自己的聊天页——窗口里从头到尾不渲染 DSH 应用本身（既快，也不会
 * 因为那一页被顺带执行而产生"弹出个软件又消失"的副作用）。
 * 注意：net.request 不会把响应 Cookie 落进 session（实测 cookieNames 为空、后续请求 401），
 * 所以必须显式写。
 */
function createChatWindowController({ BrowserWindow, screen, fetch: fetchImpl = globalThis.fetch, nativeTheme, preloadDir, onError = () => {}, onReady = () => {}, showWindows = true }) {
  let chat = null

  async function exchangeCookie(session, rawUrl) {
    const response = await fetchImpl(rawUrl, { redirect: 'manual' })
    const cookies = response.headers.getSetCookie?.() || []
    if (!cookies.length) throw new Error(`auth exchange returned no cookie (${response.status})`)
    const origin = new URL(rawUrl).origin
    for (const cookie of cookies) await session.cookies.set(parseSetCookie(cookie, origin))
    return response.status
  }

  function open(rawUrl, pet, { show = true, onLoaded } = {}) {
    if (chat && !chat.isDestroyed()) { if (show && showWindows) { chat.show(); chat.focus() } return true }
    const started = Date.now()
    const mark = label => console.info(`muche chat: ${label} +${Date.now() - started}ms`)
    let url
    try {
      url = new URL(rawUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid origin')
    } catch { onError(); return false }
    const origin = url.origin
    const size = { width: 440, height: 680 }
    const bounds = pet.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const candidate = { x: bounds.x - size.width - 8, y: bounds.y + bounds.height - size.height }
    if (candidate.x < area.x) candidate.x = bounds.x + bounds.width + 8
    const position = clampToWorkArea({ ...size, ...candidate, areas: [area] })
    // 窗口底色跟系统深浅色一致，避免深色主题下开窗先闪一块白。
    chat = new BrowserWindow({ ...size, ...position, show: false, title: '小沐', autoHideMenuBar: true,
      // 不进任务栏：语音轮拿这个窗口当耳朵和嘴，它不该在下面留一个图标。
      skipTaskbar: true,
      backgroundColor: nativeTheme?.shouldUseDarkColors ? '#1b1c1f' : '#ffffff',
      alwaysOnTop: true, minWidth: 320, minHeight: 400,
      webPreferences: { preload: path.join(preloadDir, 'chat-preload.cjs'), partition: 'muche-desktop-chat', contextIsolation: true, nodeIntegration: false, sandbox: true } })
    const current = chat
    // 语音输入要麦克风：这个 partition 只服务聊天窗，所以显式只放行 media，别的一律拒。
    const session = current.webContents.session
    session.setPermissionRequestHandler?.((contents, permission, callback) => callback(permission === 'media' && contents === current.webContents))
    session.setPermissionCheckHandler?.((contents, permission) => permission === 'media' && contents === current.webContents)
    mark('window')
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    current.webContents.on('context-menu', event => event.preventDefault())
    current.webContents.on('will-navigate', (event, target) => {
      try { if (new URL(target).origin !== origin) event.preventDefault() } catch { event.preventDefault() }
    })
    current.on('closed', () => { if (chat === current) chat = null })
    exchangeCookie(current.webContents.session, url.href)
      .then(() => {
        mark('authenticated')
        if (current.isDestroyed()) return
        // 认证一过就把窗口交给用户，页面在同一个窗口里继续加载：点立绘的响应是开窗，不是等网页。
        // 语音轮不显示这个窗口（show=false），它只负责录音、发送和播放回复。
        if (show && showWindows) current.show()
        return current.loadURL(new URL('/api/muche/desktop-chat', origin).href)
      })
      .then(() => {
        mark('page')
        if (current.isDestroyed()) return
        onReady(current)
        onLoaded?.(current)
      })
      .catch(() => { onError(); if (!current.isDestroyed()) current.close() })
    return true
  }
  function closeFrom(sender) { if (chat && !chat.isDestroyed() && chat.webContents === sender) chat.close() }
  function dispose() { if (chat && !chat.isDestroyed()) chat.close(); chat = null }
  // 语音轮的指令通道：主进程（全局快捷键）→ 页面。
  function sendCommand(command) {
    if (!chat || chat.isDestroyed()) return false
    chat.webContents.send('muche:voice', command)
    return true
  }
  function owns(sender) { return Boolean(chat && !chat.isDestroyed() && chat.webContents === sender) }
  return { open, closeFrom, dispose, sendCommand, owns }
}

// One Set-Cookie header → the descriptor Electron's cookie store expects. Attributes are
// preserved (path/domain/secure/httpOnly/sameSite/expiry); unknown ones are ignored.
function parseSetCookie(header, origin) {
  const [pair, ...attributes] = String(header).split(';')
  const separator = pair.indexOf('=')
  if (separator <= 0) throw new Error('malformed Set-Cookie')
  const cookie = { url: origin, name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim(), path: '/', httpOnly: true, secure: origin.startsWith('https:') }
  for (const attribute of attributes) {
    const separatorIndex = attribute.indexOf('=')
    const flag = (separatorIndex < 0 ? attribute : attribute.slice(0, separatorIndex)).trim().toLowerCase()
    const value = separatorIndex < 0 ? '' : attribute.slice(separatorIndex + 1).trim()
    if (flag === 'path' && value) cookie.path = value
    else if (flag === 'domain' && value) cookie.domain = value
    else if (flag === 'secure') cookie.secure = true
    else if (flag === 'httponly') cookie.httpOnly = true
    else if (flag === 'samesite' && value) cookie.sameSite = value.toLowerCase()
    else if (flag === 'max-age' && Number(value) > 0) cookie.expirationDate = Date.now() / 1000 + Number(value)
  }
  return cookie
}
module.exports = { createChatWindowController, parseSetCookie }
