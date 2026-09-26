/**
 * config-official.test.js — 官方 0.1.7 配置契约守卫（2026-09-26 官方桌面端事故）。
 *
 * 根因：`ctx.settings.register/get` 在官方 0.1.7 已被删除，插件在 apply 第一步
 * 即抛，整个 entry 激活失败。治本：配置层整体迁到官方契约——模块导出带
 * `.volatile()` 的 Config；读自己的引用（`.get()`）；写经官方 settings 服务
 * 按 profile 条目 id；变更靠 `loader/volatile-update`。
 * 本文件锁死该契约的四个面（schema／读／寻址／写＋入口接线），只用最新的，
 * 不兼容旧 cohort（用户 2026-09-26 确认）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Config, DEFAULT_BACKEND, NS, configNamespace, readConfig, writeConfig } from '../lib/config.js'

const INDEX_SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const CONFIG_SRC = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8')

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

test('Config 三字段全 volatile（官方表单投影与写入的前置条件）', () => {
  for (const field of ['backendUrl', 'apiKey', 'workspacePath']) {
    const node = Config.dict[field]
    assert.ok(node, `Config 缺少字段 ${field}`)
    assert.equal(node.meta && node.meta.volatile, true, `字段 ${field} 未标 .volatile()——官方 settings.update 会拒写`)
  }
})

test('Config 直接调用返回引用（与官方 loader 同语义）', () => {
  const parsed = Config({ backendUrl: 'http://x/api', apiKey: 'k' })
  assert.equal(typeof parsed.backendUrl.get, 'function', 'backendUrl 不是引用')
  assert.equal(parsed.backendUrl.get(), 'http://x/api')
  assert.equal(parsed.apiKey.get(), 'k')
  // 有默认值的缺省字段，引用里是默认值（非 undefined）。
  assert.equal(parsed.workspacePath.get(), '')
})

test('readConfig：引用与普通值同读，缺省落默认值', () => {
  const ref = (v) => ({ get: () => v })
  assert.deepEqual(
    readConfig({ backendUrl: ref('http://x/api'), apiKey: ref('k'), workspacePath: ref('/w') }),
    { backendUrl: 'http://x/api', apiKey: 'k', workspacePath: '/w' },
  )
  assert.deepEqual(
    readConfig({ backendUrl: '', apiKey: '', workspacePath: '' }),
    { backendUrl: DEFAULT_BACKEND, apiKey: '', workspacePath: '' },
  )
  assert.deepEqual(
    readConfig(undefined),
    { backendUrl: DEFAULT_BACKEND, apiKey: '', workspacePath: '' },
  )
})

function ctxWithLoader({ located, optionsId } = {}) {
  return {
    fiber: { marker: 'self' },
    get: (name) => {
      if (name !== 'loader' || located === undefined) return undefined
      return {
        locate: () => located,
        resolve: (id) => (optionsId === undefined ? undefined : { options: { id: optionsId } }),
      }
    },
  }
}

test('configNamespace：无 loader 时兜底 insert id', () => {
  assert.equal(configNamespace({ get: () => undefined }), NS)
})

test('configNamespace：根条目取 options.id', () => {
  assert.equal(configNamespace(ctxWithLoader({ located: 'muche', optionsId: 'muche' })), 'muche')
})

test('configNamespace：嵌套 include 取 options.id 而非路径限定 id', () => {
  // settings 服务按 entry.options.id 寻址；loader.locate 给的是 include:muche。
  assert.equal(configNamespace(ctxWithLoader({ located: 'include:muche', optionsId: 'muche' })), 'muche')
})

test('configNamespace：市场安装 id 原样透传', () => {
  assert.equal(configNamespace(ctxWithLoader({ located: 'mkt-muche', optionsId: 'mkt-muche' })), 'mkt-muche')
})

test('writeConfig 经官方 settings.update 按条目 id 写', async () => {
  const calls = []
  const ctx = {
    ...ctxWithLoader({ located: 'muche', optionsId: 'muche' }),
    settings: { update: async (ns, patch) => { calls.push({ ns, patch }) } },
  }
  await writeConfig(ctx, { apiKey: 'k-new' })
  assert.deepEqual(calls, [{ ns: 'muche', patch: { apiKey: 'k-new' } }])
})

test('入口导出 Config（loader 读 runtime.Config 做 schema 源）', () => {
  assert.ok(/export\s*\{\s*Config\s*\}/.test(INDEX_SRC), 'index 未导出 Config')
})

test('入口 apply 收 config 并订阅官方变更事件刷桥', () => {
  assert.ok(/export function apply\(ctx,\s*config\)/.test(INDEX_SRC), 'apply 未收 config')
  assert.ok(/loader\/volatile-update/.test(INDEX_SRC), '未订阅 loader/volatile-update')
  const sub = INDEX_SRC.match(/ctx\.on\('loader\/volatile-update', \(\) => \{([\s\S]*?)\}\)/)
  assert.ok(sub, 'volatile-update 订阅体缺失')
  assert.ok(/requestDshBridgeRefresh/.test(sub[1]), '变更后未触发桥 refresh')
})

test('旧契约零残留：源码无 register/get/自建 config 路由', () => {
  for (const [file, raw] of [
    ['config.js', CONFIG_SRC],
    ['index.js', INDEX_SRC],
    ['routes.js', readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')],
    ['client.js', readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')],
  ]) {
    const src = stripComments(raw)
    assert.ok(!/settings\.register/.test(src), `${file} 仍调 settings.register`)
    assert.ok(!/settings\.get\(/.test(src), `${file} 仍调 settings.get(`)
    assert.ok(!/registerConfigNamespace/.test(src), `${file} 仍残留 registerConfigNamespace`)
  }
  const routes = stripComments(readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8'))
  assert.ok(!/['"]\/api\/muche\/config['"]/.test(routes), 'routes 仍注册 /api/muche/config')
})
