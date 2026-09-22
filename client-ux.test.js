// dsh/test/client-ux.test.js — 聊天面板交互守卫（输入框焦点、连续发送与面板拖拽）
//
// 锁死三条面板交互契约：
//  ① 发送后输入框自动回到焦点：文本框挂 inputRef，发送后立刻补回 focus，
//     面板打开且不在额度禁用期时也补回，不靠用户重连点。
//  ② 连续可发：输入框与发送按钮永不为在途回复禁用（只剩额度禁用），发完
//     第一条立刻能发第二条；连续追发的合并由后端合并语义承接。
//  ③ 面板拖拽只有一套机制：顶部标题栏与底部拖拽条共用同一 dragHandle，
//     顶部被顶出可视区时底部仍可把面板拖回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 换行归一化：Windows 下 core.autocrlf=true 会把工作区文件检出为 CRLF，
// 而本文件的结构正则按 LF 写；契约是代码结构，不依赖检出换行策略。
const BUNDLE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('文本输入框挂 inputRef（焦点补回的落点）', () => {
  assert.ok(/const inputRef = React\.useRef\(null\)/.test(BUNDLE), 'ChatPanel 未声明 inputRef')
  const m = BUNDLE.match(/h\('input', \{([\s\S]*?)\}\),\n\s*h\('button', \{ type: 'button', className: 'muche-btn', onClick: send/)
  assert.ok(m, '未找到发送行旁的文本输入框')
  assert.ok(/ref: inputRef/.test(m[1]), '文本输入框未挂 ref: inputRef')
  assert.ok(/className: 'muche-field'/.test(m[1]), '命中的输入框不是文本框（muche-field）')
})

test('发送后立刻补回输入框焦点', () => {
  const m = BUNDLE.match(/const send = \(\) => \{([\s\S]*?)\n      \}\n/)
  assert.ok(m, '未找到 send 函数')
  assert.ok(/inputRef\.current/.test(m[1]), 'send 内未补回输入框焦点')
  assert.ok(/\.focus\(\)/.test(m[1]), 'send 内未调用 focus()')
})

test('输入框不为在途回复禁用（连续可发）', () => {
  const m = BUNDLE.match(/ref: inputRef, className: 'muche-field'([\s\S]*?)style: \{ flex: 1 \}/)
  assert.ok(m, '未找到文本输入框')
  assert.ok(!/disabled:.*thinking/.test(m[1]), '文本输入框仍被在途状态禁用')
})

test('发送按钮不为在途回复禁用（只剩额度禁用）', () => {
  const m = BUNDLE.match(/onClick: send, disabled: ([^}]+)\}/)
  assert.ok(m, '未找到发送按钮')
  assert.ok(!/thinking/.test(m[1]), `发送按钮仍被在途状态禁用：当前=${m[1]}`)
})

test('在途按消息独立清账（不互相挡）', () => {
  assert.ok(/inflightRef\.current\.add\(mid\)/.test(BUNDLE), '发送时未按 message_id 登记在途')
  assert.ok(/inflightRef\.current\.delete\(mid\)/.test(BUNDLE), '收账时未按 message_id 清账')
  assert.ok(!/pendingMidRef/.test(BUNDLE), '仍残留单条 pendingMidRef，连续追发会被它挡住')
  assert.ok(!/setSending/.test(BUNDLE), '仍残留 setSending 发送锁')
})

test('面板打开或回到可输入时补回输入框焦点', () => {
  assert.ok(/inputRef\.current/.test(BUNDLE), '未读取 inputRef.current')
  assert.ok(/\.focus\(\)/.test(BUNDLE), '未调用 focus()')
})

test('拖拽收敛为共用 dragHandle（顶部与底部同一机制）', () => {
  const uses = BUNDLE.match(/\.\.\.dragHandle/g) || []
  assert.ok(uses.length >= 2, `dragHandle 共用点不足：当前=${uses.length}，期望≥2（顶部标题栏＋底部拖拽条）`)
  // dragHandle 定义本身含一处 onPointerDown: onDragStart；除定义外不得再有直写。
  const direct = BUNDLE.match(/onPointerDown: onDragStart/g) || []
  assert.equal(direct.length, 1, `手柄直写 onPointerDown: onDragStart 共 ${direct.length} 处，期望仅 dragHandle 定义内 1 处`)
})

test('底部拖拽条存在（顶部不可见时的拖回入口）', () => {
  assert.ok(/title: '拖动面板'/.test(BUNDLE), '未找到底部拖拽条（title=拖动面板）')
})

test('焦点 effect 注册在早退之前（hooks 顺序不被早退截断）', () => {
  const earlyReturn = BUNDLE.indexOf('if (!open) return null')
  assert.ok(earlyReturn > 0, '未找到面板关闭早退')
  const lastEffect = BUNDLE.lastIndexOf('React.useEffect(', earlyReturn)
  assert.ok(lastEffect > 0, '早退之前没有 React.useEffect')
  const focusEffect = BUNDLE.indexOf('inputRef.current')
  assert.ok(focusEffect > 0 && focusEffect < earlyReturn, '焦点补回逻辑须在早退之前注册')
})
