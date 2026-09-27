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
  isChronological,
  mergeRowsChronological,
  pageLocalRows,
  prependLocalRows,
  readLocalRows,
  readLocalState,
  userDirName,
  writeLocalState,
} from '../lib/local-store.js'
import { buildCursor, checkGeneration, locateOlderCursor, syncOlder, syncOnce, toLocalRow } from '../lib/sync.js'

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

test('多页重装全序：新页在前旧页在后不再倒挂', async (t) => {
  const dir = await makeDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const msg = (id, ts) => ({ id, role: 'user', content: id, created_at: ts, message_seq: 1 })
  const pages = [
    { messages: [msg('m95', '2026-03-05T00:00:00+08:00'), msg('m100', '2026-03-10T00:00:00+08:00')], has_more: true, next_before: 'c1' },
    { messages: [msg('m90', '2026-02-28T00:00:00+08:00'), msg('m91', '2026-03-01T00:00:00+08:00')], has_more: false, next_before: '' },
  ]
  let calls = 0
  const res = await syncOnce({ dir, fetchPage: async () => pages[Math.min(calls++, pages.length - 1)] })
  assert.equal(res.added, 4)
  const ids = (await readLocalRows(dir)).map((r) => r.id)
  assert.deepEqual(ids, ['m90', 'm91', 'm95', 'm100'])
  assert.equal(isChronological(await readLocalRows(dir)), true)
})

test('toLocalRow 透传 message_seq；buildCursor 缺序号即 null', () => {
  assert.equal(toLocalRow({ id: 'x', role: 'user', content: 'c' }).message_seq, 0)
  assert.equal(toLocalRow({ id: 'x', message_seq: 7 }).message_seq, 7)
  assert.equal(buildCursor({ id: 'a', created_at: '2026-01-01T00:00:00+08:00', message_seq: 3 }), '2026-01-01T00:00:00+08:00|3|a')
  assert.equal(buildCursor({ id: 'a', created_at: '', message_seq: 3 }), null)
  assert.equal(buildCursor({ id: 'a', created_at: '2026-01-01T00:00:00+08:00', message_seq: 0 }), null)
})

test('syncOlder 向旧取一页前插， exhausted 到头', async (t) => {
  const dir = await makeDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await appendLocalRows(dir, [
    { id: 'n2', role: 'user', content: 'n2', created_at: '2026-04-02T00:00:00+08:00', message_seq: 12 },
    { id: 'n3', role: 'user', content: 'n3', created_at: '2026-04-03T00:00:00+08:00', message_seq: 13 },
  ])
  const page = {
    messages: [{ id: 'n1', role: 'user', content: 'n1', created_at: '2026-04-01T00:00:00+08:00', message_seq: 11 }],
    has_more: false,
    next_before: '',
  }
  const out = await syncOlder({ dir, fetchPage: async (before) => {
    assert.ok(typeof before === 'string' && before.length > 0, '回填必须带本地最旧游标')
    return page
  } })
  assert.equal(out.added, 1)
  assert.equal(out.exhausted, true)
  assert.deepEqual((await readLocalRows(dir)).map((r) => r.id), ['n1', 'n2', 'n3'])
  const st = await readLocalState(dir)
  assert.equal(st.has_more_older, false)
})

test('syncOlder 有更多时存游标，下次续翻', async (t) => {
  const dir = await makeDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await appendLocalRows(dir, [
    { id: 'n9', role: 'user', content: 'n9', created_at: '2026-05-09T00:00:00+08:00', message_seq: 9 },
  ])
  const out = await syncOlder({ dir, fetchPage: async () => ({
    messages: [{ id: 'n8', role: 'user', content: 'n8', created_at: '2026-05-08T00:00:00+08:00', message_seq: 8 }],
    has_more: true,
    next_before: '2026-05-08T00:00:00+08:00|8|n8',
  }) })
  assert.equal(out.exhausted, false)
  assert.equal((await readLocalState(dir)).oldest_cursor, '2026-05-08T00:00:00+08:00|8|n8')
})

