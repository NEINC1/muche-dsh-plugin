/**
 * dsh 本地同步（OI-070 WP3，Owner：dsh 插件）。
 *
 * 纯拉模式：服务端不记 dsh 水位、不推送；dsh 拿本地游标调现成 history
 * 分页拉，按服务端 `id` 合并后 append。代际变大即 append 本地 `reset_mark`
 * 行（只存本地，不上服务端）。
 *
 * 服务端 history 形状：`{ ok, messages: [{id, role, content, ...}], has_more,
 * next_before }`（经 `/api/muche/history` 代理，见 routes.js）。
 */
import {
  appendLocalRows,
  ensureUserMessageDir,
  readLocalRows,
  readLocalState,
  RESET_MARK_KIND,
  writeLocalState,
} from './local-store.js'

/** 服务端 history 行 → 本地行（只取展示与幂等所需字段）。 */
export function toLocalRow(item) {
  if (!item || typeof item !== 'object') return null
  const id = String(item.id || '')
  if (!id) return null
  return {
    id,
    delivery_id: typeof item.delivery_id === 'string' ? item.delivery_id : '',
    role: item.role === 'user' ? 'user' : 'persona',
    content: typeof item.content === 'string' ? item.content : '',
    created_at: typeof item.created_at === 'string' ? item.created_at : '',
    medium: typeof item.medium === 'string' ? item.medium : 'text',
    image_count: Number.isInteger(item.image_count) ? item.image_count : 0,
  }
}

/**
 * 增量同步一次：从本地游标向新拉取，直到 has_more 为假或回到本地高水位。
 *
 * `fetchPage(before)` 由调用方注入（已带鉴权）：`(before: string) =>
 * Promise<{messages, has_more, next_before}>`。返回 `{ added, generation }`。
 */
export async function syncOnce({ dir, fetchPage, maxPages = 20 }) {
  const state = await readLocalState(dir)
  const known = new Set((await readLocalRows(dir)).map((r) => String(r.id || '')))
  let before = typeof state.before === 'string' ? state.before : ''
  let added = 0
  let pages = 0
  // 服务端 history 是“最近一页”，before 向旧翻；新话在首屏，故首轮
  // 不带 before 拉最近页，命中本地已知 id 即停（增量收敛）。
  let firstPage = true
  for (;;) {
    if (pages >= maxPages) break
    pages += 1
    const page = await fetchPage(firstPage ? '' : before)
    firstPage = false
    const items = Array.isArray(page && page.messages) ? page.messages : []
    const rows = []
    let hitKnown = false
    for (const item of items) {
      const row = toLocalRow(item)
      if (row === null) continue
      if (known.has(row.id)) {
        hitKnown = true
        continue
      }
      known.add(row.id)
      rows.push(row)
    }
    // 服务端页是倒序取后正序返，rows 保持页内顺序即可 append。
    added += await appendLocalRows(dir, rows)
    const hasMore = Boolean(page && page.has_more)
    const next = typeof (page && page.next_before) === 'string' ? page.next_before : ''
    if (!hasMore || !next) break
    if (hitKnown) break // 已追到本地高水位，后面全是已知
    before = next
  }
  // 游标存“已同步过的最旧 before”（下次从该点继续向旧翻）；首屏同步
  // 后 before 为空即代表已到头，下次仍从首屏开始（命中已知即停）。
  await writeLocalState(dir, { before, generation: state.generation || 0 })
  return { added, generation: state.generation || 0 }
}

/**
 * 代际检查：调代际口，变大即 append 本地 reset_mark 行并更新 state。
 * 返回 `{ reset: boolean, generation }`。
 */
export async function checkGeneration({ dir, fetchGeneration }) {
  const state = await readLocalState(dir)
  const prev = Number.isInteger(state.generation) ? state.generation : 0
  const next = await fetchGeneration()
  if (!Number.isInteger(next) || next <= prev) {
    return { reset: false, generation: prev }
  }
  const mark = {
    id: `local-reset-${next}`,
    kind: RESET_MARK_KIND,
    role: 'system',
    content: '小沐已被重置，之前的话还留着，后面的话接着说。',
    created_at: new Date().toISOString(),
  }
  await appendLocalRows(dir, [mark])
  await writeLocalState(dir, { before: state.before || '', generation: next })
  return { reset: true, generation: next }
}

/** 启动同步：建目录 → 代际检查 → 增量拉取（调用方注入 fetch）。 */
export async function startupSync(ctx, userId, { fetchPage, fetchGeneration }) {
  const dir = await ensureUserMessageDir(ctx, userId)
  const gen = await checkGeneration({ dir, fetchGeneration })
  const sync = await syncOnce({ dir, fetchPage })
  return { dir, reset: gen.reset, generation: gen.generation, added: sync.added }
}
