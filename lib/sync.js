/**
 * dsh 本地同步 Owner：纯拉模式。
 *
 * 服务端不记 dsh 水位、不推送；dsh 拿本地游标调现成 history 分页拉，
 * 按服务端 `id` 合并后落盘。代际变大且本地非空即 append 本地 `reset_mark`
 * 行（只存本地，不上服务端；空抽屉只更新代际不插行，保持寂静）。
 *
 * 分向语义（显示真源全序不变式）：
 * - 向新（syncOnce）：从最新页向旧追到本地高水位为止，各页在服务端内
 *   已升序，页间按旧→新拼回 chronological 后一次落盘（多页重装不再倒挂）。
 * - 向旧（syncOlder）：从本地最旧行游标（或 state.oldest_cursor）向旧取
 *   一页，前插合并，全序落盘。state 持久 oldest_cursor 与 has_more_older。
 *
 * 服务端 history 形状：`{ ok, messages: [{id, role, content, ...}], has_more,
 * next_before }`（经 `/api/muche/history` 代理，见 routes.js）。
 */
import {
  appendLocalRows,
  mergeRowsChronological,
  prependLocalRows,
  readLocalRows,
  readLocalState,
  RESET_MARK_KIND,
  writeLocalState,
} from './local-store.js'

/** 服务端 history 行 → 本地行（只取展示、幂等与游标所需字段）。 */
export function toLocalRow(item) {
  if (!item || typeof item !== 'object') return null
  const id = String(item.id || '')
  if (!id) return null
  const seq = Number(item.message_seq)
  return {
    id,
    delivery_id: typeof item.delivery_id === 'string' ? item.delivery_id : '',
    role: item.role === 'user' ? 'user' : 'persona',
    content: typeof item.content === 'string' ? item.content : '',
    created_at: typeof item.created_at === 'string' ? item.created_at : '',
    medium: typeof item.medium === 'string' ? item.medium : 'text',
    image_count: Number.isInteger(item.image_count) ? item.image_count : 0,
    message_seq: Number.isInteger(seq) && seq > 0 ? seq : 0,
  }
}

/** 本地行 → 服务端 before 游标（缺序号即不可构，返回 null）。 */
export function buildCursor(row) {
  if (!row || typeof row !== 'object') return null
  const ts = typeof row.created_at === 'string' ? row.created_at : ''
  const seq = Number(row.message_seq)
  const id = String(row.id || '')
  if (!ts || !Number.isInteger(seq) || seq < 1 || !id) return null
  return `${ts}|${seq}|${id}`
}

/**
 * 向新同步一次：从最新页向旧追，直到 has_more 为假或回到本地高水位。
 *
 * `fetchPage(before)` 由调用方注入（已带鉴权）：`(before: string) =>
 * Promise<{messages, has_more, next_before}>`。返回 `{ added, generation }`。
 */
export async function syncOnce({ dir, fetchPage, maxPages = 20 }) {
  const state = await readLocalState(dir)
  const prevRows = await readLocalRows(dir)
  const known = new Set(prevRows.map((r) => String(r.id || '')))
  let before = typeof state.before === 'string' ? state.before : ''
  let added = 0
  let pages = 0
  // 服务端 history 是“最近一页”，before 向旧翻；新话在首屏，故首轮
  // 不带 before 拉最近页，命中本地已知 id 即停（增量收敛）。
  // 各页内部已升序，页间按旧→新拼回后一次落盘（多页重装全序不变）。
  let firstPage = true
  const fetchedPages = []
  let lastPage = null
  for (;;) {
    if (pages >= maxPages) break
    pages += 1
    const page = await fetchPage(firstPage ? '' : before)
    firstPage = false
    lastPage = page
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
    fetchedPages.push(rows)
    const hasMore = Boolean(page && page.has_more)
    const next = typeof (page && page.next_before) === 'string' ? page.next_before : ''
    if (!hasMore || !next) break
    if (hitKnown) break // 已追到本地高水位，后面全是已知
    before = next
  }
  // 页间旧→新拼回：后取的页更旧，先落盘。
  const ordered = fetchedPages.reverse().flat()
  // 全序保险：服务端时间戳单调时按时间排（merge 内部处理无时间行）。
  const merged = mergeRowsChronological([], ordered)
  added = await appendLocalRows(dir, merged)
  // 游标存“已同步过的最旧 before”（下次从该点继续向旧翻）；首屏同步
  // 后 before 为空即代表已到头，下次仍从首屏开始（命中已知即停）。
  const nextState = { before, generation: state.generation || 0 }
  if (typeof state.oldest_cursor === 'string' || state.oldest_cursor === null) {
    nextState.oldest_cursor = state.oldest_cursor
  }
  if (typeof state.has_more_older === 'boolean') {
    nextState.has_more_older = state.has_more_older
  }
  if (lastPage && lastPage.has_more === false) {
    // 本次直达服务端开头：本地已含全量，向旧无更多。
    nextState.oldest_cursor = null
    nextState.has_more_older = false
  }
  await writeLocalState(dir, nextState)
  return { added, generation: state.generation || 0 }
}

