/**
 * 注册守卫（纤程内实例，零依赖、零跨调用状态）。
 *
 * 根因（2026-09-23 桌面端事故）：同一插件被加载两次（profile bundles 的
 * `#muche` + 市场热树的 `#mkt-muche`），第二份 apply 在
 * `ctx.webServer.register` 撞 `duplicate exact route` → 整个 apply 中断 →
 * 后面的 `registerDshBridge` 永不执行 → 面板走孤儿路由、桥不存在。
 * 撞车是“已有主纤程在服务”的事实，不是错误：副纤程降级、不抢执行权。
 *
 * 事务性注册：撞车后必须原子撤销本轮已成功的注册，否则会出现“部分路径属于
 * 新（随即被释放的）runtime、其余路径属于旧 Owner”的混合所有权，面板永久
 * connecting。runAtomic 保证要么本轮全部注册成功，要么一条都不留。
 *
 * 非撞车错误照常抛（fail-loud 不动，未知问题不掩盖）。纯纤程内状态，不挂 ctx。
 */
export function createRegistrationGuard() {
  let degraded = false
  let owned = []
  const rollback = () => {
    while (owned.length > 0) {
      const dispose = owned.pop()
      try { dispose?.() } catch (error) { console.warn('muche routes: rollback failed: ' + String(error?.message || error).slice(0, 160)) }
    }
  }
  const track = (dispose) => { if (typeof dispose === 'function') owned.push(dispose) }
  return {
    get degraded() {
      return degraded
    },
    /** Track a disposer so the current transaction can roll itself back. */
    track,
    /**
     * 执行一次注册。成功返回 true；撞重复返回 false 并记降级；
     * 其他错误原样抛出。
     */
    run(registerFn) {
      try {
        track(registerFn())
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
    /** Release everything this transaction registered and mark it degraded. */
    rollbackAsDegraded() {
      degraded = true
      rollback()
      return false
    },
  }
}