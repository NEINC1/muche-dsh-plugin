import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { registerRoutes } from '../lib/routes.js'

const root = new URL('../../', import.meta.url)
const pythonLimits = readFileSync(new URL('src/infra/transport_limits.py', root), 'utf8')
const pythonVision = readFileSync(new URL('src/domains/conversation/vision.py', root), 'utf8')
const routesSource = readFileSync(new URL('dsh/lib/routes.js', root), 'utf8')
const apiSource = readFileSync(new URL('deploy/nginx.conf', root), 'utf8')
const clientSource = readFileSync(new URL('dsh/client/src/entry.js', root), 'utf8')
const pythonLimit = /CHAT_INGRESS_MAX_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(pythonLimits)
assert.ok(pythonLimit, 'shared transport limits must declare the chat budget in MiB')
const chatLimit = Number(pythonLimit[1]) * 1024 * 1024

class Request extends EventEmitter {
  constructor(path, headers = {}) {
    super()
    this.method = 'POST'
    this.url = path
    this.headers = { host: '127.0.0.1:0', cookie: '', ...headers }
    this.resumed = false
  }
  resume() { this.resumed = true; return this }
}

function setup() {
  const handlers = new Map()
  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler) } },
    effect: () => {},
    on: () => {},
    get: () => undefined,
  }
  registerRoutes(ctx, { backendUrl: '', apiKey: '', workspacePath: '' })
  return handlers
}

function response() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = String(body || '') },
  }
}

test('DSH and Nginx transport adapters match the shared chat ingress budget', () => {
  const dshLimit = /CHAT_REQUEST_BODY_MAX_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(routesSource)
  assert.ok(dshLimit)
  assert.equal(Number(dshLimit[1]) * 1024 * 1024, chatLimit)

  const exact = /location\s*=\s*\/api\/chat\s*\{([^}]+)\}/s.exec(apiSource)
  assert.ok(exact)
  const nginxLimit = /client_max_body_size\s+(\d+)m;/.exec(exact[1])
  assert.ok(nginxLimit)
  assert.equal(Number(nginxLimit[1]) * 1024 * 1024, chatLimit)
})

test('DSH image preflight mirrors Vision without becoming a second judge', () => {
  const imageCount = /VISION_MAX_IMAGES\s*=\s*(\d+)/.exec(pythonVision)
  const imageBytes = /VISION_MAX_BYTES\s*=\s*([\d* ]+)/.exec(pythonVision)
  const uiCount = /VISION_PREFLIGHT_MAX_IMAGES\s*=\s*(\d+)/.exec(clientSource)
  const uiBytes = /VISION_PREFLIGHT_MAX_BYTES\s*=\s*([\d* ]+)/.exec(clientSource)
  assert.ok(imageCount && imageBytes && uiCount && uiBytes)
  const evaluate = (expression) => expression.split('*').map((part) => Number(part.trim())).reduce((a, b) => a * b)
  assert.equal(Number(uiCount[1]), Number(imageCount[1]))
  assert.equal(evaluate(uiBytes[1]), evaluate(imageBytes[1]))
  assert.ok(clientSource.includes('pendingImages.length >= VISION_PREFLIGHT_MAX_IMAGES'))
  assert.ok(clientSource.includes('f.size > VISION_PREFLIGHT_MAX_BYTES'))
})

test('Content-Length over the chat budget returns 413 before reading or forwarding', async () => {
  const handlers = setup()
  const req = new Request('/api/muche/chat', { 'content-length': String(chatLimit + 1) })
  const res = response()
  await handlers.get('/api/muche/chat')(req, res)
  assert.equal(res.status, 413)
  assert.equal(req.resumed, true)
})

test('chunked chat body counts received bytes and rejects after the cap', async () => {
  const handlers = setup()
  const req = new Request('/api/muche/chat')
  const res = response()
  const pending = handlers.get('/api/muche/chat')(req, res)
  const chunk = Buffer.alloc(1024 * 1024)
  for (let index = 0; index <= Number(pythonLimit[1]); index += 1) req.emit('data', chunk)
  req.emit('end')
  await pending
  assert.equal(res.status, 413)
  assert.equal(req.resumed, true)
})

test('candidate health JSON has a separate bounded read', async () => {
  const handlers = setup()
  const req = new Request('/api/muche/health', { 'content-length': String(64 * 1024 + 1) })
  const res = response()
  await handlers.get('/api/muche/health')(req, res)
  assert.equal(res.status, 413)
})
