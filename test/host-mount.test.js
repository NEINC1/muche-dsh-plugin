import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function config(values) {
  return {
    backendUrl: values.backendUrl ?? '',
    apiKey: values.apiKey ?? '',
    workspacePath: '',
    bridgeId: values.bridgeId ?? 'bridge-test',
  }
}
function hostCtx({ configNs = 'muche', server } = {}) {
  // One web server per host process: two plugin fibers must collide on the same routes.
  const routes = server || new Map()
  const events = []
  const ctx = {
    fiber: 'fiber-' + Math.random().toString(16).slice(2, 8),
    connection: { requestRejection: () => undefined },
    webServer: {
      register(entry) {
        const key = `${entry.kind} ${entry.path}`
        // One server rejects a second registration of the same exact path, and a disposer
        // never unregisters a path it does not own.
        if (routes.has(key)) throw new Error(`duplicate exact route: ${key}`)
        routes.set(key, { handler: entry.handler, owner: ctx })
        return () => { const current = routes.get(key); if (current?.owner === ctx) routes.delete(key) }
      },
    },
    on(event, fn) {
      events.push([event, fn])
      return () => { const i = events.findIndex(([e, f]) => e === event && f === fn); if (i >= 0) events.splice(i, 1) }
    },
    effect(setup) {
      // Official contract: setup runs immediately for the fiber lifetime and whatever it
      // returns is released on dispose.
      const dispose = setup()
      if (typeof dispose === 'function') events.push(['dispose', dispose])
    },
    get(name) {
      if (name === 'loader') return { locate: () => configNs, resolve: () => ({ options: { id: configNs } }) }
      if (name === 'workspaceRegistry') return { list: async () => [] }
      if (name === 'sessionQuery') return { readTitle: () => '' }
      if (name === 'sessionController') return { create: async () => ({ id: 'session-1' }), prompt: async () => ({}) }
      if (name === 'settings' || name === 'connection' || name === 'webServer') return { update: async () => {} }
      return undefined
    },
  }
  ctx.routes = routes
  ctx.emit = (event, ...args) => { for (const [e, fn] of [...events]) if (e === event) fn(...args) }
  ctx.countListeners = (event) => events.filter(([e]) => e === event).length
  ctx.setConfig = (next) => ctx.emit('loader/volatile-update', next)
  return ctx
}
function invoke(ctx, path, { method = 'GET', body, headers = {} } = {}) {
  const entry = ctx.routes.get(`exact ${path}`)
  if (!entry) throw new Error(`route not registered: ${path}`)
  const handler = entry.handler
  const sent = { status: 200, headers: {}, body: '' }
  const res = {
    writeHead(status, extra) { sent.status = status; Object.assign(sent.headers, extra || {}); return res },
    end(chunk) { sent.body = chunk ? String(chunk) : ''; return res },
    on() { return res },
    write(chunk) { sent.body += String(chunk); return true },
  }
  const req = { method, url: path, headers: { host: '127.0.0.1:0', cookie: '', ...headers }, on(event, fn) { if (event === 'end') setImmediate(fn); return req } }
  handler(req, res)
  return new Promise((resolve) => setImmediate(() => resolve(JSON.parse(sent.body || '{}'))))
}

test('a duplicate mount leaves the primary fiber as the only owner of every route and connection', async () => {
  const server = new Map()
  const primary = hostCtx({ configNs: 'muche', server })
  apply(primary, config({ backendUrl: 'https://primary.test', apiKey: 'primary-key' }))
  assert.deepEqual([...primary.routes.keys()].sort(), [
    'exact /api/muche/chat', 'exact /api/muche/events', 'exact /api/muche/health',
    'exact /api/muche/history', 'exact /api/muche/image', 'exact /api/muche/runtime',
  ])
  const primarySnapshot = await invoke(primary, '/api/muche/runtime')
  assert.equal(primarySnapshot.ok, true)
  assert.equal(primarySnapshot.snapshot.configNs, 'muche')

  const secondary = hostCtx({ configNs: 'mkt-muche', server })
  apply(secondary, config({ backendUrl: 'https://secondary.test', apiKey: 'secondary-key' }))
  const owners = new Set([...server.values()].map((entry) => entry.owner))
  assert.deepEqual([...owners], [primary], 'the degraded fiber registers no route at all')
  assert.equal(secondary.countListeners('loader/volatile-update'), 0, 'the degraded fiber drives no config transition')
  const still = await invoke(primary, '/api/muche/runtime')
  assert.deepEqual(still.snapshot.configuration, primarySnapshot.snapshot.configuration)
  assert.equal(still.snapshot.configNs, 'muche', 'two fibers never contribute mixed config namespaces')
  primary.emit('dispose')
  secondary.emit('dispose')
})

test('degraded registration is atomic: a later duplicate cannot leave earlier routes of this fiber', () => {
  const ctx = hostCtx()
  // Pre-register one route of this plugin so the first registration already collides.
  ctx.webServer.register({ kind: 'exact', path: '/api/muche/chat', handler: () => {} })
  apply(ctx, config({ backendUrl: 'https://x.test', apiKey: 'k' }))
  assert.deepEqual([...ctx.routes.keys()], ['exact /api/muche/chat'], 'only the pre-existing foreign route remains')
  assert.equal(ctx.countListeners('loader/volatile-update'), 0)
})

test('dispose removes every route, subscription and connection owned by this fiber', async () => {
  const ctx = hostCtx()
  apply(ctx, config({ backendUrl: 'https://dispose.test', apiKey: 'k' }))
  assert.equal(ctx.routes.size, 6, 'every plugin route is registered by this fiber')
  assert.ok(ctx.countListeners('loader/volatile-update') >= 1)
  ctx.emit('dispose')
  assert.equal(ctx.routes.size, 0)
  assert.equal(ctx.countListeners('loader/volatile-update'), 0)
  await new Promise((resolve) => setTimeout(resolve, 20))
})