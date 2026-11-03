import { test } from 'node:test'
import assert from 'node:assert/strict'
import geometry from '../desktop-helper/lib/geometry.cjs'

test('desktop dimensions preserve image proportions and reject invalid values', () => {
  assert.deepEqual(geometry.windowSizeFor({ imageWidth: 300, imageHeight: 600, bodyHeight: 360, padding: 8 }), { width: 196, height: 376 })
  assert.throws(() => geometry.windowSizeFor({ imageWidth: 0, imageHeight: 600, bodyHeight: 360, padding: 8 }))
})
test('saved position stays on a work area, including negative-coordinate displays', () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: 0, width: 1280, height: 984 }]
  assert.deepEqual(geometry.clampToWorkArea({ x: -2000, y: 1200, width: 200, height: 400, areas }), { x: -1280, y: 584 })
  assert.deepEqual(geometry.clampToWorkArea({ x: 5, y: 8, width: 3000, height: 2000, areas }), { x: 0, y: 0 })
})
