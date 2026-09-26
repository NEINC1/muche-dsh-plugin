/**
 * ws-diag-client.test.js — 面板失败自诊断守卫。
 *
 * 锁四条（排障口必须好用，不能退化回不透明错误）：
 * ① socket 建连失败三处（超时/非正常关闭/错误）都触发 runDiag；
 * ② 探针走同源相对地址 apiGet('/api/muche/ws-diag')（凭面板 Cookie 过门，
 *   不拼绝对地址、不带 token 参数）；
 * ③ 同配置只跑一次（diagKey 指纹，重连退避不重复打后端）；
 * ④ “未连接”文案后追加诊断结论（用户无需找日志）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('SSE 建连失败与中断都触发自诊断', () => {
  assert.equal(
    (CLIENT.match(/this\.runDiag\(\)/g) || []).length >= 2, true,
    'runDiag 调用不足 2 处（SSE 建连失败/彻底中断须全覆盖）',
  )
})

test('探针走同源相对地址，不带凭据', () => {
  const lines = CLIENT.split('\n').filter((l) => l.includes("apiGet('/api/muche/ws-diag')"))
  assert.ok(lines.length > 0, '探针未走同源 apiGet（相对地址凭 Cookie 过门，不拼 host、不带 token）')
  for (const line of lines) {
    assert.ok(!/token|apiKey/.test(line), `探针调用带凭据：${line.trim()}`)
  }
})

test('同配置探针只跑一次（diagKey 指纹）', () => {
  assert.ok(/diagKey\s*===\s*key/.test(CLIENT), '缺少同配置去重（重连退避会重复打后端）')
  assert.ok(/apiKey.*backendUrl|backendUrl.*apiKey/.test(CLIENT.match(/runDiag\(\)\s*\{[\s\S]*?\n      \}/)[0]), '指纹须含 key+地址')
})

test('“未连接”文案追加诊断结论', () => {
  assert.ok(/实时通道未连接.*diagSummary/s.test(CLIENT), '状态文案未追加 diagSummary')
  assert.ok(/summarizeDiag/.test(CLIENT), '缺少探针回包翻人话函数')
  for (const stage of ['backend-reached', 'target']) {
    assert.ok(CLIENT.includes(stage), `summarizeDiag 未处理 stage=${stage}`)
  }
})

test('“未连接”文案带面板所在源（只协议+主机，无路径参数）', () => {
  assert.ok(/wsViaSuffix\(\)/.test(CLIENT), '状态文案未附面板所在源')
  assert.ok(/location\.protocol.*location\.host|location\.host/.test(CLIENT), '源定位未读 location')
  assert.ok(!/location\.href|location\.search|location\.pathname/.test(CLIENT), '源定位带了路径/参数（泄漏页面细节）')
})

test('原生 WS 整条已删（OI-078 全面用新，无旧路分支）', () => {
  for (const relic of [/new WebSocket\(/, /useNativeWs\(\)/, /_wsUrl\(\)/, /_openSse\(\)/, /_teardownSse\(\)/, /this\.sock/, /pingTimer/, /openTimer/, /reconnectTimer/, /_scheduleReconnect/]) {
    assert.ok(!relic.test(CLIENT), `原生 WS 残留未删：${relic}`)
  }
})

test('SSE 下行走同源相对地址，进同一监听总线', () => {
  assert.ok(/new EventSource\('\/api\/muche\/events'\)/.test(CLIENT), 'SSE 未走同源相对地址')
  const sseBlock = CLIENT.match(/_open\(\)\s*\{[\s\S]*?\n      \},/)
  assert.ok(sseBlock, '未找到 _open')
  assert.ok(/for\s*\(const f of this\.listeners\)/.test(sseBlock[0]), 'SSE 帧未进同一监听总线')
})

test('上行恒走 HTTP（send 永 false，调用方降级）', () => {
  const sendBlock = CLIENT.match(/send\(obj\)\s*\{[\s\S]*?\n      \},/)
  assert.ok(sendBlock, '未找到 send')
  assert.ok(/return false/.test(sendBlock[0]), 'send 必须永 false（上行走 HTTP）')
  assert.ok(!/this\.sock/.test(sendBlock[0]), 'send 仍碰 socket')
})
