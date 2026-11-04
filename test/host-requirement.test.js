import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('engines.dsh 仅允许两个目标宿主版本', () => {
  const range = PKG.engines?.dsh
  assert.ok(range)
  for (const version of ['0.2.1-rc.5', '0.2.2-alpha.3']) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, version)
  }
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.4', '0.2.1', '0.2.2-alpha.1', '0.2.2-alpha.2', '0.2.2', '0.3.0']) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, version)
  }
})

test('native services use the verified host cohort as peers', () => {
  for (const name of ['dsh-llm', 'dsh-tools']) {
    assert.equal(PKG.peerDependencies[`@deepseek-ai/${name}`], PKG.engines.dsh)
  }
})
