/**
 * 消息额度提示助手（后端契约：错误帧/HTTP detail 带 code="message_quota_exhausted" + reset_at）。
 * 面板（client.js）与微信通道（bridge.js）共用，禁止各写一份文案逻辑。
 */

/** 该帧是否为额度用尽（WS error 帧或 fetchJson 展平后的结果对象）。 */
export function quotaExhausted(frame) {
  return !!(frame && frame.code === 'message_quota_exhausted')
}

/** reset_at（ISO）→ 本地人话时刻；同日 HH:MM，次日"明天HH:MM"，更远"M月D日HH:MM"。 */
export function formatResetAt(resetAt, now = Date.now()) {
  const t = Date.parse(resetAt)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  const n = new Date(now)
  const hm =
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  if (sameDay) return hm
  const tomorrow = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1)
  const nextDay =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()
  if (nextDay) return `明天${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日${hm}`
}

/** 额度错误帧 → 一句话提示；非额度错误返回 null（走既有错误文案）。 */
export function quotaHint(frame, now = Date.now()) {
  if (!quotaExhausted(frame)) return null
  const at = formatResetAt(frame.reset_at, now)
  return at ? `消息额度已用完，${at} 后恢复` : '消息额度已用完，请稍后再试'
}
