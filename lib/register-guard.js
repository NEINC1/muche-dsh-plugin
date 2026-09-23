/**
 * 注册守卫（纤程内实例，零依赖、零跨调用状态）。
 *
 * 根因（2026-09-23 桌面端事故）：同一插件被加载两次（profile bundles 的
 * `#muche` + 市场热树的 `#mkt-muche`），第二份 apply 在
 * `ctx.webServer.register` 撞 `duplicate exact route` 直接抛 → 整个 apply 中断 →
 * 后面的 `registerDshBridge` 永不执行 → 面板走孤儿路由、桥不存在。
 * 后端只看到“没连上”，本地无任何可操作信息。
 *
 * 治本（单一真源：主纤程唯一执行）：撞车是“已有主纤程在服务”的事实，
 * 不是错误——本纤程降级为副（跳过桥接，不抢执行权），面板由主纤程继续服务；
 * 非撞车错误照常抛（fail-loud 不动，未知问题不掩盖）。
 *
 * 纯纤程内状态：实例由 apply 创建、随纤程消亡，不挂 ctx、不搞模块单例，
 * 不形成第二套真源。
 */
export function createRegistrationGuard() {
  let degraded = false
  return {
    get degraded() {
      return degraded
    },
    /**
     * 执行一次注册。成功返回 true；撞重复返回 false 并记降级；
     * 其他错误原样抛出。
     */
    run(registerFn) {
      try {
        registerFn()
        return true
      } catch (error) {
        const message = String((error && error.message) || error)
        if (/duplicate/i.test(message)) {
          degraded = true
          console.warn('muche routes: 重复注册已跳过（双挂载副纤程，不抢执行权）: ' + message.slice(0, 160))
          return false
        }
        throw error
      }
    },
  }
}
