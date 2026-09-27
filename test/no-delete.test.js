/**
 * no-delete.test.js — 本地存档删文件守卫（OI-078）。
 *
 * 锁：`dsh/lib` 禁止出现文件删除原语（unlink/rmdir/rm），唯一例外是
 * local-identity.js 的 anonymous 空壳精确清理（运行时计算名单目录，
 * 不枚举；调用处可查 anonymousDirName）。新删文件语义必须先过方案评审，
 * 不能悄悄加——plugin remove 保留用户存档是既定契约（README），dispose
 * 保档行为见 panel-events.test.js。
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

test('lib 无文件删除原语（anonymous 精确清理除外）', () => {
  const offenders = []
  for (const file of walk(LIB)) {
    const src = readFileSync(file, 'utf8')
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      // 裸 rm(/unlink(/rmdir(（字母前缀的 firm(/alarm( 类单词除外）即删文件语义。
      if (/(^|[^A-Za-z_$])((?:unlink|rmdir|rm)\s*\()/.test(line)) {
        // Windows 下 file 含反斜杠，split 必须同时认两种分隔符，否则
        // basename 取不到、local-identity.js 例外匹配恒失败（本机实测）。
        offenders.push(`${file.split(/[/\\]/).pop()}:${i + 1}: ${line.trim().slice(0, 80)}`)
      }
    })
  }
  const allowed = offenders.filter((o) => o.startsWith('local-identity.js'))
  const forbidden = offenders.filter((o) => !o.startsWith('local-identity.js'))
  assert.equal(forbidden.length, 0, `新增文件删除语义须先过方案评审：${forbidden.join(' | ')}`)
  assert.ok(allowed.length > 0, 'anonymous 精确清理被删了？（应保留，见 local-identity.js）')
  const ident = readFileSync(new URL('../lib/local-identity.js', import.meta.url), 'utf8')
  assert.ok(/anonymousDirName/.test(ident), '删除调用必须经 anonymousDirName 名单（禁枚举删）')
})
