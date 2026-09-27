/**
 * client-behavior.test.js — 面板行为契约（0.6.0 WP4）。
 *
 * 替代已删的 client-local/client-ux/client-gating/ws-diag-client 四份正则锁。
 * 只锁行为语义（端点、帧名、字段、函数名存在性），不锁引号/缩进/变量名——
 * 产物走 esbuild 打包，格式归一化不得红。引号归一后断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/"/g, "'")

test('历史三口径：首屏50/增量20/游标before，广播才拉', () => {
  assert.ok(BUNDLE.includes('/api/muche/history?limit=50'), '首屏不是单页50')
  assert.ok(BUNDLE.includes('/api/muche/history?limit=20'), '增量不是20小批量')
  assert.ok(BUNDLE.includes('before='), '翻页未带before游标')
  assert.ok(BUNDLE.includes('dialogue_updated'), '跨端广播缺失')
  assert.ok(!BUNDLE.includes('local-history'), '本地口残留')
})

test('在途overlay合并渲染（认领退役齐全）', () => {
  for (const name of ['overlayRef', 'renderMerged', 'reconcileOverlay', 'overlayAdd', 'delivery_id']) {
    assert.ok(BUNDLE.includes(name), `缺少${name}`)
  }
})

test('翻页防抖与探底', () => {
  assert.ok(BUNDLE.includes('olderTimerRef'), '翻页无防抖')
  assert.ok(BUNDLE.includes('300'), '防抖不是300ms')
  assert.ok(BUNDLE.includes('setReachedStart'), '到底未探底')
})

test('实时下行走同源SSE，上行恒走HTTP', () => {
  assert.ok(BUNDLE.includes("new EventSource('/api/muche/events')"), 'SSE未走同源相对地址')
  assert.ok(BUNDLE.includes('this.listeners'), 'SSE帧未进监听总线')
  assert.ok(BUNDLE.includes('/api/muche/chat'), '上行未走HTTP聊天口')
})

test('健康统一口：用health，无旧三口残留', () => {
  assert.ok(BUNDLE.includes('/api/muche/health'), '未改调统一健康口')
  for (const old of ['/api/muche/status', '/api/muche/test', '/api/muche/ws-diag']) {
    assert.ok(!BUNDLE.includes(old), `旧口残留：${old}`)
  }
  assert.ok(BUNDLE.includes('configNs'), '启动未取配置命名空间')
})

test('地址形态即时提示与过期图占位', () => {
  assert.ok(BUNDLE.includes('missingApiSuffix'), '缺少地址形态判定')
  assert.ok(BUNDLE.includes('地址少了 /api 后缀'), '缺少缺后缀红字')
  assert.ok(BUNDLE.includes('vision_descriptions'), '未读vision描述')
  assert.ok(BUNDLE.includes('图片已过期'), '缺少过期图占位')
})

test('额度与换配置语义', () => {
  assert.ok(BUNDLE.includes('message_quota_exhausted'), '额度耗尽码缺失')
  assert.ok(BUNDLE.includes('quotaUntil'), '额度倒计时缺失')
  assert.ok(BUNDLE.includes('authFpRef'), '换key不清内存会串号')
})
