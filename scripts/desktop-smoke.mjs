import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createElectronRuntime } from '../lib/desktop/runtime.js'
const require = createRequire(import.meta.url)
const { createDecoder, encode } = require('../desktop-helper/lib/protocol.cjs')
const config = JSON.parse(await readFile(new URL('../lib/desktop/runtime.json', import.meta.url), 'utf8'))
const protocol = JSON.parse(await readFile(new URL('../lib/desktop/protocol.json', import.meta.url), 'utf8'))
const home = await mkdtemp(join(tmpdir(), 'muche-desktop-smoke-'))
const screenshot = join(home, 'screenshot.png')
const helperDir = fileURLToPath(new URL('../desktop-helper/', import.meta.url))
const runtime = createElectronRuntime({ dshHome: home, config, onProgress: text => console.log(text) })
const { exePath } = await runtime.ensure()
const env = { ...process.env, DSH_HOME: home, MUCHE_HELPER_SMOKE: '1', MUCHE_HELPER_SMOKE_OFFSCREEN: '1', MUCHE_HELPER_SMOKE_PNG: screenshot, MUCHE_HELPER_DRAG_SMOKE: '1', MUCHE_HOST_PID: String(process.pid), MUCHE_PIPE_FD: '3' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(exePath, [helperDir], { env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true })
const result = await new Promise((resolveResult, reject) => {
  let settled = false, shown = false, smoke = false, shownBounds = null, moved = null
  const timeout = setTimeout(() => finish(new Error('desktop helper smoke timed out')), 30000)
  function finish(error) {
    if (settled) return
    settled = true; clearTimeout(timeout)
    if (error) { child.kill(); reject(error) } else resolveResult()
  }
  const send = message => child.stdio[3].write(encode(message))
  const decoder = createDecoder({ maxLineBytes: protocol.maxLineBytes, onError: reason => finish(new Error(reason)), onMessage: msg => {
    console.log('helper:', msg.type)
    if (msg.type === 'hello') {
      if (msg.protocol !== protocol.protocol || msg.app !== protocol.app) return finish(new Error('protocol mismatch'))
      send({ type: 'init', protocol: protocol.protocol, window: { x: null, y: null, ...config.window }, assetPath: join(helperDir, 'assets', 'dsh-pet-idle.webm') })
    } else if (msg.type === 'ready') send({ type: 'show' })
    else if (msg.type === 'shown') {
      if (msg.bounds?.width <= 64 || msg.bounds?.height <= 64) return finish(new Error('invalid window dimensions'))
      shownBounds = msg.bounds
      shown = true
    } else if (msg.type === 'moved') {
      moved = msg
    } else if (msg.type === 'smoke') {
      if (msg.pngBytes < 5000 || !shown || !msg.animated) return finish(new Error('invalid screenshot or animation did not advance'))
      const drag = msg.drag
      if (!drag || drag.steps < 1 || drag.cycles < 2) return finish(new Error('drag smoke did not run'))
      const [first, ...rest] = drag.sizes
      for (const size of rest) {
        if (size.width !== first.width || size.height !== first.height) {
          return finish(new Error(`drag changed the window size ${first.width}x${first.height} -> ${size.width}x${size.height}`))
        }
      }
      if (shownBounds.width !== first.width || shownBounds.height !== first.height) {
        return finish(new Error(`displayed size ${shownBounds.width}x${shownBounds.height} differs from the drag size ${first.width}x${first.height}`))
      }
      if (!moved || (moved.x === shownBounds.x && moved.y === shownBounds.y)) return finish(new Error('drag did not move the window'))
      if (drag.click !== 'clicked') return finish(new Error(`a release without movement did not open chat (got ${drag.click})`))
      if (msg.voiceBadge !== true) return finish(new Error('the pet did not show the voice recording badge'))
      console.log(`drag smoke: ${first.width}x${first.height} kept across ${drag.cycles} drags while moving ${shownBounds.x},${shownBounds.y} -> ${moved.x},${moved.y}; click opens chat; voice badge visible`)
      smoke = true; send({ type: 'shutdown' })
    } else if (msg.type === 'error') finish(new Error(`${msg.code}: ${msg.text}`))
  } })
  child.stdout.on('data', chunk => decoder.write(chunk))
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  child.once('error', finish)
  child.once('exit', code => code === 0 && smoke ? finish() : finish(new Error(`helper exited ${code} before successful smoke`)))
})
if ((await stat(screenshot)).size < 5000) throw new Error('screenshot is missing')
console.log(`desktop smoke passed; screenshot: ${resolve(screenshot)}`)
