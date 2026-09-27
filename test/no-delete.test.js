/**
 * no-delete.test.js — 插件不在本机落任何用户文件（0.5.0 本地存档删除）。
 *
 * 锁：`dsh/lib` 禁止出现用户文件写入/删除原语（writeFile/appendFile/
 * unlink/rmdir/rm）。唯一例外是 workspace.js 的执行工作区建目录
 * （`mkdir(`，桥接任务 cwd，不存任何消息；存档/附件/游标一律禁落盘）。
 * 新持久化语义必须先过方案评审，不能悄悄加。用户旧存档只读不碰。
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
    if (statSync(p).isDirectory()) continue
    if (p.endsWith('.js')) out.push(p)
  }
  return out
}

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))

test('lib 无用户文件落盘语义（执行区建目录除外）', () => {
  const offenders = []
  const mkdirOutsideWorkspace = []
  for (const file of walk(LIB)) {
    const base = file.split(/[/\\]/).pop()
    const src = readFileSync(file, 'utf8')
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      // 裸 writeFile(/appendFile(/unlink(/rmdir(/rm(（字母前缀单词除外）即落盘语义。
      if (/(^|[^A-Za-z_$])((?:writeFile|appendFile|unlink|rmdir|rm)\s*\()/.test(line)) {
        offenders.push(`${base}:${i + 1}: ${line.trim().slice(0, 80)}`)
      }
      // mkdir 只允许 workspace.js（执行工作区建目录，不存消息）。
      if (/(^|[^A-Za-z_$])(mkdir\s*\()/.test(line) && base !== 'workspace.js') {
        mkdirOutsideWorkspace.push(`${base}:${i + 1}: ${line.trim().slice(0, 80)}`)
      }
    })
  }
  assert.equal(offenders.length, 0, `新增落盘语义须先过方案评审：${offenders.join(' | ')}`)
  assert.equal(mkdirOutsideWorkspace.length, 0, `建目录只能在 workspace.js（执行区）：${mkdirOutsideWorkspace.join(' | ')}`)
})
