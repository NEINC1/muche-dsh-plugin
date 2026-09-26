/**
 * dsh 本地消息存档 Owner（OI-070 WP3 建，OI-078 收口）。
 *
 * 存档根固定独立：`<homedir>/muche-dsh-workspace/messages/`，跟用户走，
 * 跟安装盘/profile/执行工作区全无关（执行目录改路径不再丢档；与
 * workspace.js 的执行工作区解耦——改前者必丢后者是本次病根）。
 * 父目录名与执行工作区默认名相同只是巧合，归属不同、故意不复用
 * `DEFAULT_WORKSPACE_NAME`：改执行默认名时存档根纹丝不动，这正是解耦本身。
 *
 * 面板显示以本地文件为准，不以服务端记录为准。每用户一子目录（userId
 * 短哈希隔离，目录名不含明文身份）；文件只在用户本机。
 * 身份与目录解析唯一入口是 `local-identity.js`，本模块只做纯路径＋文件 io，
 * 不碰网络、不认身份（空 userId 在此抛，不回落 anonymous）。
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'

export const MESSAGES_DIR = 'messages'
export const MESSAGES_FILE = 'messages.jsonl'
export const STATE_FILE = 'state.json'
export const RESET_MARK_KIND = 'reset_mark'
export const ARCHIVE_MARKER = '.archive-v1'
export const MIGRATED_FROM = 'MIGRATED_FROM.json'

/** 存档根父目录名（固定，与执行工作区默认名解耦，见模块注释）。 */
const ARCHIVE_BASE_NAME = 'muche-dsh-workspace'

/** 存档根（固定独立，唯一真源；测试传显式 root，不调此函数）。 */
export function archiveRoot() {
  return path.join(homedir(), ARCHIVE_BASE_NAME, MESSAGES_DIR)
}

/** 用户子目录名：userId 短哈希（不含明文身份）；空 userId 直接抛。 */
export function userDirName(userId) {
  if (typeof userId !== 'string' || !userId) {
    throw new Error('userId 为空：身份未解析时禁组目录（OI-078，不回落 anonymous）')
  }
  return createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 16)
}

/** 用户抽屉目录（纯路径，无 io；空 userId 在 userDirName 抛）。 */
export function userArchiveDir(root, userId) {
  return path.join(root, userDirName(userId))
}

/** 建用户抽屉目录（幂等；调用方保证身份已解析）。 */
export async function ensureUserArchiveDir(root, userId) {
  const dir = userArchiveDir(root, userId)
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

/**
 * 单用户抽屉 cutover 迁移（OI-078 一次性；只搬指定 userHash，不过问他人）。
 *
 * 语义：旧根该用户抽屉的行按 `id` 合并进新根（复用 appendLocalRows 去重，
 * 不另写合并）；state 取 generation 大者（持平保新根）；旧抽屉原样保留＋
 * 落 `MIGRATED_FROM.json` 痕（不删用户数据，磁盘便宜）；新根落 `.archive-v1`
 * 幂等标记。旧根缺失/无该抽屉即零搬迁（不是失败）。旧根 == 新根仅写标记。
 * 真失败（读半截/写失败）抛错——调用方吞错记 warn 不写标记，下次幂等重试。
 *
 * @returns {Promise<{ moved: number, already: boolean }>}
 */
export async function migrateUserArchive({ oldRoot, newRoot, userHash }) {
  if (!oldRoot || !newRoot || !userHash) throw new Error('迁移缺参')
  await mkdir(newRoot, { recursive: true })
  const marker = path.join(newRoot, ARCHIVE_MARKER)
  try {
    await readFile(marker, 'utf8')
    return { moved: 0, already: true }
  } catch { /* 无标记继续 */ }
  if (oldRoot === newRoot) {
    await writeFile(marker, JSON.stringify({ at: new Date().toISOString(), from: oldRoot, noop: true }), 'utf8')
    return { moved: 0, already: false }
  }
  const oldDir = path.join(oldRoot, userHash)
  const newDir = path.join(newRoot, userHash)
  let moved = 0
  try {
    const oldRows = await readLocalRows(oldDir)
    if (oldRows.length > 0) {
      await mkdir(newDir, { recursive: true })
      moved = await appendLocalRows(newDir, oldRows)
    }
    const oldState = await readLocalState(oldDir)
    const newState = await readLocalState(newDir)
    const oldGen = Number.isInteger(oldState.generation) ? oldState.generation : 0
    const newGen = Number.isInteger(newState.generation) ? newState.generation : 0
    if (oldRows.length > 0 && oldGen >= newGen && (oldState.before || newGen === 0)) {
      await writeLocalState(newDir, { before: oldState.before || '', generation: oldGen })
    }
    await writeFile(
      path.join(oldDir, MIGRATED_FROM),
      JSON.stringify({ at: new Date().toISOString(), to: newDir, moved }),
      'utf8',
    ).catch(() => {})
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      await writeFile(marker, JSON.stringify({ at: new Date().toISOString(), from: oldRoot, empty: true }), 'utf8')
      return { moved: 0, already: false }
    }
    throw error
  }
  await writeFile(marker, JSON.stringify({ at: new Date().toISOString(), from: oldRoot, moved }), 'utf8')
  return { moved, already: false }
}
