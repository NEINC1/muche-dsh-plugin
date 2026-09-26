/**
 * config-legacy.test.js — 旧 JSON 配置迁移回归。
 *
 * 根因：迁移路径用 `process.env.HOME` 拼接，该变量在 Windows 下一般是
 * undefined，拼出来是垃圾路径 → 迁移在 Windows 上永远命中不了
 * （外层 catch 吃掉，不影响正常使用，但旧 key 用户升级后要手工重填）。
 * 治本：与 workspace.js 同源，用 os.homedir()（跟用户走，不跟安装盘）。
 *
 * 官方适配后：迁移写入经官方 settings 服务（`writeConfig`→`settings.update`
 * 按条目 id），不再直写命名空间；读当前值走 `readConfig(config)`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLegacyConfig } from '../lib/config.js'

function emptyCtx(onUpdate) {
  return {
    settings: {
      update: async (ns, patch) => onUpdate(ns, patch),
    },
    get: () => undefined,
  }
}

const EMPTY_CONFIG = { backendUrl: '', apiKey: '', workspacePath: '' }

test('旧 JSON 迁移：DSH_HOME 下的文件被导入后删除（单一真源）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'muche-home-'))
  writeFileSync(join(home, 'muche-config.json'),
    JSON.stringify({ backendUrl: 'http://x/api', apiKey: 'muche_old' }))
  let updated = null
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await importLegacyConfig(emptyCtx((ns, patch) => { updated = { ns, patch } }), EMPTY_CONFIG)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
  assert.equal(updated.ns, 'muche')
  assert.equal(updated.patch.apiKey, 'muche_old')
  assert.equal(updated.patch.backendUrl, 'http://x/api')
  assert.throws(() => readFileSync(join(home, 'muche-config.json')), /ENOENT/)
  rmSync(home, { recursive: true, force: true })
})

test('已有 key 时直接返回，不碰文件系统', async () => {
  let touched = false
  const ctx = {
    settings: {
      update: async () => { touched = true },
    },
    get: () => undefined,
  }
  await importLegacyConfig(ctx, { backendUrl: 'http://x/api', apiKey: 'muche_live', workspacePath: '' })
  assert.equal(touched, false)
})

test('不再依赖 process.env.HOME（Windows 下为 undefined）', () => {
  const raw = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8')
  // 与 market-lifecycle.test.js 同口径：注释里的旧写法说明不计入。
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
  assert.ok(!/process\.env\.HOME/.test(src), '仍在用 process.env.HOME 拼家目录')
  assert.ok(/homedir\(\)/.test(src), '未改用 os.homedir()')
})
