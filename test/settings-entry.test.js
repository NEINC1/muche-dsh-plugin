import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import { openDshSettings } from '../client/src/settings-entry.js'

function page(html) {
  const win = new Window({ url: 'http://127.0.0.1:19387/' })
  win.document.body.innerHTML = html
  return win.document
}

// The account feature renders the launcher and portals its menu items on click, so the item
// arrives one tick after the trigger is clicked, exactly like the real Menu primitive.
function accountLauncher(document, { delayMs = 5, expanded = false, onOpen = () => {} } = {}) {
  const trigger = document.createElement('button')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-label', '账号菜单')
  trigger.setAttribute('aria-expanded', String(expanded))
  let itemClicks = 0
  const renderMenu = () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    for (const [label, flag] of [['设置', true], ['意见反馈', false]]) {
      const item = document.createElement('button')
      item.setAttribute('role', 'menuitem')
      item.textContent = label
      if (flag) item.addEventListener('click', () => { itemClicks++; onOpen() })
      menu.appendChild(item)
    }
    document.body.appendChild(menu)
  }
  trigger.addEventListener('click', () => {
    trigger.setAttribute('aria-expanded', 'true')
    setTimeout(renderMenu, delayMs)
  })
  document.body.appendChild(trigger)
  if (expanded) renderMenu()
  return { trigger, clicks: () => itemClicks }
}

// The shell mounts the panel with its section navigation once settings opens.
function settingsPanel(document) {
  const panel = document.createElement('div')
  panel.setAttribute('data-shortcut-modal', 'settings')
  const nav = document.createElement('nav')
  for (const label of ['通用设置', '小沐']) {
    const button = document.createElement('button')
    button.textContent = label
    button.addEventListener('click', () => { panel.dataset.section = label })
    nav.appendChild(button)
  }
  panel.appendChild(nav)
  document.body.appendChild(panel)
  return panel
}

test('settings opens through the account menu the official settings shell renders', async () => {
  const document = page('')
  const launcher = accountLauncher(document)
  assert.equal(await openDshSettings({ document }), 'menu')
  assert.equal(launcher.clicks(), 1, 'the official 设置 item is what gets clicked')
  assert.equal(launcher.trigger.getAttribute('aria-expanded'), 'true')
})

test('settings accepts an account menu that is already open', async () => {
  const document = page('')
  const launcher = accountLauncher(document, { expanded: true })
  assert.equal(await openDshSettings({ document }), 'menu')
  assert.equal(launcher.clicks(), 1)
})

test('settings clicks the plain trigger the shell renders without the account feature', async () => {
  const document = page('<button aria-haspopup="dialog" aria-label="设置"></button>')
  let clicks = 0
  document.querySelector('button').addEventListener('click', () => { clicks++ })
  assert.equal(await openDshSettings({ document }), 'dialog')
  assert.equal(clicks, 1)
})

test('settings matches the English launcher and item', async () => {
  const document = page('')
  const trigger = document.createElement('button')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-label', 'Account menu')
  let clicks = 0
  trigger.addEventListener('click', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    item.setAttribute('role', 'menuitem')
    item.textContent = 'Settings Ctrl+,'
    item.addEventListener('click', () => { clicks++ })
    menu.appendChild(item)
    document.body.appendChild(menu)
  })
  document.body.appendChild(trigger)
  assert.equal(await openDshSettings({ document }), 'menu')
  assert.equal(clicks, 1)
})

function sidebarMenu(document, label, items) {
  const button = document.createElement('button')
  button.setAttribute('aria-haspopup', 'menu')
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-expanded', 'false')
  let clicks = 0
  button.addEventListener('click', () => {
    clicks++
    button.setAttribute('aria-expanded', clicks % 2 === 1 ? 'true' : 'false')
    if (clicks !== 1) return
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    for (const text of items) {
      const item = document.createElement('button')
      item.setAttribute('role', 'menuitem')
      item.textContent = text
      menu.appendChild(item)
    }
    document.body.appendChild(menu)
  })
  document.body.appendChild(button)
  return { button, clicks: () => clicks }
}

test('settings prefers the account menu over another sidebar menu', async () => {
  const document = page('')
  // The real sidebar renders its own 更多 menu before the account menu.
  const other = sidebarMenu(document, '更多', ['重命名'])
  const launcher = accountLauncher(document)
  assert.equal(await openDshSettings({ document }), 'menu')
  assert.equal(launcher.clicks(), 1, 'the account menu is the launcher that has 设置')
  assert.equal(other.clicks(), 0, 'an unrelated menu is never opened')
})

test('settings closes a menu that has no settings item', async () => {
  const document = page('')
  const other = sidebarMenu(document, '更多', ['重命名'])
  assert.equal(await openDshSettings({ document, timeoutMs: 100 }), 'none')
  assert.equal(other.clicks(), 2, 'the menu without a settings item is closed again')
})

test('settings never recurses into the plugin menu or its own entry', async () => {
  const document = page('<button data-muche-entry aria-haspopup="menu" aria-label="打开小沐"></button>')
  const own = document.createElement('div')
  own.setAttribute('data-muche-menu', '')
  own.setAttribute('role', 'menu')
  const ownItem = document.createElement('button')
  ownItem.setAttribute('role', 'menuitem')
  ownItem.textContent = '设置'
  let ownClicks = 0
  ownItem.addEventListener('click', () => { ownClicks++ })
  own.appendChild(ownItem)
  document.body.appendChild(own)
  assert.equal(await openDshSettings({ document }), 'none')
  assert.equal(ownClicks, 0)
})

test('settings reports none when the host renders no launcher, without waiting forever', async () => {
  const document = page('<div><button>普通按钮</button></div>')
  const started = Date.now()
  assert.equal(await openDshSettings({ document, timeoutMs: 60 }), 'none')
  assert.ok(Date.now() - started < 1000)
})

test('settings lands on the requested section and hides the launcher menu meanwhile', async () => {
  const document = page('')
  let hidMenuDuringTransition = false
  let panel
  const launcher = accountLauncher(document, { onOpen: () => {
    hidMenuDuringTransition = document.documentElement.classList.contains('muche-settings-transition')
    panel = settingsPanel(document)
  } })
  assert.equal(await openDshSettings({ document, section: '小沐' }), 'menu')
  assert.equal(launcher.clicks(), 1)
  assert.equal(panel.dataset.section, '小沐', 'the panel opens on 小沐 settings, not the home page')
  assert.equal(hidMenuDuringTransition, true, 'the intermediate menu is hidden while settings opens')
  assert.equal(document.documentElement.classList.contains('muche-settings-transition'), false, 'the transition class is released')
})

test('settings leaves the section alone when the panel has no such entry', async () => {
  const document = page('')
  let panel
  accountLauncher(document, { onOpen: () => { panel = settingsPanel(document) } })
  assert.equal(await openDshSettings({ document, section: '不存在的分区' }), 'menu')
  assert.equal(panel.dataset.section, undefined)
})

test('settings tolerates a missing document', async () => {
  assert.equal(await openDshSettings({}), 'none')
})
