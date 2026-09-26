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

test('userDirName 空串直接抛（禁 anonymous 回落）', () => {
  assert.throws(() => userDirName(''), /身份未解析/)
  assert.throws(() => userDirName(null), /身份未解析/)
})

test('迁移：旧根行按 id 合并＋state 取大＋落痕＋幂等', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const { migrateUserArchive, ARCHIVE_MARKER, MIGRATED_FROM } = await import('../lib/local-store.js')
  const base = await makeDir()
  try {
    const hash = userDirName('mig-u')
    const oldDir = path.join(base, 'old', hash)
    const newRoot = path.join(base, 'new')
    await mkdir(oldDir, { recursive: true })
    await writeFile(path.join(oldDir, 'messages.jsonl'), '{"id":"a"}\n{"id":"b"}\n')
    await writeFile(path.join(oldDir, 'state.json'), JSON.stringify({ before: 'x', generation: 3 }))
    const first = await migrateUserArchive({ oldRoot: path.join(base, 'old'), newRoot, userHash: hash })
    assert.equal(first.moved, 2)
    assert.equal(first.already, false)
    const rows = await readLocalRows(path.join(newRoot, hash))
    assert.deepEqual(rows.map((r) => r.id).sort(), ['a', 'b'])
    assert.equal((await readLocalState(path.join(newRoot, hash))).generation, 3)
    assert.equal(existsSync(path.join(newRoot, ARCHIVE_MARKER)), true)
    assert.equal(existsSync(path.join(oldDir, MIGRATED_FROM)), true)
    // 旧抽屉原样保留（只留痕不删数据）。
    assert.equal(existsSync(path.join(oldDir, 'messages.jsonl')), true)
    const second = await migrateUserArchive({ oldRoot: path.join(base, 'old'), newRoot, userHash: hash })
    assert.equal(second.already, true)
    assert.equal(second.moved, 0)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('迁移：新根 state 更大则保留新根', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { migrateUserArchive } = await import('../lib/local-store.js')
  const base = await makeDir()
  try {
    const hash = userDirName('mig-v')
    const oldDir = path.join(base, 'old', hash)
    const newDir = path.join(base, 'new', hash)
    await mkdir(oldDir, { recursive: true })
    await mkdir(newDir, { recursive: true })
    await writeFile(path.join(oldDir, 'messages.jsonl'), '{"id":"o"}\n')
    await writeFile(path.join(oldDir, 'state.json'), JSON.stringify({ before: '', generation: 1 }))
    await writeFile(path.join(newDir, 'state.json'), JSON.stringify({ before: 'y', generation: 9 }))
    await migrateUserArchive({ oldRoot: path.join(base, 'old'), newRoot: path.join(base, 'new'), userHash: hash })
    const state = await readLocalState(newDir)
    assert.equal(state.generation, 9)
    assert.equal(state.before, 'y')
    const rows = await readLocalRows(newDir)
    assert.ok(rows.some((r) => r.id === 'o'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('迁移：旧根缺失即空过不抛；旧根==新根只写标记', async () => {
  const { migrateUserArchive, ARCHIVE_MARKER } = await import('../lib/local-store.js')
  const { existsSync } = await import('node:fs')
  const base = await makeDir()
  try {
    const r1 = await migrateUserArchive({ oldRoot: path.join(base, 'nope'), newRoot: path.join(base, 'n1'), userHash: userDirName('u') })
    assert.equal(r1.moved, 0)
    const same = path.join(base, 'same')
    const r2 = await migrateUserArchive({ oldRoot: same, newRoot: same, userHash: userDirName('u') })
    assert.equal(r2.moved, 0)
    assert.equal(existsSync(path.join(same, ARCHIVE_MARKER)), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
