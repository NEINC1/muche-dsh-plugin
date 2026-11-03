import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecoder, encode } from '../desktop-helper/lib/protocol.cjs'

test('JSONL decoding handles split UTF-8 and concatenated frames', () => {
  const messages = [], errors = []
  const decoder = createDecoder({ onMessage: message => messages.push(message), onError: error => errors.push(error) })
  const bytes = Buffer.from(encode({ type: 'hello', text: '小沐' }) + encode({ type: 'ready' }))
  const split = bytes.indexOf(Buffer.from('小')) + 1
  decoder.write(bytes.subarray(0, split)); decoder.write(bytes.subarray(split))
  assert.deepEqual(messages, [{ type: 'hello', text: '小沐' }, { type: 'ready' }])
  assert.deepEqual(errors, [])
})
test('oversized and invalid lines are skipped without losing the next frame', () => {
  const messages = [], errors = []
  const decoder = createDecoder({ maxLineBytes: 20, onMessage: message => messages.push(message), onError: error => errors.push(error) })
  decoder.write('x'.repeat(22)); decoder.write('x\ninvalid\n{"type":"ready"}\n')
  assert.deepEqual(messages, [{ type: 'ready' }])
  assert.equal(errors.length, 2)
})
