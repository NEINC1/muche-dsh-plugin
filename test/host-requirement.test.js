import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 市场同口径：解析三元组，忽略 prerelease（见 @dsh-market/core version.js）。 */
function triple(version) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim())
  assert.ok(m, `宿主版本解析失败：${version}`)
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

// Market exact ranges compare the version triple, tolerating prerelease suffixes.
function satisfiesDeclared(version) {
  return cmp(triple(version), triple(PKG.engines.dsh)) === 0
}

test('engines.dsh 显式声明宿主要求（market 阻断旧宿主的前置）', () => {
  const required = PKG.engines?.dsh
  assert.ok(typeof required === 'string' && required.trim(), '未声明 engines.dsh——旧宿主将按“未知”放行安装')
  assert.equal(required, '0.2.0-rc.2')
})

test('声明语义与市场判定同口径：已验证的 0.2.0 cohort 满足，其余不满足', () => {
  assert.equal(satisfiesDeclared('0.1.7-rc.2'), false, '旧 0.1.7 不具备当前原生提问契约')
  assert.equal(satisfiesDeclared('0.1.7'), false, '旧 0.1.7 不在支持范围')
  assert.equal(satisfiesDeclared('0.2.0-rc.2'), true, '当前官方桌面 0.2.0-rc.2 应判定满足')
  assert.equal(satisfiesDeclared('0.2.0'), true, '0.2.0 正式版应判定满足')
  assert.equal(satisfiesDeclared('0.1.5-rc.1'), false, '旧 cohort 0.1.5-rc.1 必须判不兼容（阻断安装）')
  assert.equal(satisfiesDeclared('0.1.5'), false, '旧 cohort 0.1.5 必须判不兼容（阻断安装）')
  assert.equal(satisfiesDeclared('0.3.0'), false, '未来大版本 0.3 必须判不兼容（到时随插件发新版）')
})

test('native services use the verified host cohort as peers', () => {
  for (const name of ['dsh-llm', 'dsh-tools']) {
    assert.equal(PKG.peerDependencies[`@deepseek-ai/${name}`], PKG.engines.dsh)
  }
})
