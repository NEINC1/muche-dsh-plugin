/** UI-only pure helpers. Runtime/error semantics live in the shared host/browser contract. */
export function localHM(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
export function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(5, 16)
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  const now = new Date()
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
}
export function gapMinutes(a, b) {
  if (!a || !b) return null
  const x = Date.parse(a), y = Date.parse(b)
  return Number.isFinite(x) && Number.isFinite(y) ? (y - x) / 60000 : null
}
export function chatReplyFailure(reply) {
  if (reply.superseded || reply.duplicate || reply.messages?.length) return null
  const status = reply.outcome_status
  if (status === 'failed') return reply.failure_notice_recorded ? null : '这轮回复没有完成'
  if (reply.waiting_for_decision || status === 'retry_wait' || status === 'natural_silence' || status === 'action_only') return null
  return reply.degraded ? '这轮回复暂时不可用' : null
}
// 顺序真源：同一次开口的多段共享 created_at，只有服务端 message_seq 能定义顺序。
// overlay/乐观行没有 seq 时回退时间戳；两者都缺失时返回 0，靠稳定排序保持原序。
export function compareChatRows(a, b) {
  const as = Number.isInteger(a?.seq) ? a.seq : null
  const bs = Number.isInteger(b?.seq) ? b.seq : null
  if (as !== null && bs !== null && as !== bs) return as - bs
  const ta = Date.parse(a?.ts || '')
  const tb = Date.parse(b?.ts || '')
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0
  return ta - tb
}
export function clipboardImageFiles(clipboard) {
  if (!clipboard) return []
  const fromItems = Array.from(clipboard.items || [])
    .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map((item) => item.getAsFile()).filter(Boolean)
  return fromItems.length ? fromItems : Array.from(clipboard.files || []).filter((file) => String(file.type || '').startsWith('image/'))
}
