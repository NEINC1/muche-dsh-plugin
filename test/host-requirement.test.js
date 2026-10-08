/**
 * host-requirement.test.js — 宿主要求声明守卫。
 *
 * 锁两条（dsh-market 约定，见 @dsh-market/schema InstallInfo.dshEngines）：
 * ① package.json 必须经 `engines.dsh` 显式声明宿主要求——未声明时市场只能按
 *   “未知”放行，旧 cohort（0.1.5）宿主会装上 0.4.11+ 然后启动失败；
 *   显式声明不满足时市场阻断安装并提示升级。
 * ② 声明语义必须与市场 `satisfiesRange` 同口径（prerelease 宽容、只看三元组，
 *   caret 走 0.x 规则）：0.1.7 系与 0.2 系满足，0.1.5 系不满足。
 *
 * 2026-10-08：宿主升到 0.2.0-rc.2 后 0.7.1 因只声明 ^0.1.7 被市场拒绝安装
 * （rollback回 0.6.1）。本守卫随声明同步扩到 0.2 cohort，但保留对 0.1.5 的阻断。
 */
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

/** 市场同口径 caret（0.x 规则）：^0.1.7 → >=0.1.7 <0.2.0。 */
function satisfiesCaret0712(version) {
  const v = triple(version)
  if (cmp(v, [0, 1, 7]) < 0) return false
  return cmp(v, [0, 2, 0]) < 0
}

/** 市场同口径 caret（0.x 规则）：^0.2.0-rc.2 → >=0.2.0 <0.3.0。 */
function satisfiesCaret0200(version) {
  const v = triple(version)
  if (cmp(v, [0, 2, 0]) < 0) return false
  return cmp(v, [0, 3, 0]) < 0
}

/** `a || b` union：任一cohort 满足即满足。 */
function satisfiesDeclared(version) {
  return satisfiesCaret0712(version) || satisfiesCaret0200(version)
}

test('engines.dsh 显式声明宿主要求（market 阻断旧宿主的前置）', () => {
  const required = PKG.engines?.dsh
  assert.ok(typeof required === 'string' && required.trim(), '未声明 engines.dsh——旧宿主将按“未知”放行安装')
  assert.equal(required, '^0.1.7 || ^0.2.0-rc.2', `宿主要求漂移：${required}（须同时覆盖 0.1.7 与 0.2 两个官方 cohort）`)
})

test('声明语义与市场判定同口径：0.1.7/0.2 系满足，0.1.5 系不满足', () => {
  assert.equal(satisfiesDeclared('0.1.7-rc.2'), true, '官方桌面 0.1.7-rc.2 应判定满足')
  assert.equal(satisfiesDeclared('0.1.7'), true, '0.1.7 正式版应判定满足')
  assert.equal(satisfiesDeclared('0.2.0-rc.2'), true, '当前官方桌面 0.2.0-rc.2 应判定满足')
  assert.equal(satisfiesDeclared('0.2.0'), true, '0.2.0 正式版应判定满足')
  assert.equal(satisfiesDeclared('0.1.5-rc.1'), false, '旧 cohort 0.1.5-rc.1 必须判不兼容（阻断安装）')
  assert.equal(satisfiesDeclared('0.1.5'), false, '旧 cohort 0.1.5 必须判不兼容（阻断安装）')
  assert.equal(satisfiesDeclared('0.3.0'), false, '未来大版本 0.3 必须判不兼容（到时随插件发新版）')
})

test('peer 声明与 engines 同 cohort（dsh-llm 两条都放行，避免 market 二次拒绝）', () => {
  const peer = PKG.peerDependencies?.['@deepseek-ai/dsh-llm']
  assert.ok(typeof peer === 'string' && peer.trim(), '未声明 @deepseek-ai/dsh-llm peer——市场无法核对宿主')
  for (const v of ['0.1.7-rc.2', '0.2.0-rc.2']) {
    assert.ok(
      peer.split('||').map((s) => s.trim()).includes(v),
      `peer 未覆盖 ${v}：${peer}（宿主实际版本会被市场二次拒绝安装）`,
    )
  }
})
