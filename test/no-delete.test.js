/**
 * no-delete.test.js — 聊天数据不在插件本机落盘。
 *
 * 执行工作区允许建目录；桌面状态 Owner 仅保存显示偏好和位置，运行时 Owner
 * 仅建立和清理 Electron 缓存。新增持久化语义必须经过评审。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { out.push(...walk(p)); continue }
    if (p.endsWith('.js')) out.push(p)
  }
  return out
}

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))

test('lib 落盘仅允许桌面状态文件和执行区建目录', () => {
  const offenders = []
  const mkdirOutsideWorkspace = []
  for (const file of walk(LIB)) {
    const base = file.split(/[/\\]/).pop()
    const src = readFileSync(file, 'utf8')
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      // 裸 writeFile(/appendFile(/unlink(/rmdir(/rm(（字母前缀单词除外）即落盘语义。
      const desktopStateFile = file === join(LIB, 'desktop', 'state-file.js')
      const desktopRuntimeFile = file === join(LIB, 'desktop', 'runtime.js')
      if (/(^|[^A-Za-z_$])((?:writeFile|appendFile|unlink|rmdir|rm)(?:Sync)?\s*\()/.test(line)
          && !(desktopStateFile && /\bwriteFileSync\s*\(/.test(line))
          && !(desktopRuntimeFile && /\brm\s*\(staging,/.test(line))) {
        offenders.push(`${base}:${i + 1}: ${line.trim().slice(0, 80)}`)
      }
      // mkdir 只允许 workspace.js（执行工作区建目录，不存消息）。
      if (/(^|[^A-Za-z_$])(mkdir(?:Sync)?\s*\()/.test(line) && base !== 'workspace.js'
          && !(desktopStateFile && /\bmkdirSync\s*\(/.test(line))
          && !(desktopRuntimeFile && /\bmkdir\s*\(parent,/.test(line))) {
        mkdirOutsideWorkspace.push(`${base}:${i + 1}: ${line.trim().slice(0, 80)}`)
      }
    })
  }
  assert.equal(offenders.length, 0, `新增落盘语义须先过方案评审：${offenders.join(' | ')}`)
  assert.equal(mkdirOutsideWorkspace.length, 0, `建目录只能在 workspace.js（执行区）：${mkdirOutsideWorkspace.join(' | ')}`)
  assert.ok(walk(LIB).includes(join(LIB, 'desktop', 'state-file.js')))
})
