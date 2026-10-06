/**
 * 面板纯函数（0.6.0 WP3a）：零 React、零 DOM（wsVia 读写 location 但缺席即回空，
 * node 下可测），esbuild 打进 client.js；node:test 直测本文件。
 *
 * missingApiSuffix 与 lib/backend.js 同规约（单规约双实现），双边一致性由
 * dsh/test/client-pure.test.js 同一套 fixture 锁死，漂移即红。
 */

// 额度恢复时刻的本地时分（面板侧唯一实现；同日 HH:MM，跨日由 quotaUntil
// 倒计时行覆盖，不另起格式化真源）
export function localHM(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// 聊天式时间：当日 HH:MM，非当日 M月D日 HH:MM
export function fmtTime(iso) {
  if (!iso) return ''
  try {
    if (typeof Date === 'undefined') return String(iso).slice(5, 16)
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso).slice(5, 16)
    const pad = (n) => (n < 10 ? '0' + n : String(n))
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
    const now = new Date()
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
  } catch (e) { return '' }
}

export function gapMinutes(a, b) {
  try {
    if (!a || !b || typeof Date === 'undefined') return null
    const va = new Date(a).getTime()
    const vb = new Date(b).getTime()
    if (Number.isNaN(va) || Number.isNaN(vb)) return null
    return (vb - va) / 60000
  } catch (e) { return null }
}

// 只取剪贴板图片文件；没有图片时由浏览器继续处理原生文本粘贴。
export function clipboardImageFiles(clipboard) {
  if (!clipboard) return []
  const fromItems = Array.from(clipboard.items || [])
    .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean)
  if (fromItems.length > 0) return fromItems
  return Array.from(clipboard.files || [])
    .filter((file) => String(file.type || '').startsWith('image/'))
}

// 探针回包翻人话（只读 stage/backend，不碰 token——回包本来就没有）。
export function summarizeDiag(res) {
  if (!res || typeof res !== 'object') return null
  const b = (res && res.backend) || {}
  const where = [b.host || '', b.pathPrefix && b.pathPrefix !== '(根)' ? b.pathPrefix : ''].join('')
  if (res.ok && res.stage === 'backend-reached') {
    return '本机到后端通（后端应答' + (res.status || '?') + '），查浏览器到本机'
  }
  if (res.stage === 'target') return '后端地址配错（' + (where || '空') + '）：' + (res.error || '')
  if (res.stage) return '本机到后端不通（' + res.stage + '）：' + (res.error || '')
  return '探针异常：' + (res.error || '未知')
}

// 面板所在页的源（只取协议+主机，不含路径与参数）：下行统一走 SSE，
// 连不上时把“经什么地址连的”摆出来——主机名写法与协议是浏览器到本机
// 这一跳的唯一定位。
export function wsVia() {
  try {
    if (typeof location === 'undefined' || !location.host) return ''
    return location.protocol + '//' + location.host
  } catch (e) { return '' }
}

export function wsViaSuffix() {
  const via = wsVia()
  return via ? '（经' + via + '）' : ''
}

// 地址形态即时判定（全员远端唯一口径）：path 为空或非 /api 结尾即判缺 /api。
// 空串回 false（空框不警告，由保存时 NEED_SETUP 收口）；非法 URL 回 false
//（由保存时 TARGET 收口，此处不抢报错）。与 lib/backend.js 同规约。
export function missingApiSuffix(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  let u
  try {
    u = new URL(raw)
  } catch (e) { return false }
  const p = String(u.pathname || '').replace(/\/+$/, '')
  if (p === '' || p === '/') return true
  return !/(^|\/)api$/.test(p)
}
