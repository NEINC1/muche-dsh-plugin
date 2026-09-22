/**
 * 附图透传单测（node --test）：pickImages 只做数组形态归一，
 * 数量/大小/类型强校验在后端 vision（3 张/8M/四格式，整轮拒收）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickImages } from '../lib/routes.js'

test('无 images 字段 → undefined（纯文本原样）', () => {
  assert.equal(pickImages({}), undefined)
  assert.equal(pickImages({ text: 'hi' }), undefined)
  assert.equal(pickImages(null), undefined)
})

test('非数组 images → undefined（后端再判）', () => {
  assert.equal(pickImages({ images: 'x' }), undefined)
  assert.equal(pickImages({ images: 1 }), undefined)
})

test('数组透传并过滤空串', () => {
  assert.deepEqual(pickImages({ images: [] }), [])
  assert.deepEqual(pickImages({ images: ['a', '', 'b'] }), ['a', 'b'])
})
