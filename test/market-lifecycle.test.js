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

const INDEX_SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const BRIDGE_SRC = readFileSync(new URL('../lib/dsh-bridge.js', import.meta.url), 'utf8')
const CLIENT_SRC = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

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
  const m = CLIENT_SRC.match(/const loadHistory = React\.useCallback\(\(\) => \{([\s\S]*?)\n      \}, \[\]\)/)
  assert.ok(m, '未找到 loadHistory')
  assert.ok(/!res\.ok/.test(m[1]), 'loadHistory 未处理 !ok 分支——首装空 key 时面板仍静默空白')
  assert.ok(/setError\(res\.error\)/.test(m[1]), 'loadHistory 失败时未把后端指引钉出来')
})

test('配置走官方服务：自建 config 路由已删，status 暴露 configNs', async () => {
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
  let body = ''
  await handlers['/api/muche/status'](
    { method: 'GET', url: '/' },
    { writeHead: () => {}, end: (s) => { body = s } },
  )
  const res = JSON.parse(body)
  assert.equal(res.ok, true)
  assert.equal(res.configNs, 'muche', 'status 未暴露官方配置命名空间')
})
