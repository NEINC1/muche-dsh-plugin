/**
 * local-identity.test.js — 本机身份解析 Owner 守卫（OI-078）。
 *
 * 锁六条：
 * ① 无 key 即 NEED_KEY（不碰网络、不建目录）；
 * ② 有 key 无地址即 NEED_SETUP（不 fetch）；
 * ③ 401/403 即 AUTH_FAILED；其他失败抛错（调用方 502）；
 * ④ ok 建目录并返回；mkdir:false 只看不建（status 探针用）；
 * ⑤ 首次 ok 精确清理 anonymous 空壳（只碰该名单目录，他人抽屉不动）；
 * ⑥ cutover 迁移被触发（旧根行并入新根，见 local-sync.test.js 迁移用例）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  AUTH_FAILED,
  NEED_KEY,
  NEED_SETUP,
  anonymousDirName,
  resolveLocalIdentity,
} from '../lib/local-identity.js'
import { readLocalRows } from '../lib/local-store.js'

async function makeRoot() {
  return mkdtemp(path.join(tmpdir(), 'muche-ident-'))
}

const KEY_CFG = { backendUrl: 'https://x/api', apiKey: 'muche_k', workspacePath: '' }
const okMe = (userId = 'user-1') => async () => ({ ok: true, user_id: userId })

test('无 key 即 NEED_KEY（不碰网络、不建目录）', async () => {
  const root = await makeRoot()
  try {
    let called = false
    const res = await resolveLocalIdentity(
      { backendUrl: 'https://x/api', apiKey: '', workspacePath: '' },
      async () => { called = true; return { ok: true, user_id: 'u' } },
      { root },
    )
    assert.equal(res.state, NEED_KEY)
    assert.equal(called, false)
    assert.equal(existsSync(root), true)
    const { readdirSync } = await import('node:fs')
    assert.equal(readdirSync(root).length, 0, 'NEED_KEY 时禁建任何目录')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('有 key 无地址即 NEED_SETUP', async () => {
  const root = await makeRoot()
  try {
    let called = false
    const res = await resolveLocalIdentity(
      { backendUrl: '', apiKey: 'muche_k', workspacePath: '' },
      async () => { called = true; return { ok: true, user_id: 'u' } },
      { root },
    )
    assert.equal(res.state, NEED_SETUP)
    assert.equal(called, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('401 即 AUTH_FAILED；网络抛错向上传（调用方 502）', async () => {
  const root = await makeRoot()
  try {
    const denied = await resolveLocalIdentity(KEY_CFG, async () => ({ ok: false, status: 401 }), { root })
    assert.equal(denied.state, AUTH_FAILED)
    const denied403 = await resolveLocalIdentity(KEY_CFG, async () => ({ ok: false, status: 403 }), { root })
    assert.equal(denied403.state, AUTH_FAILED)
    await assert.rejects(
      resolveLocalIdentity(KEY_CFG, async () => { throw new Error('socket hang up') }, { root }),
      /socket hang up/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ok 建目录并返回；mkdir:false 只看不建', async () => {
  const root = await makeRoot()
  try {
    const res = await resolveLocalIdentity(KEY_CFG, okMe('user-9'), { root })
    assert.equal(res.state, 'ok')
    assert.ok(res.dir.startsWith(root))
    assert.equal(existsSync(res.dir), true)
    const peek = await resolveLocalIdentity(KEY_CFG, okMe('user-9'), { root, mkdir: false })
    assert.equal(peek.state, 'ok')
    assert.equal(peek.dir, res.dir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('首次 ok 精确清理 anonymous 空壳，他人抽屉不动', async () => {
  const root = await makeRoot()
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const anonDir = path.join(root, anonymousDirName())
    await mkdir(anonDir, { recursive: true })
    await writeFile(path.join(anonDir, 'messages.jsonl'), '{"id":"ghost"}\n')
    const otherDir = path.join(root, 'otheruserhash1234')
    await mkdir(otherDir, { recursive: true })
    await writeFile(path.join(otherDir, 'messages.jsonl'), '{"id":"keep"}\n')
    await resolveLocalIdentity(KEY_CFG, okMe('user-1'), { root })
    assert.equal(existsSync(anonDir), false, 'anonymous 空壳必须删除')
    assert.equal(existsSync(path.join(otherDir, 'messages.jsonl')), true, '他人抽屉不得触碰')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cutover 迁移被触发（旧根行并入新根）', async () => {
  const oldWs = await makeRoot()
  const newRoot = await makeRoot()
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const cfg = { backendUrl: 'https://x/api', apiKey: 'muche_k', workspacePath: oldWs }
    // 旧根按老规则预置：<workspacePath>/messages/<hash>/（hash 由 userId 算，不硬编码）。
    const probe = await resolveLocalIdentity(cfg, okMe('mig-user'), { root: newRoot, mkdir: false })
    const hash = path.basename(probe.dir)
    const oldDir = path.join(oldWs, 'messages', hash)
    await mkdir(oldDir, { recursive: true })
    await writeFile(path.join(oldDir, 'messages.jsonl'), '{"id":"m1","role":"user","content":"hi"}\n')
    const res = await resolveLocalIdentity(cfg, okMe('mig-user'), { root: newRoot })
    assert.equal(res.state, 'ok')
    const rows = await readLocalRows(res.dir)
    assert.ok(rows.some((r) => r.id === 'm1'), '旧根行必须并入新根')
  } finally {
    await rm(oldWs, { recursive: true, force: true })
    await rm(newRoot, { recursive: true, force: true })
  }
})
