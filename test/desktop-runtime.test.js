import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronRuntime, detectHostSupport } from '../lib/desktop/runtime.js'

test('desktop host detection rejects browser and Linux without a display', () => {
  assert.equal(detectHostSupport({ versions: {}, env: {}, platform: 'win32' }).code, 'DESKTOP_HOST_ONLY')
  assert.equal(detectHostSupport({ versions: { electron: '1' }, env: {}, platform: 'win32', hasParentIpc: false }).code, 'DESKTOP_HOST_ONLY')
  assert.equal(detectHostSupport({ versions: { electron: '1' }, env: {}, platform: 'linux', hasParentIpc: true }).code, 'NO_DISPLAY')
  assert.equal(detectHostSupport({ versions: { electron: '1' }, env: { DISPLAY: ':1' }, platform: 'linux', hasParentIpc: true }).supported, true)
})
test('concurrent acquisition shares download and reuses the completed cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muche-runtime-'))
  let downloads = 0
  try {
    const runtime = createElectronRuntime({ dshHome: home, env: {}, platform: 'win32', config: { electronVersion: '1.2.3', mirror: 'https://example.test/' },
      downloadElectron: async () => { downloads++; return 'archive.zip' },
      extractZip: async (_zip, { dir }) => writeFile(join(dir, 'electron.exe'), 'test') })
    const [a, b] = await Promise.all([runtime.ensure(), runtime.ensure()])
    assert.equal(a.exePath, b.exePath)
    assert.equal(downloads, 1)
    assert.equal((await runtime.ensure()).source, 'cache')
    assert.equal(downloads, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})
