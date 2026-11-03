import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerRoutes } from '../lib/routes.js'
import { createRuntimeState } from '../lib/runtime-state.js'

function fixture({ rejection, desktop } = {}) {
  const entries = new Map(), cleanup = []
  const runtime = createRuntimeState()
  const ctx = { connection: { requestRejection: () => rejection }, webServer: { register: entry => { entries.set(entry.path, entry.handler); return () => entries.delete(entry.path) } }, effect: setup => cleanup.push(setup()) }
  registerRoutes(ctx, {}, undefined, { runtime, getDesktop: () => desktop })
  return { async request(method, body) {
    const bytes = body === undefined ? '' : JSON.stringify(body)
    const req = Readable.from(bytes ? [Buffer.from(bytes)] : [])
    req.method = method; req.url = '/api/muche/desktop'; req.headers = {}
    return await new Promise(resolve => {
      let status
      const res = { writeHead(code) { status = code }, end(value) { resolve({ status, body: JSON.parse(value) }) } }
      entries.get(req.url)(req, res)
    })
  }, close() { for (const dispose of cleanup) dispose(); runtime.dispose() } }
}

test('desktop route authenticates, validates and acknowledges accepted commands', async () => {
  const actions = []
  const f = fixture({ desktop: { show: () => actions.push('show'), hide: () => actions.push('hide'), retry: () => actions.push('retry') } })
  try {
    assert.equal((await f.request('GET')).status, 405)
    assert.equal((await f.request('POST', { action: 'bad' })).status, 400)
    for (const action of ['show', 'hide', 'retry']) {
      const response = await f.request('POST', { action })
      assert.equal(response.status, 202); assert.equal(response.body.accepted, true)
    }
    assert.deepEqual(actions, ['show', 'hide', 'retry'])
    assert.equal((await f.request('POST', { action: 'show', extra: 'x'.repeat(4096) })).status, 413)
  } finally { f.close() }
  const denied = fixture({ rejection: 403, desktop: { show: () => assert.fail('unauthorized command') } })
  try { assert.equal((await denied.request('POST', { action: 'show' })).status, 403) } finally { denied.close() }
  const unavailable = fixture()
  try { assert.equal((await unavailable.request('POST', { action: 'show' })).status, 503) } finally { unavailable.close() }
})
