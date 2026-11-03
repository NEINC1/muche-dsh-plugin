import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('packaged desktop asset is the original animation with a valid compact crop', () => {
  const data = readFileSync(new URL('../desktop-helper/assets/dsh-pet-idle.webm', import.meta.url))
  const { videoWidth, videoHeight, crop } = JSON.parse(readFileSync(new URL('../desktop-helper/assets/dsh-pet-idle.json', import.meta.url), 'utf8'))
  assert.equal(data.readUInt32BE(0), 0x1a45dfa3)
  assert.ok(data.length > 100000)
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0)
  assert.ok(crop.x + crop.width <= videoWidth && crop.y + crop.height <= videoHeight)
})
