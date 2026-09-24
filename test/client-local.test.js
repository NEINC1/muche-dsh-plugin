// dsh/test/client-local.test.js — 面板本地口径守卫（OI-070 WP3 面板切换）
//
// 锁死三条：
//  ① 面板读本地（local-history），不同步服务端 history 整页替换；
//  ② 打开面板/跨端广播先触发同步再读本地；
//  ③ 本地 reset_mark 行居中系统提醒渲染。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('面板读本地口（local-history），不直读服务端 history 整页替换', () => {
  assert.ok(/\/api\/muche\/local-history/.test(BUNDLE), '未调用本地 history 口')
  // loadHistory / loadOlder 不得再调服务端 history 口
  const loadHistory = BUNDLE.match(/const loadHistory = [\s\S]*?\}, \[\]\)/)
  assert.ok(loadHistory, '未找到 loadHistory')
  assert.ok(!/\/api\/muche\/history/.test(loadHistory[0]), 'loadHistory 仍直调服务端 history')
  assert.ok(/loadOlder = \(\) => \{[\s\S]*?local-history/.test(BUNDLE), 'loadOlder 未走本地口')
})

test('打开面板与跨端广播先同步再读本地', () => {
  assert.ok(/\/api\/muche\/sync/.test(BUNDLE), '未触发同步口')
  assert.ok(/refreshFromLocal/.test(BUNDLE), '缺少先同步再读本地的收口函数')
  assert.ok(/triggerSync\(\)/.test(BUNDLE), '同步触发未被调用')
})

test('reset_mark 居中系统提醒渲染', () => {
  assert.ok(/m\.kind === 'reset_mark'/.test(BUNDLE), '未按 kind 分支渲染重置提醒')
  assert.ok(/小沐已被重置/.test(BUNDLE), '重置提醒无默认文案')
})

test('normalize 透传 kind 字段', () => {
  const m = BUNDLE.match(/const normalize = \(rows\) => \(rows \|\| \[\]\)\.map\(\(m\) => \(\{/g)
  assert.ok(m, '未找到 normalize')
  assert.ok(/kind: m\.kind/.test(BUNDLE), 'normalize 未透传 kind')
})

// OI-074：悬浮窗发消息后不显示——刷新必须等同步完成再读本地，
// 否则读到同步前快照，整页替换吞掉在途行（乐观用户行/reply 行）。
test('OI-074 刷新等同步完成再读本地', () => {
  const refresh = BUNDLE.match(/const refreshFromLocal = [\s\S]*?\}, \[triggerSync, loadHistory\]\)/)
  assert.ok(refresh, '未找到 refreshFromLocal')
  assert.ok(/triggerSync\(\)\.then/.test(refresh[0]), '读本地未等同步完成（fire-and-forget 会读到同步前快照）')
})

test('OI-074 同步失败不整页替换（保留在途行）', () => {
  const refresh = BUNDLE.match(/const refreshFromLocal = [\s\S]*?\}, \[triggerSync, loadHistory\]\)/)
  assert.ok(refresh, '未找到 refreshFromLocal')
  assert.ok(/if \(ok\)/.test(refresh[0]), '同步失败仍替换显示，在途行会被旧快照吞掉')
})

test('OI-074 同步串行排队（防并发写本地竞态）', () => {
  assert.ok(/syncChainRef/.test(BUNDLE), '缺少同步串行链，多次广播重叠会并发写本地')
})

test('OI-074 翻页同样等同步成功后再替换', () => {
  const older = BUNDLE.match(/const loadOlder = \(\) => \{[\s\S]*?\n      \}/)
  assert.ok(older, '未找到 loadOlder')
  assert.ok(/triggerSync\(\)\.then/.test(older[0]), '翻页未等同步完成就替换，同样会吞在途行')
})
