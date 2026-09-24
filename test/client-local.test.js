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
