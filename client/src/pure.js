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
export function clipboardImageFiles(clipboard) {
  if (!clipboard) return []
  const fromItems = Array.from(clipboard.items || [])
    .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map((item) => item.getAsFile()).filter(Boolean)
  return fromItems.length ? fromItems : Array.from(clipboard.files || []).filter((file) => String(file.type || '').startsWith('image/'))
}
