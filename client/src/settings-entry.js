// DSH 设置入口的唯一实现。
//
// 官方设置外壳（ui-settings-general）声明 `settings.launcher`：账号功能在那里渲染侧边栏
// 菜单，「设置」项调用外壳自己的 open；没有账号功能时外壳才渲染普通设置按钮。DSH 没有
// 公开的 open-settings 服务，所以只能沿这条官方入口点击。合成 keydown 不是替代：Desktop
// 经原生适配器分发已接受的快捷键，忽略 DOM 合成输入。
//
// 侧边栏同时还有别菜单（如「更多」），所以候选按官方程度排序，逐个确认菜单里真有「设置」
// 项才算命中；没命中的菜单原样关回去。菜单只是入口、不是给用户看的过程：过渡期间用
// `muche-settings-transition` 把它藏起来，避免"先弹一下菜单再进设置"。面板打开后直接选中
// 调用方要的分区（小沐自己的设置页），不停在设置首页。
//
// 本模块只做 DOM 定位与点击，不持有状态。
const SETTINGS_TRIGGER = /设置|settings|preferences/i
const ACCOUNT_MENU = /账号菜单|account menu/i
const ANY_MENU = /更多|more|菜单|menu/i
const TRANSITION_CLASS = 'muche-settings-transition'
const PANEL_SELECTOR = '[data-shortcut-modal="settings"]'
const isSettingsItem = text => /^设置/.test(text) || /^settings\b/i.test(text)
const labelOf = node => `${node.getAttribute('aria-label') || ''} ${node.textContent || ''}`
const isOwn = node => typeof node.closest === 'function' && node.closest('[data-muche-menu], [data-muche-entry]') !== null
const settingsItem = document => Array.from(document.querySelectorAll('[role="menuitem"]'))
  .find(node => !isOwn(node) && isSettingsItem((node.textContent || '').trim()))

async function waitFor(read, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value || Date.now() >= deadline) return value
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

async function openViaLauncher({ document, timeoutMs, pollMs }) {
  const triggers = Array.from(document.querySelectorAll('[aria-haspopup]')).filter(node => !isOwn(node))
  const of = (popup, pattern) => triggers.filter(node => node.getAttribute('aria-haspopup') === popup && pattern.test(labelOf(node)))
  const direct = of('dialog', SETTINGS_TRIGGER)[0]
  if (direct) { direct.click(); return 'dialog' }
  const menus = [...of('menu', ACCOUNT_MENU), ...of('menu', ANY_MENU).filter(node => !ACCOUNT_MENU.test(labelOf(node)))]
  for (const menu of menus) {
    if (menu.getAttribute('aria-expanded') !== 'true') menu.click()
    const item = await waitFor(() => settingsItem(document), Math.min(timeoutMs, 600), pollMs)
    if (item) { item.click(); return 'menu' }
    if (menu.getAttribute('aria-expanded') === 'true') menu.click()
  }
  return 'none'
}

/**
 * Opens DSH settings through the official launcher and selects one section.
 * @param {{document: Document, section?: string, timeoutMs?: number, pollMs?: number}} options
 * @returns {'dialog'|'menu'|'none'} which launcher was used, or that none was found.
 */
export async function openDshSettings({ document, section = '', timeoutMs = 1500, pollMs = 20 } = {}) {
  if (!document || typeof document.querySelectorAll !== 'function') return 'none'
  const root = document.documentElement
  root?.classList.add(TRANSITION_CLASS)
  try {
    const via = await openViaLauncher({ document, timeoutMs, pollMs })
    if (via === 'none' || !section) return via
    const panel = await waitFor(() => document.querySelector(PANEL_SELECTOR), Math.min(timeoutMs, 800), pollMs)
    if (panel) {
      const target = Array.from(panel.querySelectorAll('nav button'))
        .find(node => (node.textContent || '').trim() === section)
      if (target) target.click()
    }
    return via
  } finally { root?.classList.remove(TRANSITION_CLASS) }
}
