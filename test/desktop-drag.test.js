import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beginDrag, moveDrag } from '../desktop-helper/lib/drag.cjs'

test('drag moves by the screen DIP delta and never carries a window size', () => {
  const start = beginDrag({ x: -800, y: 80, width: 340, height: 376 }, { x: -700, y: 200 })
  assert.deepEqual(moveDrag(start, { x: -699, y: 201 }), { moved: false, x: -800, y: 80 })
  assert.deepEqual(moveDrag(start, { x: 400, y: 400 }), { moved: true, x: 300, y: 280 })
  assert.equal('bounds' in moveDrag(start, { x: 400, y: 400 }), false, 'size is the helper init geometry, not drag output')
})
