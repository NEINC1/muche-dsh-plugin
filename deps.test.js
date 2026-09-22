// dsh/test/deps.test.js — 插件依赖解析守卫 + 语法守卫（2026-08-16 事故教训）
//
// 背景 1：某模块新增 import '@deepseek-ai/dsh-credentials'，
// 未声明进 package.json → dsh-web 启动加载插件失败 → 整个 DSH 崩溃循环。
// 背景 2：同一模块在函数体内写静态 import → SyntaxError →
// 同样拖垮 dsh 启动（同一天第二起）。
//
// 本测试遍历 dsh/lib 全部源码：
//  ① 把每个 '@deepseek-ai/*' import 按 Node 真实解析规则校验（与 dsh
//    启动时同一条解析路径），缺失依赖直接点名；
//  ② 用 `node --check` 校验每个文件的 ESM 语法。
// 铁律：重启 dsh-web 前必须 `cd dsh && pnpm test` 全绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules') continue
      out.push(...walk(p))
    } else if (name.endsWith('.js')) {
      out.push(p)
    }
  }
  return out
}

function importsOf(file) {
  const src = readFileSync(file, 'utf8')
  const found = new Set()
  const re = /(?:from\s+|import\s*\()\s*['"](@deepseek-ai\/[a-z0-9-]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) found.add(m[1])
  return [...found]
}

test('所有 @deepseek-ai/* 依赖均可解析（防 dsh 崩溃循环）', () => {
  const libDir = fileURLToPath(new URL('../lib', import.meta.url))
  const files = walk(libDir)
  const missing = new Map()
  for (const file of files) {
    const url = pathToFileURL(file).href
    for (const spec of importsOf(file)) {
      try {
        import.meta.resolve(spec, url)
      } catch {
        if (!missing.has(spec)) missing.set(spec, [])
        missing.get(spec).push(file)
      }
    }
  }
  assert.deepEqual(
    [...missing.keys()],
    [],
    '未安装依赖：' + [...missing.keys()].map((spec) => {
      const f = missing.get(spec)[0]
      return `${spec}（被 ${f.replace(libDir, 'lib/')} 引用）`
    }).join('；') + '。请在 dsh/ 下执行 pnpm add <包名> 后再重启 dsh-web。',
  )
})

test('dsh/lib 全部源码 ESM 语法合法（防 SyntaxError 拖垮启动）', () => {
  const libDir = fileURLToPath(new URL('../lib', import.meta.url))
  const files = walk(libDir)
  const broken = []
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (err) {
      const msg = String(err.stderr || err.message).split('\n')[0]
      broken.push(`${file.replace(libDir, 'lib/')} → ${msg}`)
    }
  }
  assert.deepEqual(broken, [], '语法错误：\n' + broken.join('\n') + '\n修复后再重启 dsh-web。')
})

