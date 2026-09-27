/**
 * client-pure.test.js — 面板纯函数直测＋双边一致锁（0.6.0 WP3a）。
 *
 * 锁：client/src/pure.js 的 missingApiSuffix 与 lib/backend.js 同一套
 * fixture 输出一致（单规约双实现，漂移即红）；其余纯函数形状不断言 UI。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { missingApiSuffix as hostMissing } from '../lib/backend.js'
import {
  fmtTime,
  gapMinutes,
  localHM,
  missingApiSuffix,
  summarizeDiag,
  wsVia,
} from '../client/src/pure.js'

const FIXTURE = [
  '',
  '   ',
  'not a url',
  'https://h',
  'https://h/',
  'https://h/api',
  'https://h/api/',
  'https://h/wrong',
  'https://h/wrong/',
  'http://h/api',
]

test('双边一致：client 与 Host 同 fixture 同输出', () => {
  for (const url of FIXTURE) {
    assert.equal(
      missingApiSuffix(url),
      hostMissing(url),
      `漂移：${JSON.stringify(url)} client=${missingApiSuffix(url)} host=${hostMissing(url)}`,
    )
  }
})

test('形态判定新规约：根与错路径警告，/api 放行', () => {
  assert.equal(missingApiSuffix('https://h'), true)
  assert.equal(missingApiSuffix('https://h/wrong'), true)
  assert.equal(missingApiSuffix('https://h/api'), false)
  assert.equal(missingApiSuffix('https://h/api/'), false)
})

test('localHM 非法输入回空串', () => {
  assert.equal(localHM(''), '')
  assert.equal(localHM('not-a-date'), '')
  assert.match(localHM(new Date().toISOString()), /^\d{2}:\d{2}$/)
})

test('fmtTime 当日 HH:MM，非当日带月日', () => {
  assert.match(fmtTime(new Date().toISOString()), /^\d{2}:\d{2}$/)
  assert.ok(fmtTime('2020-01-02T03:04:05.000Z').includes('月'))
  assert.equal(fmtTime(''), '')
})

test('gapMinutes 非法回 null', () => {
  assert.equal(gapMinutes('', ''), null)
  assert.equal(gapMinutes('x', 'y'), null)
  assert.equal(gapMinutes('2020-01-01T00:00:00.000Z', '2020-01-01T01:00:00.000Z'), 60)
})

test('summarizeDiag 非对象回 null', () => {
  assert.equal(summarizeDiag(null), null)
  assert.equal(summarizeDiag('x'), null)
  assert.ok(summarizeDiag({ ok: true, stage: 'backend-reached', status: 403 }).includes('通'))
})

test('wsVia 无 location 回空串（node 下）', () => {
  assert.equal(wsVia(), '')
})

test('无悬空引用：entry 用到的 pure/api 导出必须已导入（0.6.1 wsVia 空白面板教训）', async () => {
  const { readFileSync } = await import('node:fs')
  const entry = readFileSync(new URL('../client/src/entry.js', import.meta.url), 'utf8')
  const body = entry.slice(entry.indexOf('window.__ModuleLoader__'))
  const imported = new Set()
  for (const m of entry.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/(pure|api)\.js'/g)) {
    for (const n of m[1].split(',')) imported.add(n.trim())
  }
  for (const n of ['localHM', 'fmtTime', 'gapMinutes', 'summarizeDiag', 'wsVia', 'wsViaSuffix', 'apiGet', 'apiPost', 'missingApiSuffix']) {
    const uses = body.match(new RegExp(`(?<![A-Za-z0-9_$.])${n}(?![A-Za-z0-9_])`, 'g')) || []
    if (uses.length > 0) assert.ok(imported.has(n), `悬空引用：${n} 用了 ${uses.length} 次但未导入（面板渲染即 ReferenceError 空白）`)
  }
})
