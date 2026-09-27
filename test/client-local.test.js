// dsh/test/client-local.test.js — 面板服务端直读守卫（0.5.0 本地存档删除）
//
// 锁死：
//  ① 首屏单页 50 条直读服务端，绝不全量；无本地口残留；
//  ② 增量 20 条小批量按 id 归一，dialogue_updated 到才拉，不轮询；
//  ③ 上翻游标前插，has_more=false 即停；300ms 尾防抖；
//  ④ 在途 overlay 合并渲染（ingress 精确认领）；
//  ⑤ 过期图占位"图片已过期"＋描述；换 key/地址清内存防串号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('无本地口残留（local-history/sync/sync-older 全删）', () => {
  assert.ok(!/\/api\/muche\/local-history/.test(BUNDLE), '仍调用本地 history 口')
  assert.ok(!/\/api\/muche\/sync-older/.test(BUNDLE), '仍调用向旧回填口')
  assert.ok(!/\/api\/muche\/sync'/.test(BUNDLE), '仍调用本地同步口')
  assert.ok(!/syncChainRef/.test(BUNDLE), '本地同步串行链未删除')
  assert.ok(!/refreshFromLocal/.test(BUNDLE), '本地刷新收口未删除')
  assert.ok(!/triggerSync/.test(BUNDLE), '本地同步触发未删除')
  assert.ok(!/local-store/.test(BUNDLE), '仍引用本地存档模块')
  assert.ok(!/抽屉/.test(BUNDLE), '仍暴露抽屉说明')
  assert.ok(!/emptyNote/.test(BUNDLE), '空档说明状态未删除')
})

test('首屏单页 50 条直读服务端', () => {
  const loadHistory = BUNDLE.match(/const loadHistory = [\s\S]*?\}, \[\]\)/)
  assert.ok(loadHistory, '未找到 loadHistory')
  assert.ok(/\/api\/muche\/history\?limit=50/.test(loadHistory[0]), '首屏不是单页 50 条')
  assert.ok(/setOlderCursor/.test(loadHistory[0]), '首屏未存向旧游标')
  assert.ok(/setReachedStart\(true\)/.test(loadHistory[0]), '首屏 has_more=false 未探底')
})

test('增量 20 条小批量按 id 归一', () => {
  const fetchNew = BUNDLE.match(/const fetchNew = [\s\S]*?\}, \[\]\)/)
  assert.ok(fetchNew, '未找到 fetchNew')
  assert.ok(/\/api\/muche\/history\?limit=20/.test(fetchNew[0]), '增量不是 20 条小批量')
  const refresh = BUNDLE.match(/const refreshNew = [\s\S]*?\}, \[fetchNew\]\)/)
  assert.ok(refresh, '未找到 refreshNew')
  assert.ok(/known\.has/.test(refresh[0]), '增量未按 id 去重归一')
  assert.ok(!/setMsgs\(withSticky\(page\)\)/.test(refresh[0]), '增量整页替换，吞在途')
})

