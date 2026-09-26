/**
 * 小沐专用工作区管理。
 *
 * 小沐的 dsh 会话全部归属一个专用工作区（真实目录），与用户代码目录隔离；
 * dsh agent 执行任务的工作目录即该目录（Windows 兼容：路径零硬编码）。
 *
 * dsh 规范对齐：
 * - 部署级可变选择可配置（Config.workspacePath，空 = 自动推导）；
 * - 显式 resolve（resolveWorkspacePath 是唯一路径解析点，不散落 ?? 默认）；
 * - 注册走 ctx.on/effect 返回 disposer（本模块无长驻注册，幂等操作直调）。
 *
 * 会话列表：ctx.workspaceRegistry（进程内实体，sessionIds 按 canonical-cwd
 * 过滤）+ ctx.sessionQuery.readTitle（标题，dsh 自动生成，不手动设置）。
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

import { readConfig } from './config.js'

export const DEFAULT_WORKSPACE_NAME = 'muche-dsh-workspace'

/** 显式解析工作区目录路径（配置优先；空 = os.homedir 推导，跨平台）。 */
export function resolveWorkspacePath(ctx, config) {
  const cfg = readConfig(config)
  if (cfg.workspacePath && cfg.workspacePath.trim()) {
    return path.resolve(cfg.workspacePath.trim())
  }
  return path.join(homedir(), DEFAULT_WORKSPACE_NAME)
}

/** 幂等：目录存在 + dsh 工作区实体存在；返回 { path, workspaceId }。 */
export async function ensureWorkspace(ctx, config) {
  const wsPath = resolveWorkspacePath(ctx, config)
  await mkdir(wsPath, { recursive: true })
  const registry = ctx.get('workspaceRegistry')
  if (!registry) throw new Error('缺少 workspaceRegistry，反向桥接不可用')
  // resolveByPath 是 async（realpathNormalize 校验），必须 await——
  // 漏 await 会拿到 Promise（永远 !== undefined），返回 undefined workspaceId，
  // session.create 静默落默认 cwd（会话建在用户家目录、未挂工作区）
  const existing = await registry.resolveByPath(wsPath)
  if (existing !== undefined) {
    return { path: wsPath, workspaceId: existing.id }
  }
  const ws = await registry.create(wsPath, '小沐')
  return { path: wsPath, workspaceId: ws.id }
}

/**
 * 工作区会话列表（按最近活跃降序，上限 limit）。活跃度 = 标题快照
 * updatedAt（dsh 随对话推进自动更新标题，是其唯一的 recency 信号；
 * 无标题会话按 0 排末尾）；标题取 dsh 自动生成值（未生成/读取失败 =
 * 空串，调用方降级展示）；归档会话（registry 全局隐藏标记，archiveSession
 * 不移出 workspace 记录）用户侧边栏不可见——过滤不进注入面，与"侧边栏
 * 可见、可旁观"形态承诺一致；不含任何路径信息（注入面不暴露部署细节）。
 */
export async function listWorkspaceSessions(ctx, workspaceId, limit = 5) {
  const registry = ctx.get('workspaceRegistry')
  const sessionQuery = ctx.get('sessionQuery')
  if (!registry || !sessionQuery) return []
  const ws = registry.get(workspaceId)
  if (ws === undefined) return []
  const archived = new Set(registry.archivedSessionIds)
  const rows = []
  for (const sessionId of ws.sessionIds) {
    if (archived.has(sessionId)) continue
    let title = ''
    let updatedAt = 0
    try {
      // readTitle 直接返回 SessionTitleSnapshot { title, eventSeq, updatedAt }
      // （不是 SessionTitleObservation——取错层会拿到 undefined.title 变空串）
      const t = await sessionQuery.readTitle(sessionId)
      if (t && t.title) {
        title = String(t.title)
        updatedAt = Number(t.updatedAt) || 0
      }
    } catch {
      // 标题读取失败 = 该会话按无标题降级，不阻断列表
    }
    rows.push({ sessionId, title, updatedAt })
  }
  // updatedAt 降序（stable sort 保持 registry 创建序做并列兜底）
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  return rows.slice(0, limit)
}
