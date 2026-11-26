import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerRoutes } from '../lib/routes.js'
import { registerPanelEvents, createPanelEventsHub } from '../lib/panel-events.js'
import { createRuntimeState } from '../lib/runtime-state.js'

function modernHost() {
  const routes = new Map()
  const disposers = []
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  return {
    ctx: {
      webServer,
      effect(setup) {
        const dispose = setup()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      on: () => () => {},
    },
    routes,
    close() { for (const dispose of disposers.splice(0)) dispose() },
  }
}

function requestResult(handler) {
  const response = { status: 0, body: '', headers: {}, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers) }, end(body = '') { this.body += String(body) } }
  handler({ method: 'GET', url: '/api/muche/runtime', headers: {} }, response)
  return response
}

test('每条用户态 HTTP 路由由新版 WebServer 在 handler 前统一鉴权', (t) => {
  const host = modernHost()
  const runtime = createRuntimeState()
  t.after(() => { host.close(); runtime.dispose() })
  registerRoutes(host.ctx, {}, undefined, { runtime })

  assert.ok(host.routes.size > 0)
  for (const route of host.routes.values()) {
    assert.equal(route.auth, 'required', `${route.path} 必须明确声明 WebServer auth`)
  }
})

test('新版 HTTP 与 SSE handler 不依赖已移除的 connection/requestRejection 服务', (t) => {
  const host = modernHost()
  const runtime = createRuntimeState()
  const hub = createPanelEventsHub({ runtime })
  t.after(() => { host.close(); hub.dispose(); runtime.dispose() })
  registerRoutes(host.ctx, {}, undefined, { runtime })
  registerPanelEvents(host.ctx, {}, undefined, { runtime, hub })

  const runtimeResponse = requestResult(host.routes.get('/api/muche/runtime').handler)
  assert.equal(runtimeResponse.status, 200)
  assert.equal(JSON.parse(runtimeResponse.body).ok, true)

  const eventsRoute = host.routes.get('/api/muche/events')
  assert.equal(eventsRoute.auth, 'required')
  const response = new EventEmitter()
  Object.assign(response, {
    status: 0, headers: {}, written: [],
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers) },
    write(value) { this.written.push(String(value)); return true },
    end(value = '') { if (value) this.write(value); this.emit('close') },
  })
  assert.doesNotThrow(() => eventsRoute.handler({ method: 'GET' }, response))
  assert.equal(response.status, 200)
  assert.equal(response.headers['Content-Type'], 'text/event-stream')
})