/**
 * 向旧取一页：从本地最旧行游标向旧翻，前插合并。
 *
 * cursor 来源优先级：state.oldest_cursor（上次回填位）＞ 本地最旧行现算
 * ＞ 从最新步进定位（旧行缺序号的 legacy 一次性代价，有界）。返回
 * `{ added, exhausted }`（exhausted 即服务端已到头，下次不必再翻）。
 */
export async function syncOlder({ dir, fetchPage, maxPages = 50 }) {
  const state = await readLocalState(dir)
  if (state.has_more_older === false) return { added: 0, exhausted: true }
  const localRows = await readLocalRows(dir)
  let before = typeof state.oldest_cursor === 'string' ? state.oldest_cursor : ''
  if (!before && localRows.length > 0) {
    before = buildCursor(localRows[0]) || ''
  }
  if (!before && localRows.length > 0) {
    before = await locateOlderCursor({ fetchPage, oldestId: String(localRows[0].id || ''), maxPages })
  }
  if (!before) {
    // 本地空（首屏 syncOnce 会拉最新页，此处无事可做）。
    if (localRows.length === 0) return { added: 0, exhausted: false }
    await writeLocalState(dir, { before: state.before || '', generation: state.generation || 0, oldest_cursor: null, has_more_older: false })
    return { added: 0, exhausted: true }
  }
  const page = await fetchPage(before)
  const items = Array.isArray(page && page.messages) ? page.messages : []
  const rows = []
  for (const item of items) {
    const row = toLocalRow(item)
    if (row !== null) rows.push(row)
  }
  const added = await prependLocalRows(dir, rows)
  const hasMore = Boolean(page && page.has_more)
  const next = typeof (page && page.next_before) === 'string' ? page.next_before : ''
  await writeLocalState(dir, {
    before: state.before || '',
    generation: state.generation || 0,
    oldest_cursor: hasMore && next ? next : null,
    has_more_older: hasMore && Boolean(next),
  })
  return { added, exhausted: !(hasMore && next) }
}

/**
 * 步进定位：旧行缺序号时从最新页向旧走，直到含 oldestId 的页，
 * 返回再向旧一页的游标（找不到即 null，上限 maxPages 页）。
 */
export async function locateOlderCursor({ fetchPage, oldestId, maxPages = 50 }) {
  if (!oldestId) return null
  let before = ''
  let first = true
  for (let n = 0; n < maxPages; n += 1) {
    const page = await fetchPage(first ? '' : before)
    first = false
    const items = Array.isArray(page && page.messages) ? page.messages : []
    const hit = items.some((it) => it && String(it.id || '') === oldestId)
    const hasMore = Boolean(page && page.has_more)
    const next = typeof (page && page.next_before) === 'string' ? page.next_before : ''
    if (hit) return next || null
    if (!hasMore || !next) return null
    before = next
  }
  return null
}
/**
 * 代际检查：调代际口，变大且本地非空即 append 本地 reset_mark 行并更新
 * state；空抽屉只更新代际不插行（真空保持寂静）。返回 `{ reset, generation }`。
 */
export async function checkGeneration({ dir, fetchGeneration }) {
  const state = await readLocalState(dir)
  const prev = Number.isInteger(state.generation) ? state.generation : 0
  const next = await fetchGeneration()
  if (!Number.isInteger(next) || next <= prev) {
    return { reset: false, generation: prev }
  }
  const keepState = {
    before: state.before || '',
    generation: next,
  }
  if (typeof state.oldest_cursor === 'string' || state.oldest_cursor === null) {
    keepState.oldest_cursor = state.oldest_cursor
  }
  if (typeof state.has_more_older === 'boolean') {
    keepState.has_more_older = state.has_more_older
  }
  const rows = await readLocalRows(dir)
  if (rows.length === 0) {
    await writeLocalState(dir, keepState)
    return { reset: false, generation: next }
  }
  const mark = {
    id: `local-reset-${next}`,
    kind: RESET_MARK_KIND,
    role: 'system',
    content: '小沐已被重置，之前的话还留着，后面的话接着说。',
    created_at: new Date().toISOString(),
  }
  await appendLocalRows(dir, [mark])
  await writeLocalState(dir, keepState)
  return { reset: true, generation: next }
}
