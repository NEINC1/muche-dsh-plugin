/**
 * dsh 本地消息存储（OI-070 WP3，Owner：dsh 插件）。
 *
 * 面板显示以本地文件为准，不以服务端记录为准。目录：
 * `<workspacePath>/messages/<userHash>/messages.jsonl`（append-only）＋
 * `state.json`（服务端游标、lifecycle 代际）。写入按服务端 `id` 去重；
 * `reset_mark` 行只存本地，不上服务端。
 *
 * 多用户即多子目录（按 userId 短哈希隔离，目录名不含明文身份）；
 * 文件只在用户本机，跟用户走不跟安装盘。
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'

import { resolveWorkspacePath } from './workspace.js'

export const MESSAGES_DIR = 'messages'
export const MESSAGES_FILE = 'messages.jsonl'
export const STATE_FILE = 'state.json'
export const RESET_MARK_KIND = 'reset_mark'

/** 用户子目录名：userId 短哈希（不含明文身份）。 */
export function userDirName(userId) {
  const id = typeof userId === 'string' && userId ? userId : 'anonymous'
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)
}

/** 本地消息目录（幂等建目录）。 */
export async function ensureUserMessageDir(ctx, userId) {
  const dir = path.join(resolveWorkspacePath(ctx), MESSAGES_DIR, userDirName(userId))
  await mkdir(dir, { recursive: true })
  return dir
}

function messagesPath(dir) {
  return path.join(dir, MESSAGES_FILE)
}

function statePath(dir) {
  return path.join(dir, STATE_FILE)
}

/** 读本地全部行（无文件即空数组；坏行跳过不炸整页）。 */
export async function readLocalRows(dir) {
  let text = ''
  try {
    text = await readFile(messagesPath(dir), 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row = JSON.parse(trimmed)
      if (row && typeof row === 'object') rows.push(row)
    } catch {
      // 坏行跳过（append-only 文件单行损坏不影响其余行）。
    }
  }
  return rows
}

/** 按服务端 id 去重 append（已存在即跳过，返回新增数）。 */
export async function appendLocalRows(dir, rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return 0
  const existing = await readLocalRows(dir)
  const seen = new Set(existing.map((r) => String(r.id || '')))
  const fresh = []
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const id = String(row.id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    fresh.push(row)
  }
  if (fresh.length === 0) return 0
  const payload = fresh.map((r) => JSON.stringify(r)).join('\n') + '\n'
  await appendFile(messagesPath(dir), payload, 'utf8')
  return fresh.length
}

/** 读本地 state（无文件即空对象）。 */
export async function readLocalState(dir) {
  try {
    const text = await readFile(statePath(dir), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 写本地 state（全量覆盖，只存游标与代际）。 */
export async function writeLocalState(dir, state) {
  const payload = {
    before: typeof state.before === 'string' ? state.before : '',
    generation: Number.isInteger(state.generation) ? state.generation : 0,
  }
  await writeFile(statePath(dir), JSON.stringify(payload), 'utf8')
  return payload
}

/** 本地时间线分页（按文件顺序倒取 limit 条再正序返回）。 */
export function pageLocalRows(rows, limit) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20))
  return rows.slice(-n)
}
