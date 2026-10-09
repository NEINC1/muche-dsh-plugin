/**
 * market-lifecycle.test.js — 市场一键安装/卸载形态守卫。
 *
 * 锁四条：
 * ① 顶层 inject 只留面板生死线，反向桥接依赖走 ctx.get 可选——
 *    缺依赖的 profile 上整插件不进 waiting（重启即用的前提）。
 * ② 桥接缺依赖时停用不抛（面板照常）。
 * ③ 首装空 key 时面板开门即见指引（history 失败不再静默空白）。
 * ④ 配置走官方服务：自建 /api/muche/config 已删除，status 暴露 configNs
 *   （客户端凭它向 configForms 绑定）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { registerDshBridge, requestDshBridgeRefresh } from '../lib/dsh-bridge.js'
import { registerRoutes } from '../lib/routes.js'
import { createRuntimeState } from '../lib/runtime-state.js'
import { projectClientRuntime } from '../lib/runtime-contract.js'

const INDEX_SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const BRIDGE_SRC = readFileSync(new URL('../lib/dsh-bridge.js', import.meta.url), 'utf8')
const CLIENT_SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8').replace(/"/g, "'")
// WP4 过渡：产物改走 esbuild 打包，引号归一化。

test('顶层 inject 只留生死线（桥接依赖不在其中）', () => {
  const m = INDEX_SRC.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(m, '未找到顶层 inject 声明')
  const list = m[1]
  for (const core of ['settings', 'webServer', 'connection']) {
    assert.ok(list.includes(`'${core}'`), `顶层 inject 缺少生死线依赖 ${core}`)
  }
  for (const soft of ['workspaceRegistry', 'sessionQuery', 'sessionController', 'credentials']) {
    assert.ok(!list.includes(soft), `可选依赖 ${soft} 仍在顶层 inject——缺它的 profile 上整插件进 waiting`)
  }
})

test('执行链经 ctx.get 取桥接依赖（未 inject 不直取）', () => {
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
  const pairs = [
    ['dsh-call.js', readFileSync(new URL('../lib/dsh-call.js', import.meta.url), 'utf8')],
    ['dsh-bridge.js', BRIDGE_SRC],
    ['workspace.js', readFileSync(new URL('../lib/workspace.js', import.meta.url), 'utf8')],
  ]
  for (const [file, raw] of pairs) {
    const src = stripComments(raw)
    assert.ok(!/ctx\.sessionController/.test(src), `${file} 仍直取 ctx.sessionController`)
    assert.ok(!/ctx\.workspaceRegistry/.test(src), `${file} 仍直取 ctx.workspaceRegistry`)
    assert.ok(!/ctx\.sessionQuery/.test(src), `${file} 仍直取 ctx.sessionQuery`)
  }
})

test('桥接缺依赖时停用不抛（面板照常）', async () => {
  const fakeCtx = {
    get: () => undefined,
    on: () => () => {},
  }
  const config = { backendUrl: 'http://127.0.0.1:8000', apiKey: '', workspacePath: '' }
  assert.doesNotThrow(() => registerDshBridge(fakeCtx, config), '缺依赖的 profile 上 registerDshBridge 不应抛')
  await requestDshBridgeRefresh() // 停用后 refresh 为空操作，不应抛
})

test('首装空 key 时面板开门即见指引', () => {
  // 首装没有任何 key：runtime 已提交配置问题，面板开门必须显示它，而不是空白。
  // 指引来自宿主运行状态，不再由客户端自建 faultStore 复述。
  assert.ok(CLIENT_SRC.includes("reportFailure(res"), '历史失败未上报统一出口')
  assert.ok(!/faultStore\.setConfig/.test(CLIENT_SRC), '客户端不得再自建配置故障源')
  const runtime = createRuntimeState({ configNs: 'muche', runtimeId: 'market-test' })
  runtime.configure({ backendUrl: '', apiKey: '' })
  const projected = projectClientRuntime(runtime.getSnapshot(), { status: 'ready', synced: true })
  assert.equal(projected.problem.text, '请检查配置')
  assert.equal(projected.label, '离线', '配置不可用时不得显示在线')
})

test('配置走官方服务：自建 config 路由已删，health 暴露 configNs', async () => {
  const handlers = {}
  const config = { backendUrl: 'http://公网/api', apiKey: 'k', workspacePath: '' }
  const ctx = {
    get: (name) => (name === 'loader'
      ? { locate: () => 'muche', resolve: () => ({ options: { id: 'muche' } }) }
      : undefined),
    connection: { requestRejection: () => undefined },
    webServer: { register: ({ path, handler }) => { handlers[path] = handler } },
  }
  registerRoutes(ctx, config)
  assert.ok(!handlers['/api/muche/config'], '自建 /api/muche/config 未删（配置须走官方服务）')
  assert.ok(!handlers['/api/muche/status'], '旧 /api/muche/status 未删（configNs 已收口进 health）')
  let body = ''
  await handlers['/api/muche/health'](
    { method: 'GET', url: '/' },
    { writeHead: () => {}, end: (s) => { body = s } },
  )
  const res = JSON.parse(body)
  assert.equal(res.ok, true)
  assert.equal(res.configNs, 'muche', 'health 未暴露官方配置命名空间')
  assert.ok(res.auth && res.history && res.ws, 'health 缺三段结论')
})