test('locateOlderCursor 步进到含旧行页再向旧一格', async () => {
  const pages = [
    { messages: [{ id: 'new' }], has_more: true, next_before: 'c-new' },
    { messages: [{ id: 'old' }], has_more: true, next_before: 'c-old' },
  ]
  let calls = 0
  const cur = await locateOlderCursor({ fetchPage: async () => pages[Math.min(calls++, 1)], oldestId: 'old' })
  assert.equal(cur, 'c-old')
  assert.equal(await locateOlderCursor({ fetchPage: async () => ({ messages: [], has_more: false, next_before: '' }), oldestId: 'ghost' }), null)
})

test('checkGeneration 空抽屉只更新代际不插行（真空寂静）', async (t) => {
  const dir = await makeDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeLocalState(dir, { before: '', generation: 3 })
  const out = await checkGeneration({ dir, fetchGeneration: async () => 4 })
  assert.equal(out.reset, false)
  assert.equal(out.generation, 4)
  assert.deepEqual(await readLocalRows(dir), [])
})

test('mergeRowsChronological 去重＋全序＋无时间保序', () => {
  assert.deepEqual(
    mergeRowsChronological([{ id: 'b' }, { id: 'a' }], [{ id: 'a' }, { id: 'c' }]).map((r) => r.id),
    ['b', 'a', 'c'],
  )
  assert.deepEqual(
    mergeRowsChronological(
      [{ id: '2', created_at: '2026-02-01T00:00:00+08:00' }],
      [{ id: '1', created_at: '2026-01-01T00:00:00+08:00' }],
    ).map((r) => r.id),
    ['1', '2'],
  )
  assert.equal(isChronological([{ id: 'x' }, { id: 'y', created_at: '2026-01-01T00:00:00+08:00' }]), true)
  assert.equal(isChronological([{ id: 'y', created_at: '2026-01-02T00:00:00+08:00' }, { id: 'x' }]), false)
})

test('prependLocalRows 去重前插', async (t) => {
  const dir = await makeDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await appendLocalRows(dir, [{ id: 'n', role: 'user', content: 'n', created_at: '2026-06-02T00:00:00+08:00' }])
  assert.equal(await prependLocalRows(dir, [{ id: 'o', role: 'user', content: 'o', created_at: '2026-06-01T00:00:00+08:00' }]), 1)
  assert.equal(await prependLocalRows(dir, [{ id: 'o', content: 'dup' }]), 0)
  assert.deepEqual((await readLocalRows(dir)).map((r) => r.id), ['o', 'n'])
})

test('迁移按用户：首用户标记不挡第二用户', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { migrateUserArchive } = await import('../lib/local-store.js')
  const base = await makeDir()
  try {
    const hashA = userDirName('per-u-a')
    const hashB = userDirName('per-u-b')
    const oldRoot = path.join(base, 'old')
    const newRoot = path.join(base, 'new')
    await mkdir(path.join(oldRoot, hashA), { recursive: true })
    await mkdir(path.join(oldRoot, hashB), { recursive: true })
    await writeFile(path.join(oldRoot, hashA, 'messages.jsonl'), '{"id":"ra"}\n')
    await writeFile(path.join(oldRoot, hashB, 'messages.jsonl'), '{"id":"rb"}\n')
    const first = await migrateUserArchive({ oldRoot, newRoot, userHash: hashA })
    assert.equal(first.moved, 1)
    assert.equal(first.already, false)
    const second = await migrateUserArchive({ oldRoot, newRoot, userHash: hashB })
    assert.equal(second.already, false)
    assert.equal(second.moved, 1)
    assert.ok((await readLocalRows(path.join(newRoot, hashB))).some((r) => r.id === 'rb'))
    const repeat = await migrateUserArchive({ oldRoot, newRoot, userHash: hashA })
    assert.equal(repeat.already, true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
