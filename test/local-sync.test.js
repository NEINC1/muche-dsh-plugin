/**
 * 本地存储＋同步单测（OI-070 WP3，node --test）。
 *
 * 覆盖：本地 append 幂等（同 id 重拉不重复）、离线段翻页补齐、
 * 重置代际变大只插一条提醒且旧行保留、坏行跳过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  appendLocalRows,
  pageLocalRows,
  readLocalRows,
  readLocalState,
  userDirName,
  writeLocalState,
} from '../lib/local-store.js'
import { checkGeneration, syncOnce, toLocalRow } from '../lib/sync.js'

async function makeDir() {
  return mkdtemp(path.join(tmpdir(), 'muche-local-'))
}

test('userDirName 稳定且不含明文', () => {
  const a = userDirName('user-1')
  assert.equal(a, userDirName('user-1'))
  assert.notEqual(a, userDirName('user-2'))
  assert.ok(!a.includes('user-1'))
})

test('append 按 id 去重，重拉不重复', async (t) => {
  const dir = await makeDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const rows = [
    { id: 'a', role: 'user', content: 'hi', created_at: '2026-01-01T00:00:00Z' },
    { id: 'b', role: 'persona', content: '你好', created_at: '2026-01-01T00:01:00Z' },
  ]
  assert.equal(await appendLocalRows(dir, rows), 2)
  assert.equal(await appendLocalRows(dir, rows), 0)
  assert.equal((await readLocalRows(dir)).length, 2)
})

test('坏行跳过不炸整页', async (t) => {
  const dir = await makeDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { appendFile } = await import('node:fs/promises')
  const { default: pathMod } = await import('node:path')
  await appendFile(pathMod.join(dir, 'messages.jsonl'), '{"id":"ok"}\n{bad\n{"id":"ok2"}\n', 'utf8')
  const rows = await readLocalRows(dir)
  assert.deepEqual(rows.map((r) => r.id), ['ok', 'ok2'])
})

test('syncOnce 翻页补齐、命中已知即停', async (t) => {
  const dir = await makeDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await appendLocalRows(dir, [{ id: 'old-1', role: 'user', content: '旧' }])
  const pages = [
    { messages: [{ id: 'new-2', role: 'persona', content: '新2' }, { id: 'new-1', role: 'user', content: '新1' }], has_more: true, next_before: 'cur-1' },
    { messages: [{ id: 'old-1', role: 'user', content: '旧' }], has_more: false, next_before: '' },
  ]
  let calls = 0
  const fetchPage = async () => pages[Math.min(calls++, pages.length - 1)]
  const res = await syncOnce({ dir, fetchPage })
  assert.equal(res.added, 2)
  const ids = (await readLocalRows(dir)).map((r) => r.id)
  assert.ok(ids.includes('new-1') && ids.includes('new-2') && ids.includes('old-1'))
  assert.equal(ids.filter((x) => x === 'old-1').length, 1)
})

test('checkGeneration 变大只插一条提醒、旧行保留', async (t) => {
  const dir = await makeDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await appendLocalRows(dir, [{ id: 'm-1', role: 'user', content: '旧话' }])
  await writeLocalState(dir, { before: '', generation: 3 })
  const first = await checkGeneration({ dir, fetchGeneration: async () => 4 })
  assert.equal(first.reset, true)
  const second = await checkGeneration({ dir, fetchGeneration: async () => 4 })
  assert.equal(second.reset, false)
  const rows = await readLocalRows(dir)
  assert.equal(rows.filter((r) => r.kind === 'reset_mark').length, 1)
  assert.ok(rows.some((r) => r.id === 'm-1'))
  const state = await readLocalState(dir)
  assert.equal(state.generation, 4)
})

test('toLocalRow 缺 id 即 null、角色归一', () => {
  assert.equal(toLocalRow(null), null)
  assert.equal(toLocalRow({}), null)
  assert.equal(toLocalRow({ id: 'x', role: 'weird', content: 'c' }).role, 'persona')
  assert.equal(toLocalRow({ id: 'x', role: 'user', content: 'c' }).role, 'user')
})

test('pageLocalRows 倒取正序上限', () => {
  const rows = [{ id: '1' }, { id: '2' }, { id: '3' }]
  assert.deepEqual(pageLocalRows(rows, 2).map((r) => r.id), ['2', '3'])
})
