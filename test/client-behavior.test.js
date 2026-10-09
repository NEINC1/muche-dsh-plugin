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

test('实时下行只有一条同源 SSE 通道，上行恒走 HTTP', () => {
  assert.ok(BUNDLE.includes("createEventSource('/api/muche/events')"), 'SSE未走同源相对地址')
  assert.ok(BUNDLE.includes('subscribeFrames'), 'SSE帧未进监听总线')
  assert.ok(BUNDLE.includes('/api/muche/chat'), '上行未走HTTP聊天口')
  // 旧的多通道 Store 一旦复活就会出现两个「在线」真源。
  for (const dead of ['new WebSocket(', 'wsOpen', 'faultStore.subscribe']) {
    assert.ok(!BUNDLE.includes(dead), `旧下行通道残留：${dead}`)
  }
})

test('运行状态经唯一镜像消费，并保留配置命名空间用于绑定官方表单', () => {
  assert.ok(BUNDLE.includes('/api/muche/runtime'), '未读取完整运行状态快照')
  assert.ok(BUNDLE.includes('createRuntimeClient'), '未使用运行状态镜像')
  assert.ok(BUNDLE.includes('X-Muche-Runtime'), '请求未带运行身份栅栏')
  assert.ok(BUNDLE.includes('configNs'), '未消费配置命名空间')
})

test('不再预判地址形态（后端基址归项目定，插件无权规定 /api 后缀）', () => {
  // 原先强制 missingApiSuffix + 「地址少了 /api 后缀」红字，2026-10-08 移除：
  // 用户可能改用别的路径，插件硬判会长期误报。成不成立由「测试连接」说了算。
  assert.ok(!BUNDLE.includes('missingApiSuffix'), '地址形态判定不应回到客户端')
  for (const stale of ['地址少了 /api 后缀', '可能少了 /api 后缀', '/api 后缀必填']) {
    assert.ok(!BUNDLE.includes(stale), `残留形态提示：${stale}`)
  }
  assert.ok(BUNDLE.includes('vision_descriptions'), '未读vision描述')
  assert.ok(BUNDLE.includes('图片已过期'), '缺少过期图占位')
})

test('聊天输入框捕获剪贴板图片并复用图片选择预览链', () => {
  assert.ok(BUNDLE.includes('clipboardImageFiles'), '没有读取剪贴板图片')
  assert.ok(BUNDLE.includes('onPaste'), '聊天输入框没有粘贴处理器')
  assert.ok(BUNDLE.includes('pickFiles'), '粘贴图片没有复用既有校验与预览')
})

test('额度与换配置语义', () => {
  assert.ok(BUNDLE.includes('message_quota_exhausted'), '额度耗尽码缺失')
  assert.ok(BUNDLE.includes('quotaUntil'), '额度倒计时缺失')
  assert.ok(BUNDLE.includes('authFpRef'), '换key不清内存会串号')
})
