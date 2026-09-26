/**
 * 配置层：插件自己的 Config（后端地址 + API key + 工作区目录）。
 *
 * 官方 0.1.7 契约（本插件唯一目标 cohort，不兼容旧版）：
 *  - 表单命名空间＝profile 条目 id（本包 `cordis.patch.yml` 的 insert id，
 *    见 NS；`settings.register(ns, schema)` 已被官方删除，调用即整 entry
 *    激活失败——2026-09-26 官方桌面端事故根因）；
 *  - 字段必须标 `.volatile()`，官方才把它们投影成可编辑项，写入经 Host
 *    校验后落 profile patch；
 *  - 插件读自己的 Config 引用（`.get()`，每次操作现读，引用原地更新，
 *    跨 await 不缓存快照）；变更由官方发实例内 `loader/volatile-update`
 *    通知，不重挂插件。
 *
 * 多用户语义：每个用户在自己的 dsh 实例上填自己的配置（settings 是
 * 每实例/每部署的）；API key 在小沐 web 后台 → 设置 → API 密钥 生成
 * （muche_ 开头），只保存在本机 dsh 配置，不落 git、不进代码。
 * apiKey 不标 `role('secret')`：面板 WS 以它为同源代理 token，secret
 * 会被官方响应抹掉，标了面板拿不到它（有意决策，非遗漏）。
 */
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import path from 'node:path'

/** profile 条目 id（与 cordis.patch.yml 的 insert id 同名，见 configNamespace）。 */
export const NS = 'muche'

export const DEFAULT_BACKEND = 'http://127.0.0.1:8000'

export const Config = Schema.object({
  backendUrl: Schema.string().default(DEFAULT_BACKEND).volatile(),
  apiKey: Schema.string().default('').volatile(),
  // 小沐专用工作区目录。空 = 自动推导 os.homedir()/muche-dsh-workspace
  // (跨平台:Linux ~/…,Windows C:\Users\<用户>\…)。dsh 规范:部署级可变选择
  // 必须可配置,不硬编码。
  workspacePath: Schema.string().default('').volatile(),
})

/** 取一个字段的当前值：volatile 引用调 `.get()`，普通值直接用（单测构造）。 */
function current(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/** 读配置：入参是 apply 收到的 Config 对象本身（引用），每次操作现读。 */
export function readConfig(config) {
  const source = config || {}
  const backendUrl = current(source.backendUrl)
  const apiKey = current(source.apiKey)
  const workspacePath = current(source.workspacePath)
  return {
    backendUrl: typeof backendUrl === 'string' && backendUrl ? backendUrl : DEFAULT_BACKEND,
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    workspacePath: typeof workspacePath === 'string' ? workspacePath : '',
  }
}

/**
 * 配置命名空间（官方表单与 settings.update 的寻址键）：
 * 本插件 profile 条目 id。经 loader 反查而非硬编码——市场安装的条目 id
 * 可能不是 insert id（如 `mkt-muche`）；settings 服务按 `entry.options.id`
 * 寻址（`loader.locate` 给的是路径限定 id，嵌套 include 下两者不同）。
 */
export function configNamespace(ctx) {
  const loader = ctx.get('loader')
  if (loader !== undefined && typeof loader.locate === 'function') {
    const located = loader.locate(ctx.fiber)
    if (located !== undefined) {
      const entry = typeof loader.resolve === 'function' ? loader.resolve(located) : undefined
      const id = entry && entry.options ? entry.options.id : located
      if (typeof id === 'string' && id) return id
    }
  }
  return NS
}

/**
 * 写配置：唯一写入口，经官方 settings 服务（Host 校验完整 Config＋落
 * profile patch）。调用方只有 importLegacyConfig——面板设置页走官方
 * 客户端服务（configForms），不经此函数（单一真源，不并行写通道）。
 */
export async function writeConfig(ctx, patch) {
  await ctx.settings.update(configNamespace(ctx), patch)
}

/**
 * 一次性迁移：原型阶段的 JSON 文件配置（$DSH_HOME/muche-config.json）
 * 在配置里 API key 为空时导入一次，随后删除原型文件（单一真源，
 * 不保留双配置通道）。
 */
export async function importLegacyConfig(ctx, config) {
  try {
    const cfg = readConfig(config)
    if (cfg.apiKey) return
    const { readFile, unlink } = await import('node:fs/promises')
    // 家目录解析与 workspace.js 同源（os.homedir，跟用户走，不跟安装盘）：
    // 旧写法 process.env.HOME 在 Windows 下一般是 undefined，拼出来是垃圾路径，
    // 迁移在 Windows 上永远命中不了（外层 catch 吃掉，不影响正常使用）。
    const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
    const legacyPath = path.join(home, 'muche-config.json')
    const parsed = JSON.parse(await readFile(legacyPath, 'utf8'))
    const patch = {}
    if (typeof parsed.backendUrl === 'string' && parsed.backendUrl) patch.backendUrl = parsed.backendUrl
    if (typeof parsed.apiKey === 'string' && parsed.apiKey) patch.apiKey = parsed.apiKey
    if (Object.keys(patch).length > 0) await writeConfig(ctx, patch)
    await unlink(legacyPath).catch(() => {})
  } catch {
    // 无旧文件/解析失败 = 无迁移对象，静默即可（首次安装）
  }
}
