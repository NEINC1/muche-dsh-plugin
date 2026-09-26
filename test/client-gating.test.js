// dsh/test/client-gating.test.js — 客户端激活门控守卫（小沐面板缺失根因）
//
// 背景：小沐 bundle 的 `exports.inject = []` 且 `apply` 开头 `slots` 缺席即静默
// `return`，与官方声明式依赖机制背道而驰；DSH 0.1.5-rc.2 并发激活把该竞态暴露，
// 页面 DSH 能进、唯独缺小沐三处（入口/浮层/设置页）且零报错。
//
// 本测试锁死两层门控（缺一不可）：
//  ① bundle 到达门控：`package.json` 的 `dsh.client.inject` 含 renderer 包；
//  ② fiber 激活门控：bundle 的 `exports.inject` 含 `slots`，`apply` 禁静默返回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const BUNDLE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('package.json dsh.client.inject 声明 renderer 包（bundle 到达门控）', () => {
  const inject = PKG?.dsh?.client?.inject
  assert.ok(Array.isArray(inject), 'dsh.client.inject 必须是数组')
  assert.ok(
    inject.includes('@deepseek-ai/dsh-client-ui-renderer'),
    `dsh.client.inject 缺少 @deepseek-ai/dsh-client-ui-renderer，当前=${JSON.stringify(inject)}`,
  )
})

test('bundle exports.inject 声明 slots（fiber 激活门控）', () => {
  const m = BUNDLE.match(/exports\.inject\s*=\s*(\[[^\]]*\])/)
  assert.ok(m, 'bundle 未找到 exports.inject 声明')
  const decl = m[1]
  assert.ok(
    /['"]slots['"]/.test(decl),
    `exports.inject 缺少 'slots'，当前=${decl}`,
  )
})

test('bundle exports.inject 声明 configForms（官方配置镜像门控）', () => {
  const m = BUNDLE.match(/exports\.inject\s*=\s*(\[[^\]]*\])/)
  assert.ok(m, 'bundle 未找到 exports.inject 声明')
  const decl = m[1]
  assert.ok(
    /['"]configForms['"]/.test(decl),
    `exports.inject 缺少 'configForms'，当前=${decl}——配置须走官方服务`,
  )
})

test('bundle 配置走官方 scope，不调自建 config 路由', () => {
  assert.ok(/configForms\.get\(/.test(BUNDLE), '未见 configForms.get 绑定')
  assert.ok(/scope\.mutate\(/.test(BUNDLE), '保存未走 scope.mutate')
  assert.ok(
    !/\/api\/muche\/config/.test(BUNDLE),
    '仍在调自建 /api/muche/config——配置读写须走官方服务',
  )
})

test('bundle apply 禁 slots 缺席静默返回（失败须 loud）', () => {
  const m = BUNDLE.match(/function apply\(ctx\)\s*\{([\s\S]*?)\n    \}/)
  assert.ok(m, 'bundle 未找到 apply(ctx) 主体')
  const head = m[1].split('\n').slice(0, 8).join('\n')
  assert.ok(
    !/if\s*\(\s*slots\s*===\s*undefined\s*\)\s*return\b/.test(head),
    'apply 仍含 slots 缺席静默 return；须改为抛错（loud 失败进 Boot 页报错）',
  )
})
