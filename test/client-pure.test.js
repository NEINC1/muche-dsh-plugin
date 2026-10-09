/**
 * client-pure.test.js — panel format helpers and the shared failure contract.
 *
 * Runtime/error semantics live in lib/errors.js and lib/runtime-contract.js so host and
 * browser consume one source. This file locks the pure helpers plus the invariants that used
 * to be enforced by the deleted parallel client stores (dedupe, quota independence, and
 * silent startup).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clipboardImageFiles, fmtTime, gapMinutes, localHM } from '../client/src/pure.js'
import { classifyFailure } from '../lib/errors.js'
import { isSameProblem, projectClientRuntime } from '../lib/runtime-contract.js'
import { createRuntimeState } from '../lib/runtime-state.js'

test('localHM 非法输入回空串', () => {
  assert.equal(localHM(''), '')
  assert.equal(localHM('not-a-date'), '')
  assert.match(localHM(new Date().toISOString()), /^\d{2}:\d{2}$/)
})

test('fmtTime 当日 HH:MM，非当日带月日', () => {
  assert.match(fmtTime(new Date().toISOString()), /^\d{2}:\d{2}$/)
  assert.ok(fmtTime('2020-01-02T03:04:05.000Z').includes('月'))
  assert.equal(fmtTime(''), '')
})

test('gapMinutes 非法回 null', () => {
  assert.equal(gapMinutes('', ''), null)
  assert.equal(gapMinutes('x', 'y'), null)
  assert.equal(gapMinutes('2020-01-01T00:00:00.000Z', '2020-01-01T01:00:00.000Z'), 60)
})

test('剪贴板图片优先取 items，缺少文件时回退 files', () => {
  const pasted = { type: 'image/png' }
  assert.deepEqual(clipboardImageFiles({
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => pasted },
    ],
    files: [pasted],
  }), [pasted])
  assert.deepEqual(clipboardImageFiles({
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
    files: [pasted],
  }), [pasted])
})

test('纯文本剪贴板不抽取图片', () => {
  assert.deepEqual(clipboardImageFiles({
    items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
    files: [],
  }), [])
})

test('配置类一律收敛成「请检查配置」，不点名字段、地址或网络判断', () => {
  for (const code of ['NEED_KEY', 'NEED_SETUP', 'NOT_API', 'TARGET', 'AUTH_FAILED']) {
    const failure = classifyFailure({ code })
    assert.equal(failure.kind, 'config', code)
    assert.equal(failure.text, '请检查配置', code)
    for (const leak of ['后端', '地址', 'API key', '/api', '过期']) {
      assert.ok(!failure.text.includes(leak), `${code} 泄露「${leak}」：${failure.text}`)
      assert.ok(!(failure.advice || '').includes(leak), `${code} 建议泄露「${leak}」`)
    }
  }
  assert.equal(classifyFailure({ kind: 'config', text: '后端地址必须以 /api 结尾' }).text, '请检查配置')
})

test('网络中断是重连提示，不是配置故障', () => {
  for (const code of ['NETWORK', 'TIMEOUT', 'UPSTREAM_HTML']) {
    const failure = classifyFailure({ code })
    assert.equal(failure.kind, 'connection', code)
    assert.equal(failure.text, '连接暂时中断，正在重连')
    assert.equal(failure.retryable, true)
  }
  // 孤立 TypeError/泛 Error 不是连接证据，不得据此循环重试或宣布离线。
  assert.equal(classifyFailure({ error: new TypeError('boom') }).code, 'HTTP_ERROR')
  assert.equal(classifyFailure({ error: { code: 'ECONNREFUSED' } }).kind, 'connection')
  assert.equal(classifyFailure({ error: new Error('x', { cause: { code: 'ETIMEDOUT' } }) }).kind, 'connection')
})

test('额度与限流相互独立，且都不等于离线', () => {
  const quota = classifyFailure({ code: 'message_quota_exhausted' })
  assert.equal(quota.kind, 'quota')
  assert.equal(classifyFailure({ status: 429 }).kind, 'operation', '普通 429 是限流，不是额度耗尽')
  assert.equal(classifyFailure({ status: 429 }).retryable, true)
  assert.equal(classifyFailure({ status: 422, code: 'INPUT_INVALID' }).kind, 'input')
})

test('输入与操作失败不因同属一处出口而互相吞掉', () => {
  assert.equal(classifyFailure({ kind: 'input', text: '最多发 3 张图' }).text, '最多发 3 张图')
  const bridge = classifyFailure({ kind: 'bridge', code: 'BRIDGE_STARTUP' })
  const input = classifyFailure({ kind: 'input', text: '最多发 3 张图' })
  assert.equal(isSameProblem(input, bridge), false, '桥接横幅不得隐藏无关的输入错误')
  assert.equal(isSameProblem(classifyFailure({ code: 'NETWORK' }), bridge), false)
  assert.equal(isSameProblem(classifyFailure({ code: 'NETWORK' }), classifyFailure({ code: 'NETWORK' })), true)
  assert.equal(isSameProblem(null, bridge), false)
})

test('桥接故障只讲本机 dsh，且 startup 与 offline 分开', () => {
  const startup = classifyFailure({ kind: 'bridge', code: 'BRIDGE_STARTUP' })
  const offline = classifyFailure({ kind: 'bridge', code: 'BRIDGE_OFFLINE' })
  assert.notEqual(startup.text, offline.text)
  for (const failure of [startup, offline]) {
    assert.equal(failure.kind, 'bridge')
    assert.ok(failure.text.includes('本机 dsh'))
    assert.ok(!failure.text.includes('/api'))
  }
})

test('投影：启动期是连接中，只有同步后的就绪才是在线', () => {
  const runtime = createRuntimeState({ configNs: 'muche', runtimeId: 'pure-test' })
  runtime.configure({ backendUrl: 'https://pure.test', apiKey: 'pure-key' })
  const fresh = projectClientRuntime(runtime.getSnapshot(), { status: 'connecting', synced: false })
  assert.equal(fresh.label, '连接中')
  const context = runtime.context()
  runtime.observeHttp(context, { ok: true }, { ticket: runtime.beginHttp() })
  runtime.setReceive(context, { status: 'open', ready: true })
  const ready = projectClientRuntime(runtime.getSnapshot(), { status: 'ready', synced: true })
  assert.equal(ready.label, '在线')
  // 宿主快照已在线但浏览器还没同步到同一身份：仍不得自称在线。
  assert.equal(projectClientRuntime(runtime.getSnapshot(), { status: 'connecting', synced: false }).label, '连接中')
  runtime.setReceive(context, { status: 'closed', code: 'NETWORK' })
  const dropped = projectClientRuntime(runtime.getSnapshot(), { status: 'ready', synced: true })
  assert.equal(dropped.label, '离线')
  assert.equal(dropped.problem.text, '连接暂时中断，正在重连')
})

test('无悬空引用：面板使用的 pure 导出必须已导入', async () => {
  const { readFileSync } = await import('node:fs')
  const entry = readFileSync(new URL('../client/src/entry.js', import.meta.url), 'utf8')
  const body = entry.slice(entry.indexOf('window.__ModuleLoader__'))
  const imported = new Set()
  for (const m of entry.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/(pure|api|runtime-store)\.js'/g)) {
    for (const n of m[1].split(',')) imported.add(n.trim())
  }
  for (const n of ['localHM', 'fmtTime', 'gapMinutes', 'clipboardImageFiles', 'apiGet', 'apiPost', 'createRuntimeClient']) {
    const uses = body.match(new RegExp(`(?<![A-Za-z0-9_$.])${n}(?![A-Za-z0-9_])`), 'g') || []
    if (uses.length > 0) assert.ok(imported.has(n), `悬空引用：${n}（渲染即 ReferenceError）`)
  }
})

test('旧并行机制不得复活（多真源是本轮返工的根因）', async () => {
  const { readFileSync } = await import('node:fs')
  const entry = readFileSync(new URL('../client/src/entry.js', import.meta.url), 'utf8')
  for (const dead of ['faultStore', 'presenceStore', 'wsStore', 'useWsOpen', 'visibleErrors', 'chatOnline', 'bridgeStatus', 'missingApiSuffix']) {
    assert.ok(!new RegExp(`(?<![A-Za-z0-9_$.])${dead}(?![A-Za-z0-9_])`).test(entry), `${dead} 已并入宿主运行状态，不应在客户端复活`)
  }
  assert.ok(entry.includes('createRuntimeClient'), '面板必须消费唯一运行状态镜像')
  assert.ok(entry.includes('reportFailure'), '所有失败上报只有一个出口')
})