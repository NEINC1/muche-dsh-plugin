/**
 * 本机身份解析 Owner（OI-078）。
 *
 * 病根：local-history/sync 各自调 `/auth/me`＋组目录，算不出身份时回落
 * `anonymous` 还 `mkdir`——把"没找对"冒充成"没聊过"，面板分不清真空还是找错。
 * 治本：userId↔抽屉解析唯一入口；算不出即显式状态，不回落、不建目录。
 *
 * 真源：本模块（解析唯一入口）；`/auth/me` 的用户身份真源仍是后端，
 *   经 `fetchMe` 缝传入（生产传闭包，测试注 fake）。
 * 公开 interface：`resolveLocalIdentity(config, fetchMe, opts?)`、
 *   状态常量 `NEED_KEY/NEED_SETUP/AUTH_FAILED`、`anonymousDirName()`。
 * 状态与转换：unresolved → ok（建目录，仅此一处 mkdir）/ NEED_KEY（无 key，
 *   不碰网络）/ NEED_SETUP（无地址，不 fetch）/ AUTH_FAILED（401/403）；
 *   后端不可达等未知失败直接抛（调用方按 502 收口）。`mkdir:false` 给读路径
 *   （local-history）与 status 探针（只看不建：不建目录、不迁移、不清理，
 *   纯读零副作用）。均为显式幂等转换，无持久状态。
 * 策略归属：首次 ok 附带两件事——cutover 迁移（`migrateUserArchive`，见
 *   local-store，只搬本用户抽屉）与 anonymous 空壳精确清理（本模块，不枚举不碰其他抽屉）。
 * 消费者：local-history、sync、status 三路由（经本入口，不再各自组装）。
 * 失败降级：各状态映射固定 HTTP 码 + `code`（401 NEED_KEY / 400 NEED_SETUP /
 *   401 AUTH_FAILED＋重签指引），面板按 code 分支；抛错由调用方 502。
 * 租户/CAS/幂等：只读配置；单用户单抽屉；解析与清理均幂等。
 * 测试入口：dsh/test/local-identity.test.js。
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { readConfig } from './config.js'
import {
  archiveRoot,
  migrateUserArchive,
  userArchiveDir,
} from './local-store.js'
import { resolveWorkspacePath } from './workspace.js'

export const NEED_KEY = 'NEED_KEY'
export const NEED_SETUP = 'NEED_SETUP'
export const AUTH_FAILED = 'AUTH_FAILED'

/** 历史垃圾目录名：`sha256('anonymous')` 前 16 位（运行时计算，不硬编码）。 */
export function anonymousDirName() {
  return createHash('sha256').update('anonymous', 'utf8').digest('hex').slice(0, 16)
}

/** 精确清理单目录（存在即删，不存在即过；只碰给定名，不枚举）。 */
async function removeDirQuiet(dir) {
  const { rm } = await import('node:fs/promises')
  try {
    await rm(dir, { recursive: true, force: true })
  } catch { /* 删不掉不挡主流程，下次幂等重试 */ }
}

/**
 * 解析本机身份＋抽屉目录（唯一入口）。
 *
 * @param {object} config apply 收到的 Config 引用（现读）。
 * @param {() => Promise<{ok: boolean, status?: number, user_id?: string, error?: string}>} fetchMe
 *   `/auth/me` 注入缝（调用方闭包已带鉴权）。
 * @param {{ mkdir?: boolean, root?: string }} opts `mkdir:false` 只看不建
 *   （local-history 读路径与 status 探针用）；`root` 覆盖存档根（测试隔离用，生产不传）。
 * @returns {Promise<{ state: 'ok', dir: string } | { state: typeof NEED_KEY | typeof NEED_SETUP | typeof AUTH_FAILED }>}
 */
export async function resolveLocalIdentity(config, fetchMe, opts = {}) {
  const makeDir = opts.mkdir !== false
  const cfg = readConfig(config)
  if (!cfg.apiKey) return { state: NEED_KEY }
  if (!cfg.backendUrl) return { state: NEED_SETUP }
  const me = await fetchMe()
  if (!me || me.ok !== true) {
    const status = me && typeof me.status === 'number' ? me.status : 0
    if (status === 401 || status === 403) return { state: AUTH_FAILED }
    throw new Error((me && me.error) || '身份解析失败')
  }
  const userId = typeof me.user_id === 'string' ? me.user_id : ''
  if (!userId) throw new Error('身份解析失败：后端未返回用户')
  const root = typeof opts.root === 'string' && opts.root ? opts.root : archiveRoot()
  const dir = userArchiveDir(root, userId) // 空 userId 在此抛，不回落
  if (!makeDir) return { state: 'ok', dir }
  await mkdir(dir, { recursive: true })
  // 写路径附带两件事（读路径零副作用）：旧根该用户抽屉 cutover 迁移
  // （只搬本用户；迁移抛错不挡主流程，记 warn 无标记下次幂等重试）。
  const oldRoot = path.join(resolveWorkspacePath(undefined, config), 'messages')
  try {
    await migrateUserArchive({ oldRoot, newRoot: root, userHash: path.basename(dir) })
  } catch (error) {
    console.warn('muche local-identity: 存档迁移失败，下次重试: ' + String((error && error.message) || error).slice(0, 160))
  }
  // anonymous 空壳精确清理（新旧两根，只碰该名单目录）。
  await removeDirQuiet(path.join(root, anonymousDirName()))
  if (oldRoot !== root) await removeDirQuiet(path.join(oldRoot, anonymousDirName()))
  return { state: 'ok', dir }
}