test('dialogue_updated 到才拉，不轮询', () => {
  assert.ok(/dialogue_updated'\) \{\n[^}]*refreshNew\(\)/.test(BUNDLE) || /dialogue_updated/.test(BUNDLE) && /refreshNew\(\)/.test(BUNDLE), '跨端广播未走增量刷新')
  const historyCalls = BUNDLE.match(/\/api\/muche\/history/g) || []
  assert.ok(historyCalls.length <= 4, `history 调用点 ${historyCalls.length} 处过多（首屏/增量/翻页三处之外即轮询嫌疑）`)
})

test('上翻游标前插，到底即停', () => {
  const older = BUNDLE.match(/const loadOlder = \(\) => \{[\s\S]*?\n      \}/)
  assert.ok(older, '未找到 loadOlder')
  assert.ok(/before=' \+ encodeURIComponent\(cursor\)/.test(older[0]) || /before=/.test(older[0]), '翻页未带 before 游标')
  assert.ok(/olderCursor/.test(older[0]), '翻页未用向旧游标')
  assert.ok(/setReachedStart\(true\)/.test(older[0]), '到底未探底，还会反复打后端')
})

test('翻页 300ms 尾防抖', () => {
  const older = BUNDLE.match(/const loadOlder = \(\) => \{[\s\S]*?\n      \}/)
  assert.ok(older, '未找到 loadOlder')
  assert.ok(/olderTimerRef/.test(older[0]), '翻页无防抖守卫，手滑连发翻页请求')
  assert.ok(/300/.test(older[0]), '防抖不是 300ms')
})

test('翻页无游标即探底（不重拉最新页）', () => {
  const older = BUNDLE.match(/const loadOlder = \(\) => \{[\s\S]*?\n      \}/)
  assert.ok(older, '未找到 loadOlder')
  assert.ok(/!cursor/.test(older[0]), '无游标未探底，会重拉最新页空转')
})

test('合并渲染：base＋overlay，无整页吞在途', () => {
  assert.ok(/baseRef\.current = page/.test(BUNDLE), '首屏未把确认行写入 base')
  assert.ok(/overlayRef/.test(BUNDLE), '缺少在途覆盖层 overlay')
  assert.ok(/reconcileOverlay\(\)/.test(BUNDLE), '缺少认领退役')
  assert.ok(/renderMerged\(/.test(BUNDLE), '缺少合并渲染')
  assert.ok(/overlayAdd\(/.test(BUNDLE), '在途行未进覆盖层')
})

test('overlay ingress 精确认领', () => {
  assert.ok(/o\.mid/.test(BUNDLE), '用户乐观行未带客户端 message_id')
  assert.ok(/delivery_id === o\.mid/.test(BUNDLE), '未按 ingress 精确认领')
  assert.ok(/delivery_id/.test(BUNDLE.match(/const normalize = [\s\S]*?\}\)\)/)[0]), 'normalize 未透传 delivery_id')
})

test('normalize 透传 vision 描述（过期图占位用）', () => {
  const m = BUNDLE.match(/const normalize = \(rows\) => \(rows \|\| \[\]\)\.map\(\(m\) => \(\{/g)
  assert.ok(m, '未找到 normalize')
  assert.ok(/vision_descriptions/.test(BUNDLE), '未读取服务端 vision 描述')
})

test('过期图占位"图片已过期"', () => {
  assert.ok(/图片已过期/.test(BUNDLE), '缺少过期图占位文案')
  assert.ok(/onError/.test(BUNDLE), '图片未挂加载失败分支，过期图破图')
  assert.ok(/markImgFailed/.test(BUNDLE), '过期图未记失败集合')
})

test('换 key/地址清内存防串号', () => {
  assert.ok(/authFpRef/.test(BUNDLE), '缺少配置指纹，换 key 不清内存会串号')
  assert.ok(/overlayRef\.current = \[\]/.test(BUNDLE), '配置变化未清覆盖层')
})

test('地址缺 /api 即时提示（全员远端唯一口径）', () => {
  assert.ok(/missingApiSuffix/.test(BUNDLE), '缺少地址形态即时判定')
  assert.ok(/地址少了 \/api 后缀/.test(BUNDLE), '缺少缺后缀 inline 红字')
  assert.ok(!/同机填/.test(BUNDLE), '仍保留同机分支文案（全员远端已废止）')
})

test('面板错误透传 NOT_API 指引（不吞成无差别报错）', () => {
  assert.ok(/少了 \/api 后缀/.test(BUNDLE), '面板未透传 NOT_API 可操作指引')
})

test('地址判定无回环例外（全员远端，裸 path 即判缺）', () => {
  const fn = BUNDLE.match(/function missingApiSuffix\(url\) \{[\s\S]*?\n    \}/)
  assert.ok(fn, '未找到 missingApiSuffix')
  assert.ok(!/localhost/.test(fn[0]), '仍保留 localhost 例外')
  assert.ok(!/127\\/.test(fn[0]), '仍保留 127.x 例外')
})
