/**
 * quota.js 单测（node --test）：额度提示助手（后端契约 code+reset_at）。
 * 覆盖：帧识别 / 同日与跨日恢复时刻格式化 / 非额度帧返回 null。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatResetAt, quotaExhausted, quotaHint } from '../lib/quota.js'

const NOW = new Date('2026-08-30T12:00:00+08:00').getTime()

test('quotaExhausted 只认额度帧', () => {
  assert.equal(quotaExhausted({ code: 'message_quota_exhausted', reset_at: 'x' }), true)
  assert.equal(quotaExhausted({ code: 'other' }), false)
  assert.equal(quotaExhausted(null), false)
})

test('formatResetAt 同日只显示时分', () => {
  const iso = new Date('2026-08-30T23:59:00+08:00').toISOString()
  assert.equal(formatResetAt(iso, NOW), '23:59')
})

test('formatResetAt 次日带"明天"，更远带日期', () => {
  const tomorrow = new Date('2026-08-31T08:05:00+08:00').toISOString()
  assert.equal(formatResetAt(tomorrow, NOW), '明天08:05')
  const later = new Date('2026-09-02T08:05:00+08:00').toISOString()
  assert.equal(formatResetAt(later, NOW), '9月2日08:05')
  assert.equal(formatResetAt('not-a-date', NOW), null)
})

test('quotaHint 拼装人话；非额度帧为 null', () => {
  const iso = new Date('2026-08-30T14:30:00+08:00').toISOString()
  assert.equal(quotaHint({ code: 'message_quota_exhausted', reset_at: iso }, NOW), '消息额度已用完，14:30 后恢复')
  assert.equal(quotaHint({ error: '其它错误' }, NOW), null)
})
