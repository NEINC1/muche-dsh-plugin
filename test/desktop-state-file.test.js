import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateFile } from '../lib/desktop/state-file.js'

test('desktop preference survives first display, movement and explicit hiding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'muche-state-'))
  try {
    const filePath = join(dir, 'desktop', 'state.json')
    const state = createStateFile({ filePath })
    assert.deepEqual(state.read(), { visible: false, x: null, y: null })
    assert.equal(state.write({ visible: true, x: null, y: null }), true)
    assert.equal(state.flush(), true)
    assert.deepEqual(state.read(), { visible: true, x: null, y: null })
    state.write({ visible: true, x: -123, y: 456 })
    state.write({ visible: false, x: -123, y: 456 })
    state.dispose()
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { version: 1, visible: false, x: -123, y: 456 })
    assert.equal(state.write({ visible: true, x: 0, y: 0 }), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('malformed preferences fall back and log once without changing the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'muche-state-'))
  try {
    const filePath = join(dir, 'state.json')
    writeFileSync(filePath, '{')
    let warnings = 0
    const state = createStateFile({ filePath, logger: { warn() { warnings++ } } })
    assert.deepEqual(state.read(), { visible: false, x: null, y: null })
    state.read()
    assert.equal(warnings, 1)
    assert.equal(readFileSync(filePath, 'utf8'), '{')
    assert.equal(state.write({ visible: true, x: 1, y: null }), false)
    state.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
