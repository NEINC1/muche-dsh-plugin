import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageReceiptQueue } from '../client/message-receipts.js'

function storage() {
  const data = new Map()
  return {
    get length() { return data.size },
    key(i) { return [...data.keys()][i] ?? null },
    setItem(key, value) { data.set(key, value) },
    removeItem(key) { data.delete(key) },
  }
}

function queue({ store, owner = 'alice', scope = 'server-a/alice', send, current = () => true }) {
  return createMessageReceiptQueue({
    scope, owner, storage: () => store, isCurrent: current, send,
    onError: () => {}, setTimer: () => 1, clearTimer: () => {},
  })
}

const response = (owner, accepted, unavailable = []) => ({
  receipt_owner: owner, accepted_message_ids: accepted, unavailable_message_ids: unavailable,
})

test('failed receipts survive restart and old messages do not need another history page', async () => {
  const store = storage()
  const first = queue({ store, send: async () => { throw new Error('offline') } })
  first.enqueue(['old-message', 'second-message', 'old-message'])
  await first.flush()
  first.dispose()
  const calls = []
  const next = queue({ store, send: async (ids, owner) => { calls.push([...ids]); return response(owner, ids) } })
  await next.flush()
  assert.deepEqual(calls, [['old-message', 'second-message']])
  assert.equal(store.length, 0)
  next.dispose()
})

test('a stale account response cannot clear another account queue', async () => {
  const store = storage()
  let current = true
  let release
  const first = queue({ store, current: () => current, send: () => new Promise(resolve => { release = resolve }) })
  first.enqueue(['alice-message'])
  const flight = first.flush()
  current = false
  release(response('alice', ['alice-message']))
  await flight
  first.dispose()
  const otherCalls = []
  const other = queue({ store, owner: 'bob', scope: 'server-a/bob', send: async ids => { otherCalls.push(ids); return response('bob', ids) } })
  await other.flush()
  assert.deepEqual(otherCalls, [])
  const resumed = queue({ store, send: async ids => response('alice', ids) })
  await resumed.flush()
  assert.equal(store.length, 0)
  other.dispose(); resumed.dispose()
})

test('partial or mismatched acknowledgements remain pending; unavailable is not a receipt', async () => {
  const store = storage()
  let next = response('alice', ['one'])
  const errors = []
  const q = createMessageReceiptQueue({
    scope: 'scope', owner: 'alice', storage: () => store, isCurrent: () => true,
    send: async () => next, onError: (...args) => errors.push(args),
    setTimer: () => 1, clearTimer: () => {},
  })
  q.enqueue(['one', 'two'])
  await q.flush()
  assert.equal(store.length, 2)
  next = response('bob', ['one', 'two'])
  await q.flush()
  assert.equal(store.length, 2)
  next = response('alice', ['one'], ['two'])
  await q.flush()
  assert.equal(store.length, 0)
  assert.ok(errors.some(args => args[0] === 'message receipt source unavailable'))
  q.dispose()
})

test('retries are bounded to 200 identities and arrivals during a request remain pending', async () => {
  const store = storage()
  let release
  const calls = []
  const q = queue({ store, send: async (ids, owner) => {
    calls.push([...ids])
    if (calls.length === 1) await new Promise(resolve => { release = resolve })
    return response(owner, ids)
  } })
  q.enqueue(Array.from({ length: 201 }, (_, i) => `id-${String(i).padStart(3, '0')}`))
  const flight = q.flush()
  q.enqueue(['arrived-during-send'])
  release()
  await flight
  assert.equal(calls[0].length, 200)
  assert.equal(store.length, 2)
  await q.flush()
  assert.deepEqual(calls[1], ['arrived-during-send', 'id-200'])
  assert.equal(store.length, 0)
  q.dispose()
})

test('without persistent storage receipts retry only inside this session', async () => {
  const calls = []
  const q = createMessageReceiptQueue({
    scope: 'scope', owner: 'alice', storage: () => { throw new Error('storage blocked') },
    isCurrent: () => true,
    send: async (ids, owner) => { calls.push([...ids]); return response(owner, ids) },
    onError: () => {}, setTimer: () => 1, clearTimer: () => {},
  })
  q.enqueue(['message-1'])
  await q.flush()
  assert.deepEqual(calls, [['message-1']])
  q.dispose()
})
