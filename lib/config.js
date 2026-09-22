/**
 * 配置层：settings 命名空间 'muche'（后端地址 + API key）。
 *
 * 多用户语义：每个用户在自己的 dsh 实例上填自己的配置（settings 是
 * 每实例/每部署的）；API key 在小沐 web 后台 → 设置 → API 密钥 生成
 * （muche_ 开头），只保存在本机 dsh 配置，不落 git、不进代码。
 */
import Schema from '@deepseek-ai/schemastery'

export const NS = 'muche'

export const DEFAULT_BACKEND = 'http://127.0.0.1:8000'

export function registerConfigNamespace(ctx) {
  ctx.settings.register(NS, Schema.object({
    backendUrl: Schema.string().default(DEFAULT_BACKEND),
    apiKey: Schema.string().default(''),
    // 小沐专用工作区目录(2026-08-15)。空 = 自动推导 os.homedir()/muche-dsh-workspace
    // (跨平台:Linux ~/…,Windows C:\Users\<用户>\…)。dsh 规范:部署级可变选择
    // 必须可配置,不硬编码。
    workspacePath: Schema.string().default(''),
  }))
}

export function readConfig(ctx) {
  const value = ctx.settings.get(NS)
  return {
    backendUrl: (value && typeof value.backendUrl === 'string' && value.backendUrl)
      ? value.backendUrl
      : DEFAULT_BACKEND,
    apiKey: (value && typeof value.apiKey === 'string') ? value.apiKey : '',
    workspacePath: (value && typeof value.workspacePath === 'string') ? value.workspacePath : '',
  }
}

/**
 * 一次性迁移：原型阶段的 JSON 文件配置（$DSH_HOME/muche-config.json）
 * 在 settings 里 API key 为空时导入一次，随后删除原型文件（规则 10
 * 单一真源，不保留双配置通道）。
 */
export async function importLegacyConfig(ctx) {
  try {
    const cfg = readConfig(ctx)
    if (cfg.apiKey) return
    const { readFile, unlink } = await import('node:fs/promises')
    const home = process.env.DSH_HOME || `${process.env.HOME}/.dsh`
    const legacyPath = `${home}/muche-config.json`
    const parsed = JSON.parse(await readFile(legacyPath, 'utf8'))
    const patch = {}
    if (typeof parsed.backendUrl === 'string' && parsed.backendUrl) patch.backendUrl = parsed.backendUrl
    if (typeof parsed.apiKey === 'string' && parsed.apiKey) patch.apiKey = parsed.apiKey
    if (Object.keys(patch).length > 0) await ctx.settings.update(NS, patch)
    await unlink(legacyPath).catch(() => {})
  } catch {
    // 无旧文件/解析失败 = 无迁移对象，静默即可（首次安装）
  }
}
