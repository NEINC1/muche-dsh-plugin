// muche-dsh-plugin — 客户端源码入口（浏览器，esbuild 打包到 ../client.js）。
// 形态：左下角「小沐」入口按钮 + 可拖动聊天浮层面板 + 设置页。
// 聊天与同步数据经 /api/muche/* 路由直连后端，不进 dsh agent 循环（零注入）。
// 配置不走自建路由：设置页与面板经官方客户端设置服务（configForms 镜像）
// 读写，存储唯一真源是宿主 profile patch（见 lib/config.js）。
// 纯函数在 ./pure.js（直测），同源调用在 ./api.js；本文件只留工厂与 UI。
import { apiGet, apiPost } from './api.js'
import { clipboardImageFiles, fmtTime, gapMinutes, localHM } from './pure.js'
import { downmix, encodeRecording } from './voice.js'
import { openDshSettings } from './settings-entry.js'
import { classifyFailure, STALE_RUNTIME } from '../../lib/errors.js'
import { isSameProblem } from '../../lib/runtime-contract.js'
import { createRuntimeClient } from './runtime-store.js'

// UI preflight only; dsh/test/request-body-bounds.test.js ties these to Vision's Owner values.
const VISION_PREFLIGHT_MAX_IMAGES = 3
const VISION_PREFLIGHT_MAX_BYTES = 8 * 1024 * 1024
// 语音误触门槛：短于这个时长的录音直接丢掉（按一下开始、再按一下发送时，手滑连按不会发出去）。
// 真正"有没有声音"仍由后端按 peak 判定，这里只拦"根本没打算说"。
const MIN_VOICE_MS = 400

export const clientDefinition = {
  id: 'muche-dsh-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let React = require('react')

    const h = React.createElement
    const desktopChat = window.mucheDesktopChat?.active === true
    // 输入条只用图形按钮：文字版在窄面板里挤占输入宽度（OI-191 界面优化）。
    const icon = {
      image: () => h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 5, cy: 6, r: 1.1, fill: 'currentColor' }),
        h('path', { d: 'M2.2 11.8l3.4-3 2.4 2.1 2.9-2.6 3 2.7', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' })),
      mic: () => h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        h('rect', { x: 6, y: 1.8, width: 4, height: 7.2, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M3.6 8.4a4.4 4.4 0 0 0 8.8 0M8 12.8V14.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })),
      stop: () => h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        h('rect', { x: 4.2, y: 4.2, width: 7.6, height: 7.6, rx: 1.6, fill: 'currentColor' })),
      send: () => h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        h('path', { d: 'M14.2 1.8L6.8 9.2M14.2 1.8L9.6 14.2 7 9 1.8 6.4 14.2 1.8Z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' })),
    }
    // 小沐设置分区的唯一名字：slot 注册与「菜单→设置」跳转共用，改名只改这里。
    const SETTINGS_SECTION = '小沐'

    // ── 样式 ──
    const CSS = `
      .muche-settings-entry{background:0 0}
      .muche-settings-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .muche-field{box-sizing:border-box;width:100%;height:34px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
      .muche-field:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
      .muche-btn{box-sizing:border-box;height:32px;padding:0 14px;border:none;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;font-size:13px;cursor:pointer}
      /* 官方设置入口是账号菜单里的一项；过渡期间把那个菜单藏起来，别让用户看到"先弹一下再进设置" */
      html.muche-settings-transition [role="menu"]:not([data-muche-menu]){visibility:hidden}
    `
    if (typeof document !== 'undefined') {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'muche-dsh-plugin'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── 面板共享状态(open + 未读小红点) ──
    const panelStore = {
      open: desktopChat,
      unread: 0,
      subs: [],
      toggle() {
        this.open = !this.open
        if (this.open) this.unread = 0
        for (const f of this.subs) f()
      },
      close() { if (desktopChat) { window.mucheDesktopChat.close(); return } if (this.open) { this.open = false; for (const f of this.subs) f() } },
      openPanel() { this.open = true; this.unread = 0; for (const f of this.subs) f() },
      bumpUnread() { if (!this.open) { this.unread += 1; for (const f of this.subs) f() } },
      markRead() { if (this.unread !== 0) { this.unread = 0; for (const f of this.subs) f() } },
      subscribe(f) { this.subs.push(f); return () => { this.subs = this.subs.filter((x) => x !== f) } },
    }
    function usePanelOpen() {
      const [open, setOpen] = React.useState(panelStore.open)
      React.useEffect(() => panelStore.subscribe(() => setOpen(panelStore.open)), [])
      return open
    }
    const menuStore = {
      open: false, anchor: null, subs: [],
      set(open, anchor) { this.open = open; this.anchor = open ? anchor : null; for (const f of this.subs) f() },
      toggle(anchor) { this.set(!this.open, anchor) },
      close() { if (this.open) this.set(false, null) },
      subscribe(f) { this.subs.push(f); return () => { this.subs = this.subs.filter(x => x !== f) } },
    }
    function useMenu() {
      const [value, setValue] = React.useState({ open: menuStore.open, anchor: menuStore.anchor })
      React.useEffect(() => menuStore.subscribe(() => setValue({ open: menuStore.open, anchor: menuStore.anchor })), [])
      return value
    }

    const runtimeStore = createRuntimeClient()
    function useRuntime() {
      const [value, setValue] = React.useState(runtimeStore.getSnapshot())
      React.useEffect(() => runtimeStore.subscribe(setValue), [])
      return value
    }
    async function runtimeRequest(path, body) {
      const context = runtimeStore.context()
      if (!context) return { ok: false, stale: true, code: STALE_RUNTIME }
      const res = body === undefined ? await apiGet(path, { context }) : await apiPost(path, body, { context })
      const current = runtimeStore.observeReply(context, res)
      return current ? res : { ok: false, stale: true, code: STALE_RUNTIME }
    }

    // ── 官方配置作用域（configForms 镜像，不自存配置） ──
    // Settings edit official snapshots with revision fencing. Running connections are
    // controlled by the host's saved-config transition, not by this browser form.
    const scopeStore = {
      scope: null,
      namespace: null,
      subs: [],
      set(next) { this.scope = next; for (const f of this.subs) f() },
      subscribe(f) { this.subs.push(f); return () => { this.subs = this.subs.filter((x) => x !== f) } },
    }
    function useScope() {
      const [, force] = React.useState(0)
      React.useEffect(() => scopeStore.subscribe(() => force((n) => n + 1)), [])
      return scopeStore.scope
    }
    // ── 小人图标（官方 IconUserOutline16 同款 SVG） ──
    function PersonIcon({ size }) {
      return h('svg', {
        width: size || 16, height: size || 16, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true,
      },
        h('path', {
          d: 'M11.0307 5.46369C11.0305 3.78995 9.6734 2.43357 7.99961 2.43357C6.32601 2.43379 4.96972 3.79009 4.96949 5.46369C4.96949 7.13748 6.32587 8.49455 7.99961 8.49477C9.67354 8.49477 11.0307 7.13762 11.0307 5.46369ZM12.3163 5.46369C12.3163 7.84777 10.3837 9.78042 7.99961 9.78042C5.61572 9.7802 3.68288 7.84763 3.68288 5.46369C3.6831 3.07993 5.61586 1.14718 7.99961 1.14695C10.3836 1.14695 12.3161 3.0798 12.3163 5.46369Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M8.00002 10.3316C11.7343 10.3316 14.1864 11.8997 15.0387 14.4445L14.4292 14.6483L13.8197 14.8531C13.1955 12.9893 11.3673 11.6182 8.00002 11.6182C4.63277 11.6182 2.80455 12.9893 2.18031 14.8531L1.5708 14.6483L0.961304 14.4445C1.81368 11.8997 4.26579 10.3316 8.00002 10.3316Z',
          fill: 'currentColor',
        }),
      )
    }

    // ── 入口按钮（左下角，逐字复刻官方设置行 .trigger 规格） ──
    // 规格来源: ui-settings-general SettingsRoot.module.css .trigger / .trigger.rail
    // (width calc(100%+8px) + margin '4px -4px 4px' 出血、34px 高、radius 12、hover)。
    // footerActions 是"堆叠在设置行上方"的全宽 flex 行;官方 cordis-panel 在无
    // 动态插件时渲染 null,故本行通常只有小沐入口独占整行。
    // 教训: 曾经的 marginTop:61/负 margin 换行术会被侧边栏 overflow:hidden 裁掉,
    // 禁用;背景色只走 .muche-settings-entry 类(内联 background 会压掉 :hover)。
    function useUnread() {
      const [unread, setUnread] = React.useState(panelStore.unread)
      React.useEffect(() => panelStore.subscribe(() => setUnread(panelStore.unread)), [])
      return unread
    }

    function MucheEntry({ wide }) {
      const open = usePanelOpen()
      const menu = useMenu()
      const unread = useUnread()
      const toggleMenu = event => { const r = event.currentTarget.getBoundingClientRect(); menuStore.toggle({ left: r.left, top: r.top, width: r.width, height: r.height }) }
      const entryTitle = open
        ? '小沐面板已打开'
        : (unread > 0 ? `小沐有 ${unread} 条未读` : '打开小沐')
      if (!wide) {
        return h('button', {
          type: 'button', onClick: toggleMenu, 'data-muche-entry': '', 'aria-haspopup': 'menu', 'aria-expanded': menu.open,
          title: entryTitle,
          className: 'muche-settings-entry',
          style: {
            position: 'relative',
            boxSizing: 'border-box', cursor: 'pointer', border: 'none', overflow: 'visible',
            width: 36, height: 36, borderRadius: '50%',
            margin: '8px 0 10px',
            justifyContent: 'center', alignItems: 'center', gap: 0, padding: 0,
            color: 'var(--dsw-alias-label-primary)',
            display: 'flex',
          },
        },
          h(PersonIcon, { size: 18 }),
          unread > 0 ? h('span', { style: { position: 'absolute', top: 5, right: 5, width: 8, height: 8, borderRadius: '50%', background: 'var(--dsw-alias-state-error-primary)' } }) : null,
        )
      }
      return h('button', {
        type: 'button', onClick: toggleMenu, 'data-muche-entry': '', 'aria-haspopup': 'menu', 'aria-expanded': menu.open,
        title: entryTitle,
        className: 'muche-settings-entry',
        style: {
          position: 'relative',
          flex: 'none', display: 'flex', alignItems: 'center', gap: 8,
          width: 'calc(100% + 8px)', height: 34,
          margin: '4px -4px 4px',
          padding: '6px 2px 6px 10px',
          boxSizing: 'border-box', border: 'none', borderRadius: 12,
          overflow: 'visible', cursor: 'pointer',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'inherit', fontSize: 14, lineHeight: '22px',
        },
      },
        h(PersonIcon, { size: 16 }),
        h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden' } }, open ? '小沐(已打开)' : '小沐'),
        unread > 0 ? h('span', { style: { position: 'absolute', top: 6, right: 8, minWidth: 14, height: 14, padding: '0 4px', borderRadius: 7, background: 'var(--dsw-alias-state-error-primary)', color: '#fff', fontSize: 10, lineHeight: '14px', textAlign: 'center' } }, unread > 99 ? '99+' : String(unread)) : null,
      )
    }

    function MucheMenu() {
      const menu = useMenu(), runtime = useRuntime()
      const desktop = runtime?.snapshot?.desktop
      const menuRef = React.useRef(null)
      React.useEffect(() => {
        if (!menu.open) return
        const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menuStore.close() } }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [menu.open])
      React.useEffect(() => {
        if (menu.open) menuRef.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus()
      }, [menu.open])
      if (!menu.open || !menu.anchor) return null
      const available = desktop?.available === true
      const busy = ['starting', 'stopping'].includes(desktop?.state)
      const action = desktop?.state === 'visible' ? 'hide' : desktop?.state === 'failed' ? 'retry' : 'show'
      const label = desktop?.state === 'visible' ? '隐藏小沐' : desktop?.state === 'failed' ? '重试显示' : desktop?.state === 'starting' ? '正在显示…' : desktop?.state === 'stopping' ? '正在隐藏…' : '显示小沐'
      const row = (key, text, onClick, disabled = false) => h('button', { key, type: 'button', role: 'menuitem', disabled, onClick,
        style: { display: 'block', width: '100%', padding: '8px 10px', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', textAlign: 'left', cursor: disabled ? 'default' : 'pointer' } }, text)
      const children = [row('settings', '设置', () => {
        menuStore.close()
        // 直接落到小沐自己的设置页，不停在设置首页。
        void openDshSettings({ document, section: SETTINGS_SECTION }).then(via => { if (via === 'none') console.warn('muche menu: settings entry unavailable') })
      }),
        row('desktop', label, () => { menuStore.close(); void runtimeRequest('/api/muche/desktop', { action }) }, !available || busy)]
      if (desktop?.text || desktop?.progress) children.push(h('div', { key: 'status', style: { padding: '4px 10px', fontSize: 11 } }, desktop.progress || desktop.text))
      if (!available) children.push(row('chat', '打开聊天面板', () => { menuStore.close(); panelStore.openPanel() }))
      return h(React.Fragment, null,
        h('div', { onClick: () => menuStore.close(), style: { position: 'fixed', inset: 0, zIndex: 1199, background: 'transparent' } }),
        h('div', { ref: menuRef, role: 'menu', 'aria-label': '小沐', 'data-muche-menu': '', style: { position: 'fixed', left: Math.max(8, Math.min(menu.anchor.left, window.innerWidth - 216)), bottom: window.innerHeight - menu.anchor.top + 8, width: 208, zIndex: 1200, background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: 6 } }, children))
    }

    // ── 聊天面板 ──
    function ChatPanel() {
      const open = usePanelOpen()
      const runtime = useRuntime()
      const problem = runtime.problem
      const contextKey = runtime.context ? runtime.context.runtimeId + ':' + runtime.context.generation : ''
      const [msgs, setMsgs] = React.useState([])
      const [hasMore, setHasMore] = React.useState(false)
      const [olderCursor, setOlderCursor] = React.useState(null)
      const [loadingOlder, setLoadingOlder] = React.useState(false)
      const [input, setInput] = React.useState('')
      // 语音状态只用于提示与按钮文案；真正的录音会话在 voiceRef 里（Alt+Q/Alt+Z 直接读它）。
      const [voiceState, setVoiceState] = React.useState('idle')
      const voiceRef = React.useRef(null)
      // 在途回复只是一个提示状态：输入框永不为它禁用，连续追发由后端合并语义承接。
      const [thinking, setThinking] = React.useState(false)
      const [pendingImages, setPendingImages] = React.useState([])
      const fileRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const [loading, setLoading] = React.useState(false)
      // 瞬时提示（发送/刷新/翻页失败、输入不合规）：一行原位显示，不升级横幅。
      // Deduplication suppresses the same cause only, not unrelated failures.
      const [inline, setInline] = React.useState(null)
      // 真空寂静：两边都没消息时空白页，不建目录、不插行、不报错。
      const [reachedStart, setReachedStart] = React.useState(false)
      const [quotaUntil, setQuotaUntil] = React.useState(0)
      const [pos, setPos] = React.useState(null)
      const listRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const preserveRef = React.useRef(null)
      // 底部跟随：开局/新消息默认钉底；用户手动上划即松开（不再抢滚），
      // 滑回底部自动恢复跟随。翻页（preserve）期间以位置保持优先。
      const bottomRef = React.useRef(null)
      const stickRef = React.useRef(true)
      // 在途登记：同一用户可有多条消息等回复，各按 message_id 独立清账。
      const inflightRef = React.useRef(new Set())
      // 过期图：服务端 3 天删原图后 /image 404，加载失败即记，改显占位。
      const failedImgsRef = React.useRef(new Set())
      const markImgFailed = (src) => {
        if (!src || failedImgsRef.current.has(src)) return
        failedImgsRef.current.add(src)
        setMsgs(renderMerged(baseRef.current))
      }
      const noticesRef = React.useRef(new Map()) // Per-message failures, bounded and never persona speech.
      // 本轮语音回复的 WAV base64（只留在内存里，用于"重播这条语音"，不落盘、不进历史）。
      const voiceClipsRef = React.useRef(new Map())
      const quotaUntilRef = React.useRef(0)
      const setQuota = (ms) => { quotaUntilRef.current = ms; setQuotaUntil(ms) }
      const failureNotice = () => ({ kind: 'operation', text: '这条消息暂时没处理完，请稍后重试' })
      const withSticky = (rows) => {
        const remaining = new Map(noticesRef.current)
        const result = []
        for (const row of rows) {
          result.push(row)
          const id = row.mid || row.delivery_id
          if (id && remaining.has(id)) { result.push(remaining.get(id)); remaining.delete(id) }
        }
        return [...result, ...remaining.values()]
      }
      const stickNotice = (failure, ts, mid) => {
        noticesRef.current.set(mid || 'operation', { role: 'system', content: failure.text, inner_thought: '', ts, notice: true, failure, mid })
        if (noticesRef.current.size > 50) noticesRef.current.delete(noticesRef.current.keys().next().value)
      }
      // All call sites report facts here. The shared classifier chooses category/text;
      // structural facts arrive in authoritative snapshots, not in a second mutable store.
      const reportFailure = (fact, { operation = 'request', ts, mid } = {}) => {
        if (!fact || fact.stale || fact.code === STALE_RUNTIME) return
        const failure = classifyFailure(fact)
        if (failure.kind === 'quota') {
          const until = Date.parse(fact.reset_at)
          if (Number.isFinite(until) && until > Date.now()) setQuota(until)
          return
        }
        if (isSameProblem(failure, runtimeStore.getSnapshot().problem)) return
        if (operation === 'message') {
          stickNotice(failure, ts || new Date().toISOString(), mid)
          setMsgs(renderMerged(baseRef.current))
        } else setInline({ ...failure, operation: failure.kind === 'input' ? 'input' : operation })
      }
      const previousProblemRef = React.useRef(null)
      React.useEffect(() => {
        const previous = previousProblemRef.current
        previousProblemRef.current = problem
        if (!previous || isSameProblem(previous, problem)) return
        setInline((current) => isSameProblem(current, previous) ? null : current)
        let changed = false
        for (const [id, notice] of noticesRef.current) {
          if (isSameProblem(notice.failure, previous)) { noticesRef.current.delete(id); changed = true }
        }
        if (changed) setMsgs(renderMerged(baseRef.current))
      }, [problem])
      // 显示合并（服务端确认态＋在途覆盖层）：base 是服务端页缓存，
      // overlay 是未确认行（乐观用户行/待收账 reply/主动行）。合并渲染，
      // 整页替换不再吞在途；overlay 被 base 认领（ingress 精确优先，
      // 同角色同内容次之）或超时退役。
      const baseRef = React.useRef([])
      const overlayRef = React.useRef([])
      const overlaySeqRef = React.useRef(0)
      const syncSeqRef = React.useRef(0)
      const overlayCovered = (o, base) => {
        if (!o || typeof o !== 'object' || o.role === 'system') return false
        // 精确认领：用户乐观行带客户端 message_id，服务端 ingress 对上即退役。
        if (o.mid && base.some((b) => b.delivery_id && b.delivery_id === o.mid)) return true
        const content = typeof o.content === 'string' ? o.content : ''
        if (content && base.some((b) => b.role === o.role && b.content === content)) return true
        if (!content) {
          const ot = Date.parse(o.ts)
          if (Number.isFinite(ot) && base.some((b) => {
            if (b.role !== o.role) return false
            if (!((b.medium === 'image') || (Number(b.image_count) > 0))) return false
            const bt = Date.parse(b.ts)
            return Number.isFinite(bt) && Math.abs(bt - ot) < 10 * 60 * 1000
          })) return true
        }
        const born = Date.parse(o.ts)
        if (Number.isFinite(born) && (Date.now() - born) > 180000
          && o.birthSync !== undefined && syncSeqRef.current > o.birthSync) return true
        return false
      }
      const renderMerged = (base) => {
        const rows = [...(base || [])]
        for (const o of overlayRef.current) {
          if (overlayCovered(o, base)) continue
          rows.push(o)
        }
        rows.sort((a, b) => {
          const ta = Date.parse(a.ts)
          const tb = Date.parse(b.ts)
          if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0
          return ta - tb
        })
        return withSticky(rows)
      }
      const overlayAdd = (rows) => {
        const list = Array.isArray(rows) ? rows : [rows]
        for (const r of list) {
          if (!r || typeof r !== 'object') continue
          overlaySeqRef.current += 1
          overlayRef.current.push({ ...r, overlayKey: 'o' + Date.now() + '-' + overlaySeqRef.current, birthSync: syncSeqRef.current })
        }
        setMsgs(renderMerged(baseRef.current))
      }
      const reconcileOverlay = () => {
        const base = baseRef.current
        const kept = overlayRef.current.filter((o) => !overlayCovered(o, base))
        if (kept.length !== overlayRef.current.length) overlayRef.current = kept
      }
      // 语音轮的占位气泡在发送时还不知道内容；服务端转写回来后按 mid 原地补齐。
      const updateOverlay = (mid, patch) => {
        let changed = false
        for (const row of overlayRef.current) if (row.mid === mid) { Object.assign(row, patch); changed = true }
        if (changed) setMsgs(renderMerged(baseRef.current))
      }
      // 后端在语音轮返回本轮 WAV base64（直放）；播放失败只是没有声音，不升级成故障。
      const playVoice = (audio) => {
        if (!audio || typeof Audio === 'undefined') return
        try { new Audio('data:audio/wav;base64,' + audio).play().catch(() => {}) } catch { /* 忽略播放失败 */ }
      }

      const handleHttpReply = (res, nowIso, mid) => {
        if (res?.stale) return
        settleInflight(mid)
        if (!res?.ok) { reportFailure(res, { operation: 'message', ts: nowIso, mid }); return }
        if (noticesRef.current.delete(mid)) setMsgs(renderMerged(baseRef.current))
        // 语音轮：用户气泡的内容是服务端转写，替换发送时的占位；回复音频直放并可重播。
        if (res.transcript) updateOverlay(mid, { content: res.transcript })
        if (res.audio) { voiceClipsRef.current.set(mid, res.audio); playVoice(res.audio) }
        const parts = (res.messages || []).map((t) => ({ role: 'assistant', content: String(t), inner_thought: res.inner_thought || '', ts: nowIso, voice: Boolean(res.audio), voiceKey: res.audio ? mid : '' }))
        if (res.degraded && parts.length === 0 && !res.superseded && !res.waiting_for_decision) {
          reportFailure(failureNotice(), { operation: 'message', ts: nowIso, mid })
        } else if (parts.length > 0) overlayAdd(parts)
      }

      const normalize = (rows) => (rows || []).map((m) => ({
        role: m.role === 'system' ? 'system' : m.role === 'user' ? 'user' : 'assistant',
        content: m.content || '',
        inner_thought: m.inner_thought || '',
        ts: m.created_at || '',
        id: m.id || '',
        medium: m.medium || 'text',
        image_count: Number(m.image_count) || 0,
        delivery_id: typeof m.delivery_id === 'string' ? m.delivery_id : (typeof m.ingress_id === 'string' ? m.ingress_id : ''),
        vision: typeof m.vision_descriptions === 'string' ? m.vision_descriptions : '',
      }))

      // 附图选择:格式、数量和字节强校验仍由后端 Vision Owner 判定；前端只做预检。
      const pickFiles = (files) => {
        const list = Array.from(files || [])
        if (!list.length) return
        setInline((current) => current?.operation === 'input' ? null : current)
        const okTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
        for (const f of list) {
          if (pendingImages.length >= VISION_PREFLIGHT_MAX_IMAGES) {
            reportFailure({ kind: 'input', text: `最多发 ${VISION_PREFLIGHT_MAX_IMAGES} 张图` })
            break
          }
          if (okTypes.indexOf(f.type) < 0) {
            reportFailure({ kind: 'input', text: '只支持 JPEG/PNG/GIF/WebP' })
            continue
          }
          if (f.size > VISION_PREFLIGHT_MAX_BYTES) {
            reportFailure({ kind: 'input', text: `单张图最大 ${VISION_PREFLIGHT_MAX_BYTES / (1024 * 1024)}M` })
            continue
          }
          const reader = new FileReader()
          const context = runtimeStore.context()
          reader.onload = () => {
            if (context && !runtimeStore.accepts(context)) return
            setPendingImages((prev) => prev.length >= VISION_PREFLIGHT_MAX_IMAGES ? prev : [...prev, String(reader.result || '')])
          }
          reader.readAsDataURL(f)
        }
      }

      // SSE carries real backend messages. Per-message HTTP results/frames settle their
      // own inflight IDs; no synthetic persona reply or automatic replay is fabricated.
      const settleInflight = (mid) => {
        if (mid) inflightRef.current.delete(mid)
        if (inflightRef.current.size === 0) setThinking(false)
      }
      React.useEffect(() => {
        const off = runtimeStore.subscribeFrames((data) => {
          const nowIso = typeof Date !== 'undefined' ? new Date().toISOString() : ''
          if (data.type === 'proactive') {
            const parts = (data.messages || []).map((t) => ({
              role: 'assistant', content: String(t), inner_thought: data.inner_thought || '', ts: nowIso,
            }))
            if (parts.length > 0) {
              overlayAdd(parts)
              panelStore.bumpUnread()
            }
          } else if (data.type === 'reply') {
            settleInflight(data.message_id)
            if (data.duplicate) return
            if (noticesRef.current.delete(data.message_id)) setMsgs(renderMerged(baseRef.current))
            const parts = (data.messages || []).map((t) => ({
              role: 'assistant', content: String(t), inner_thought: data.inner_thought || '', ts: nowIso,
            }))
            if (data.degraded && parts.length === 0 && !data.superseded && !data.waiting_for_decision) {
              reportFailure(failureNotice(), { operation: 'message', ts: nowIso, mid: data.message_id })
            } else if (parts.length > 0) {
              overlayAdd(parts)
            }
          } else if (data.type === 'dialogue_updated') {
            // 对话更新广播——增量 20 条归一，显示最新消息与回复
            refreshNew()
          } else if (data.type === 'error' && data.message_id && inflightRef.current.has(data.message_id)) {
            settleInflight(data.message_id)
            reportFailure(data, { operation: 'message', ts: nowIso, mid: data.message_id })
          }
        })
        return off
      }, [])

      React.useEffect(() => {
        if (!quotaUntil) return
        const timer = setInterval(() => setQuotaUntil((v) => (v && v <= Date.now() ? 0 : v)), 15000)
        return () => clearInterval(timer)
      }, [quotaUntil])

      // 输入框焦点由面板自己维护：输入框永不为在途回复禁用，
      // 面板打开且不在额度禁用期时补回 focus，发送后免重新点一次输入框。
      React.useEffect(() => {
        if (!open) return
        if (quotaUntil > Date.now()) return
        const el = inputRef.current
        if (el && typeof el.focus === 'function') el.focus()
      }, [open, quotaUntil])

      // 拉取最新历史：打开面板 / dialogue_updated 广播触发。
      // 服务端直读：首屏单页 50 条，绝不全量；增量 20 条小批量按 id 归一；
      // 上翻游标前插，has_more=false 即停；dialogue_updated 到才拉，不轮询。
      const fetchNew = React.useCallback(() => runtimeRequest('/api/muche/history?limit=20'), [])
      // 首屏：单页 50 条进 base，在途 overlay 合并渲染（认领退役）。
      // 真空即寂静：空页不写任何说明，与身份失败的错误码区分开。
      const loadHistory = React.useCallback(() => {
        return runtimeRequest('/api/muche/history?limit=50').then((res) => {
          if (res?.stale) return false
          if (!res?.ok) { reportFailure(res, { operation: 'history' }); return false }
          const page = normalize(res.messages)
          baseRef.current = page
          reconcileOverlay()
          setMsgs(renderMerged(page))
          setHasMore(!!res.has_more)
          setOlderCursor(typeof res.next_before === 'string' && res.next_before ? res.next_before : null)
          if (!res.has_more) setReachedStart(true)
          setInline((current) => current?.operation === 'history' ? null : current)
          syncSeqRef.current += 1
          return true
        })
      }, [])
      // 增量刷新：20 条小批量与内存 base 按 id 归一（不重拉全页）；
      // Failure retains current history and reports a typed operation notice.
      const refreshNew = React.useCallback(() => {
        return fetchNew().then((delta) => {
          if (delta?.stale) return false
          if (!delta.ok) { reportFailure(delta, { operation: 'history' }); return false }
          setInline((current) => current?.operation === 'history' ? null : current)
          const rows = normalize(delta.messages)
          if (rows.length > 0) {
            const known = new Set(baseRef.current.map((m) => m.id))
            const fresh = rows.filter((m) => m.id && !known.has(m.id))
            if (fresh.length > 0) {
              const merged = [...baseRef.current, ...fresh]
              merged.sort((a, b) => {
                const ta = Date.parse(a.ts)
                const tb = Date.parse(b.ts)
                if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0
                return ta - tb
              })
              baseRef.current = merged.slice(-200)
            }
            reconcileOverlay()
            setMsgs(renderMerged(baseRef.current))
          }
          syncSeqRef.current += 1
          return true
        })
      }, [fetchNew])
      const authFpRef = React.useRef('')
      React.useEffect(() => {
        if (!contextKey) return
        if (authFpRef.current && authFpRef.current !== contextKey) {
          baseRef.current = []
          overlayRef.current = []
          noticesRef.current.clear()
          inflightRef.current.clear()
          setMsgs([]); setThinking(false); setInline(null)
          setInput(''); setPendingImages([]); setQuota(0)
          setHasMore(false); setOlderCursor(null); setReachedStart(false); setLoadingOlder(false)
          failedImgsRef.current.clear(); preserveRef.current = null
          if (olderTimerRef.current) { clearTimeout(olderTimerRef.current); olderTimerRef.current = null }
        }
        authFpRef.current = contextKey
        if (!open) return
        let cancelled = false
        setLoading(true)
        stickRef.current = true
        setReachedStart(false)
        setOlderCursor(null)
        loadHistory().then(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
      }, [open, contextKey, loadHistory])
      // Reopening an event stream does not replay chat history. Reconcile against the
      // server history once on receive recovery, instead of polling or fabricating messages.
      const wasOnlineRef = React.useRef(false)
      React.useEffect(() => {
        const wasOnline = wasOnlineRef.current
        wasOnlineRef.current = runtime.phase === 'online'
        if (!wasOnline && runtime.phase === 'online' && open) void refreshNew()
      }, [runtime.phase, open, refreshNew])

      // 钉底（OI-078 开局即最新）：像素滚动在动画/图片后载时必漂移，
      // 改用末尾哨兵 scrollIntoView＋rAF（等一帧布局落定）；图片 onLoad 后
      // 若仍在跟随再钉一次。用户手动上划即松跟随（onScroll 反馈）。
      const pinToBottom = () => {
        const anchor = bottomRef.current
        if (!anchor) return
        const go = () => {
          try { anchor.scrollIntoView({ block: 'end' }) } catch (e) { /* 忽略 */ }
        }
        if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => requestAnimationFrame(go))
        else go()
      }
      const onListScroll = () => {
        const el = listRef.current
        if (!el) return
        // 距底 40px 内算"在底部"：容差防缩放/舍入抖动。
        stickRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40
      }
      const onHistoryImageLoad = () => {
        if (stickRef.current) pinToBottom()
      }
      React.useEffect(() => {
        const el = listRef.current
        if (!el) return
        if (preserveRef.current) {
          const p = preserveRef.current
          preserveRef.current = null
          el.scrollTop = el.scrollHeight - p.prevHeight + p.prevScrollTop
        } else if (stickRef.current) {
          pinToBottom()
        }
      }, [msgs])

      const olderTimerRef = React.useRef(null)
      React.useEffect(() => () => { if (olderTimerRef.current) clearTimeout(olderTimerRef.current) }, [])
      const loadOlder = () => {
        // 游标前插：用 olderCursor 向旧取一页；has_more=false 即停不再发。
        // 300ms 尾防抖：快速滚动只打最后一枪。
        if (loadingOlder || (!hasMore && reachedStart)) return
        if (olderTimerRef.current) return
        olderTimerRef.current = setTimeout(() => { olderTimerRef.current = null }, 300)
        setLoadingOlder(true)
        const el = listRef.current
        const prevHeight = el ? el.scrollHeight : 0
        const prevScrollTop = el ? el.scrollTop : 0
        preserveRef.current = { prevHeight, prevScrollTop }
        const cursor = olderCursor
        if (!cursor) {
          // 有更多却无游标（服务端契约外）：不再发请求，直接探底。
          setReachedStart(true)
          setLoadingOlder(false)
          preserveRef.current = { prevHeight, prevScrollTop }
          return
        }
        runtimeRequest('/api/muche/history?limit=50' + (cursor ? '&before=' + encodeURIComponent(cursor) : '')).then((res) => {
          if (res?.stale) return
          if (res && res.ok) {
            const rows = normalize(res.messages)
            const known = new Set(baseRef.current.map((m) => m.id))
            const fresh = rows.filter((m) => m.id && !known.has(m.id))
            if (fresh.length > 0) {
              const merged = [...fresh, ...baseRef.current]
              baseRef.current = merged.slice(-200)
              reconcileOverlay()
              setMsgs(renderMerged(baseRef.current))
            }
            setHasMore(!!res.has_more)
            setOlderCursor(typeof res.next_before === 'string' && res.next_before ? res.next_before : null)
            if (!res.has_more) setReachedStart(true)
            syncSeqRef.current += 1
            setLoadingOlder(false)
            preserveRef.current = { prevHeight, prevScrollTop }
          } else {
            setLoadingOlder(false)
            if (res?.code === 'CURSOR_INVALID') void loadHistory()
            else reportFailure(res, { operation: 'history' })
          }
        }, () => {
          setLoadingOlder(false)
          reportFailure({ kind: 'operation', text: '加载更早的消息失败，请重试' }, { operation: 'history' })
        })
      }

      // 唯一的聊天上行：文字、图片、语音都从这里发，差别只在带了哪个字段。
      // 返回 false 表示这一刻还不能发（没有运行上下文 / 额度用尽），由调用方决定怎么提示。
      const postChat = ({ text = '', images = [], audio = '', optimisticText = '' }) => {
        if (!runtimeStore.context()) return false
        if (quotaUntilRef.current > Date.now()) return false
        const nowIso = typeof Date !== 'undefined' ? new Date().toISOString() : ''
        // HTTP is the only chat uplink; message_id is stable for this operation.
        const mid = runtimeStore.newId('m')
        overlayAdd([{ role: 'user', content: optimisticText, inner_thought: '', ts: nowIso, previews: images, mid, medium: audio ? 'voice' : 'text' }])
        // 不锁输入框：连续追发由后端合并语义承接；在途只做提示。
        setThinking(true)
        inflightRef.current.add(mid)
        runtimeRequest('/api/muche/chat', {
          text, message_id: mid,
          images: images.length ? images : undefined,
          audio: audio || undefined,
        }).then((res) => handleHttpReply(res, nowIso, mid))
        return true
      }

      const send = () => {
        const text = input.trim()
        const images = pendingImages.slice(0, VISION_PREFLIGHT_MAX_IMAGES)
        if ((!text && !images.length)) return
        if (!runtimeStore.context()) return
        if (quotaUntilRef.current > Date.now()) return
        setInput('')
        setPendingImages([])
        setInline((current) => current?.operation === 'input' ? null : current)
        postChat({ text, images, optimisticText: text })
        if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
      }

      const bubble = (m, i, showTime) => {
        const mine = m.role === 'user'
        const previews = Array.isArray(m.previews) ? m.previews : []
        const histCount = !previews.length && mine && m.medium === 'image' && m.image_count > 0 && m.id
          ? Math.min(m.image_count, 3) : 0
        const histUrls = []
        for (let k = 0; k < histCount; k++) {
          histUrls.push('/api/muche/image?id=' + encodeURIComponent(m.id) + '&index=' + k)
        }
        const imgUrls = previews.length ? previews : histUrls
        const expiredVision = typeof m.vision === 'string' ? m.vision : ''
        return h('div', { key: i },
          showTime ? h('div', {
            style: { textAlign: 'center', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', margin: '6px 0 10px' },
          }, fmtTime(m.ts)) : null,
          h('div', { style: { display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 10 } },
            mine ? null : h('div', {
              style: {
                width: 28, height: 28, borderRadius: '50%', flex: 'none', marginRight: 8,
                background: 'var(--dsw-alias-interactive-bg-hover)',
                color: 'var(--dsw-alias-label-primary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              },
            }, h(PersonIcon, { size: 16 })),
            h('div', { style: { maxWidth: '72%' } },
              // 面板不显示内心独白(💭 行移除)。
              // inner_thought 字段与赋值链路保留(数据照常解析入库,恢复显示只需加回渲染)。
              imgUrls.length && mine ? h('div', { style: { marginBottom: m.content ? 6 : 0 } },
                imgUrls.map((src, k) => (failedImgsRef.current.has(src)
                  ? h('div', {
                    key: 'imgx' + k,
                    style: { width: '100%', borderRadius: 8, padding: '10px 12px', marginBottom: k + 1 < imgUrls.length ? 6 : 0, fontSize: 13, lineHeight: '18px', background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' },
                  }, '图片已过期' + (expiredVision ? '：' + expiredVision : ''))
                  : h('img', {
                    key: 'img' + k, src,
                    onLoad: onHistoryImageLoad,
                    onError: () => markImgFailed(src),
                    style: { width: '100%', borderRadius: 8, display: 'block', marginBottom: k + 1 < imgUrls.length ? 6 : 0 },
                  }))),
              ) : null,
              m.content ? h('div', {
                style: {
                  display: 'inline-block', padding: '8px 12px', borderRadius: 12,
                  fontSize: 14, lineHeight: '20px', wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap',
                  background: mine ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-button-ghost-active-fill)',
                  color: mine ? '#fff' : 'var(--dsw-alias-label-primary)',
                },
              }, m.content) : null,
              // 语音轮：这条回复是语音，给一个可重播的标记（自动直放之外，用户还能再听一遍）。
              m.voice ? h('button', {
                type: 'button', 'aria-label': '重播这条语音', title: '重播这条语音',
                onClick: () => playVoice(voiceClipsRef.current.get(m.voiceKey)),
                style: {
                  display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: m.content ? 6 : 0,
                  padding: '4px 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
                  background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer',
                },
              }, '🔊 语音') : null,
            ),
          ),
        )
      }

      const rows = []
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]
        if (m.notice && isSameProblem(m.failure, problem)) continue
        if (m.notice) {
          rows.push(h('div', { key: 'notice-' + i, role: 'status', style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8 } }, '⚠ ' + m.content))
          continue
        }
        const key = (m && (m.overlayKey || m.id)) || i
        let showTime = false
        if (i === 0) showTime = true
        else {
          const gap = gapMinutes(msgs[i - 1].ts, m.ts)
          if (gap === null || gap > 2) showTime = true
        }
        if (m.role === 'system') {
          rows.push(h('div', { key, role: 'status', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 8 } }, m.content))
        } else rows.push(bubble(m, key, showTime))
      }

      // ── 语音输入：Alt+Q 开始 / 再按一次结束并发送，Alt+Z 取消 ──
      // 录音在本页（麦克风权限与键盘焦点都在这），转写在服务端：POST /chat 的 audio 字段。
      // 前端只把采到的任意采样率收敛成后端认的 16 kHz 单声道 PCM16 WAV（见 ./voice.js）。
      const releaseVoice = () => {
        const session = voiceRef.current
        voiceRef.current = null
        if (!session) return null
        try { session.processor.disconnect() } catch { /* 已断开 */ }
        try { session.source.disconnect() } catch { /* 已断开 */ }
        try { session.gain.disconnect() } catch { /* 已断开 */ }
        for (const track of session.stream.getTracks()) track.stop()
        Promise.resolve(session.context.close()).catch(() => {})
        return session
      }
      const cancelVoice = () => { releaseVoice(); setVoiceState('idle') }
      const startVoice = async () => {
        // 录音不等运行上下文：窗口刚打开时连接还在建，先让人说话，发送前再校验（见 postChat）。
        if (voiceRef.current) return
        const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
        if (!media || typeof media.getUserMedia !== 'function') { setInline({ kind: 'operation', text: '当前环境无法录音' }); return }
        try {
          const stream = await media.getUserMedia({ audio: true })
          const AudioContextCtor = window.AudioContext || window.webkitAudioContext
          const context = new AudioContextCtor()
          const source = context.createMediaStreamSource(stream)
          const processor = context.createScriptProcessor(4096, 1, 1)
          const gain = context.createGain()
          gain.gain.value = 0 // 只为让处理器持续触发，不要把麦克风回放到扬声器
          const chunks = []
          processor.onaudioprocess = (event) => {
            const buffer = event.inputBuffer
            const channels = []
            for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(new Float32Array(buffer.getChannelData(c)))
            chunks.push(downmix(channels))
          }
          source.connect(processor)
          processor.connect(gain)
          gain.connect(context.destination)
          voiceRef.current = { stream, context, source, processor, gain, chunks, sampleRate: context.sampleRate }
          setVoiceState('recording')
        } catch (error) {
          setInline({ kind: 'operation', text: '无法使用麦克风，请检查系统权限' })
          setVoiceState('idle')
        }
      }
      const sendVoice = () => {
        const session = releaseVoice()
        setVoiceState('idle')
        if (!session) return
        const samples = session.chunks.reduce((total, chunk) => total + chunk.length, 0)
        const durationMs = session.sampleRate > 0 ? (samples / session.sampleRate) * 1000 : 0
        if (!samples) { setInline({ kind: 'operation', text: '没有录到声音，请重试' }); return }
        if (durationMs < MIN_VOICE_MS) { setInline({ kind: 'operation', text: '说话太短，这条没有发送' }); return }
        const sent = postChat({ audio: encodeRecording({ chunks: session.chunks, sampleRate: session.sampleRate }), optimisticText: '🎤 语音' })
        if (!sent) setInline({ kind: 'operation', text: '还没有连上小沐，这条语音没发出去' })
      }
      // 桌面级语音：全局 Alt+Q/Alt+Z 由 Electron 主进程转发进来（聊天框不用打开、不用聚焦）。
      // 按一下开始、再按一下发送；太短的录音由 sendVoice 按误触丢弃。
      React.useEffect(() => {
        const bridge = window.mucheDesktopChat
        if (!bridge?.onVoiceCommand) return undefined
        return bridge.onVoiceCommand((payload) => {
          const command = payload && typeof payload === 'object' ? payload.command : payload
          if (command === 'voice-start') { void startVoice(); return }
          if (command === 'voice-stop') { sendVoice(); return }
          if (command === 'voice-cancel') cancelVoice()
        })
      }, [])
      React.useEffect(() => { window.mucheDesktopChat?.reportVoiceState?.(voiceState) }, [voiceState])
      // 快捷键只在面板打开时生效，且不做全局注册：不会抢占别的软件的 Alt+Q。
      React.useEffect(() => {
        if (!open) return
        const onKey = (event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.code === 'KeyQ') {
            event.preventDefault(); event.stopPropagation()
            if (voiceRef.current) sendVoice(); else void startVoice()
            return
          }
          if (event.code === 'KeyZ' && voiceRef.current) {
            event.preventDefault(); event.stopPropagation()
            cancelVoice()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [open])

      if (!open) return null

      const onDragStart = (e) => {
        const panel = panelRef.current
        if (!panel) return
        const rect = panel.getBoundingClientRect()
        dragRef.current = { sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top }
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
      }
      const onDragMove = (e) => {
        const d = dragRef.current
        if (!d) return
        setPos({ left: d.left + (e.clientX - d.sx), top: d.top + (e.clientY - d.sy) })
      }
      const onDragEnd = () => { dragRef.current = null }

      // 拖拽只有一套机制，两个手柄共用：顶部标题栏与底部拖拽条。
      // 顶部被顶出可视区时底部仍可把面板拖回。
      const dragHandle = desktopChat ? {} : {
        onPointerDown: onDragStart, onPointerMove: onDragMove,
        onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
      }

      return h('div', {
        ref: panelRef,
        'data-muche-desktop-chat': desktopChat ? '' : undefined,
        style: {
          position: 'fixed',
          ...(desktopChat ? { inset: 0 } : pos ? { left: pos.left, top: pos.top } : { right: 24, bottom: 24 }),
          zIndex: 1200,
          width: desktopChat ? '100%' : 380, height: desktopChat ? '100%' : 560, display: 'flex', flexDirection: 'column',
          background: 'var(--dsw-alias-bg-base)',
          border: desktopChat ? 'none' : '1px solid var(--dsw-alias-border-l1)', borderRadius: desktopChat ? 0 : 16,
          boxShadow: 'var(--dsw-shadow-lv2)', overflow: 'hidden',
          pointerEvents: 'auto',
        },
      },
        h('div', {
          ...dragHandle,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            cursor: desktopChat ? 'default' : 'grab', userSelect: 'none', touchAction: 'none',
          },
        },
          h('span', { style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '小沐'),
          // The title consumes the synchronized runtime projection, never bridge state.
          h('span', {
            title: runtime.phase === 'online' ? '能和小沐聊天' : runtime.phase === 'connecting' ? '正在建立聊天连接' : '当前聊天连接不可用',
            style: {
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              background: runtime.phase === 'online' ? 'var(--dsw-alias-state-success-primary, #52c41a)' : runtime.phase === 'connecting' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-error-primary)',
            },
          }),
          h('span', {
            style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
          }, runtime.label),
          desktopChat ? null : h('button', {
            type: 'button', 'aria-label': '关闭聊天', onClick: () => panelStore.close(),
            onPointerDown: (e) => e.stopPropagation(),
            style: { marginLeft: 'auto', cursor: 'pointer', background: 'none', border: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: 16, padding: '2px 6px' },
          }, '×'),
        ),
        // Structural faults remain outside the scrollable message list.
          problem
            ? h('div', {
              style: {
                padding: '8px 14px', flex: 'none',
                borderBottom: '1px solid var(--dsw-alias-border-l2)',
                fontSize: 12, lineHeight: '18px',
                // config 与 bridge 都是故障（横幅只在故障态渲染），一律错误色。
                // 此前清理废三元时把这个色值一起去掉了，变成普通正文色，看着
                // 不像告警。颜色是唯一区分「这是提示」与「这是故障」的信号。
                color: 'var(--dsw-alias-state-error-primary)',
                background: 'var(--dsw-alias-bg-base)',
              },
            },
              h('div', { role: 'alert' }, '⚠ ' + problem.text),
              problem.advice ? h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-label-secondary)' } }, problem.advice) : null,
            )
            : null,
        h('div', { ref: listRef, onScroll: onListScroll, style: { flex: 1, overflowY: 'auto', padding: 12 } },
          (hasMore || !reachedStart) ? h('div', { style: { textAlign: 'center', marginBottom: 8 } },
            h('button', {
              type: 'button', onClick: loadOlder, disabled: loadingOlder,
              style: { cursor: 'pointer', background: 'none', border: 'none', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
            }, loadingOlder ? '加载中…' : '查看更早的消息'),
          ) : null,
          // An unrelated input/operation notice must not be swallowed by a bridge fault.
          inline && !isSameProblem(inline, problem) ? h('div', { role: 'status', style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary)' } }, '⚠ ' + inline.text) : null,
          loading ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, '加载中…') : null,
          rows,
          h('div', { ref: bottomRef, style: { height: 1 } }),
        ),
        quotaUntil > Date.now() ? h('div', { style: { padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } },
          '消息额度已用完，' + (localHM(new Date(quotaUntil).toISOString()) || '稍后') + ' 后恢复') : null,
        voiceState === 'recording' ? h('div', {
          role: 'status',
          style: { padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-state-business-primary)' },
        }, '正在听… Alt+Q 结束并发送，Alt+Z 取消') : null,
        h('div', { style: { display: 'flex', gap: 8, padding: 10, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
          h('input', {
            ref: fileRef, type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', multiple: true,
            style: { display: 'none' },
            onChange: (e) => { pickFiles(e.target.files); e.target.value = '' },
          }),
          h('button', {
            type: 'button', className: 'muche-btn', title: '发图片（最多3张，单张8M）', 'aria-label': '发图片',
            onClick: () => { if (fileRef.current) fileRef.current.click() },
            disabled: quotaUntil > Date.now(),
            style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
          }, icon.image()),
          h('button', {
            type: 'button', className: 'muche-btn',
            title: voiceState === 'recording' ? '结束并发送（Alt+Q）' : '语音输入（Alt+Q 开始，Alt+Z 取消）',
            'aria-label': voiceState === 'recording' ? '结束并发送' : '语音输入',
            onClick: () => { if (voiceState === 'recording') sendVoice(); else void startVoice() },
            disabled: quotaUntil > Date.now(),
            style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
          }, voiceState === 'recording' ? icon.stop() : icon.mic()),
          h('input', {
            ref: inputRef, className: 'muche-field', value: input,
            placeholder: quotaUntil > Date.now() ? '额度已用完…' : (thinking ? '小沐正在想…（可继续发）' : '发消息…'),
            onChange: (e) => setInput(e.target.value),
            onPaste: (e) => {
              const files = clipboardImageFiles(e.clipboardData)
              if (!files.length) return
              e.preventDefault()
              pickFiles(files)
            },
            onKeyDown: (e) => { if (e.key === 'Enter') send() },
            disabled: quotaUntil > Date.now(),
            style: { flex: 1 },
          }),
          h('button', {
            type: 'button', className: 'muche-btn', onClick: send,
            disabled: quotaUntil > Date.now(), title: '发送', 'aria-label': '发送',
            style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
          }, icon.send()),
        ),
        pendingImages.length ? h('div', { style: { display: 'flex', gap: 6, padding: '0 10px 10px', flexWrap: 'wrap' } },
          pendingImages.map((src, k) => h('div', { key: 'p' + k, style: { position: 'relative', width: 56, height: 56 } },
            h('img', { src, style: { width: 56, height: 56, objectFit: 'cover', borderRadius: 8 } }),
            h('button', {
              type: 'button', onClick: () => setPendingImages((prev) => prev.filter((_, j) => j !== k)),
              style: { position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: 12, lineHeight: '18px' },
            }, '×'),
          )),
        ) : null,
        h('div', {
          ...dragHandle,
          title: '拖动面板',
          style: {
            height: 12, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'grab', userSelect: 'none', touchAction: 'none',
          },
        },
          h('div', { style: { width: 36, height: 4, borderRadius: 2, background: 'var(--dsw-alias-border-l2)' } }),
        ),
      )
    }

    // ── 眼睛图标（官方线性风格：16px/currentColor/1.3 描边） ──
    function EyeIcon({ off }) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
        h('path', {
          d: off
            ? 'M6.6 3.2A6.9 6.9 0 0 1 8 3c4.1 0 6.5 5 6.5 5a9.4 9.4 0 0 1-1.3 1.7M3.6 5.3A9.7 9.7 0 0 0 1.5 8s2.4 5 6.5 5a6.1 6.1 0 0 0 2.9-.8M9.9 6.1a2.2 2.2 0 0 0-3.8 3.8M1.8 1.8l12.4 12.4'
            : 'M1.5 8s2.4-5 6.5-5 6.5 5 6.5 5-2.4 5-6.5 5S1.5 8 1.5 8Z',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        off ? null : h('circle', { cx: 8, cy: 8, r: 2, stroke: 'currentColor', strokeWidth: 1.3, fill: 'none' }),
      )
    }

    // ── 设置页（官方配置镜像读写，不走自建路由） ──

    function MucheSettingsSection() {
      const [backendUrl, setBackendUrl] = React.useState('')
      const [apiKey, setApiKey] = React.useState('')
      const [showKey, setShowKey] = React.useState(false)
      const [status, setStatus] = React.useState('')
      const [testing, setTesting] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const dirtyRef = React.useRef(false)
      const revRef = React.useRef(undefined)
      const testControllerRef = React.useRef(null)
      const scope = useScope()
      const invalidateTest = () => {
        testControllerRef.current?.abort()
        testControllerRef.current = null
        setTesting(false); setStatus('')
      }
      React.useEffect(() => {
        dirtyRef.current = false
        invalidateTest()
        if (!scope) return undefined
        const pull = () => {
          if (dirtyRef.current) return
          let snap = null
          try { snap = scope.getSnapshot() } catch (e) { return }
          const user = (snap && snap.user) || {}
          const value = (snap && snap.value) || {}
          const base = (snap && snap.base) || {}
          // 界面不展示地址：只显示用户自己填过的值（与 base 继承值相同即回空串）。
          const shownBackend = typeof user.backendUrl === 'string' && user.backendUrl && user.backendUrl !== base.backendUrl
            ? user.backendUrl
            : ''
          setBackendUrl(shownBackend)
          setApiKey(typeof value.apiKey === 'string' ? value.apiKey : '')
          revRef.current = snap ? snap.revision : undefined
        }
        pull()
        const off = scope.subscribe(pull)
        return () => { off(); testControllerRef.current?.abort() }
      }, [scope])
      const save = () => {
        if (!scope) {
          setStatus('设置服务未就绪，稍后再试')
          return
        }
        invalidateTest()
        setSaving(true)
        setStatus('')
        // 地址清空＝恢复继承（unset），与旧写路由“只在非空时 patch”同语义；
        // key 恒写（清空即清 key）。一次 mutate 原子提交，revision 做 fence。
        const ops = []
        if (backendUrl.trim()) ops.push({ op: 'set', path: ['backendUrl'], value: backendUrl.trim() })
        else ops.push({ op: 'unset', path: ['backendUrl'] })
        ops.push({ op: 'set', path: ['apiKey'], value: apiKey.trim() })
        Promise.resolve()
          .then(() => scope.mutate(ops, revRef.current))
          .then(() => {
            setSaving(false)
            dirtyRef.current = false
            revRef.current = scope.getSnapshot()?.revision
            setStatus('✓ 已保存')
            // Saved-config change is handled by the host runtime driver.
          })
          .catch((e) => {
            setSaving(false)
            dirtyRef.current = false // 冲突时放开，让订阅拉回最新值
            console.warn('muche settings: save rejected', String(e?.code || e?.name || 'Error'))
            revRef.current = scope.getSnapshot()?.revision
            setStatus(classifyFailure({ kind: 'config' }).text)
          })
      }
      const test = () => {
        invalidateTest()
        const controller = new AbortController()
        testControllerRef.current = controller
        setTesting(true)
        apiPost('/api/muche/health', { backendUrl: backendUrl.trim(), apiKey: apiKey.trim() }, { signal: controller.signal }).then((res) => {
          if (controller.signal.aborted || testControllerRef.current !== controller) return
          testControllerRef.current = null
          setTesting(false)
          const auth = res?.auth, history = res?.history
          if (res?.ok && auth?.ok && history?.ok) setStatus('✓ 配置验证通过')
          else setStatus(classifyFailure(auth && !auth.ok ? auth : history && !history.ok ? history : res || {}).text)
        })
      }
      const row = (label, node) => h('div', { style: { marginBottom: 14 } },
        h('div', { style: { fontSize: 13, marginBottom: 6, color: 'var(--dsw-alias-label-secondary)' } }, label),
        node,
      )
      return h('div', { style: { maxWidth: 520, padding: '8px 0' } },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '小沐接入配置'),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 16 } },
          '填后端地址和 API key（小沐后台生成），保存即用。'),
        row('小沐后端地址', h('div', null,
          h('input', {
            className: 'muche-field', value: backendUrl,
            placeholder: '填小沐后端地址',
            onChange: (e) => { invalidateTest(); dirtyRef.current = true; setBackendUrl(e.target.value) },
          }),
        )),
        row('API key', h('div', { style: { position: 'relative' } },
          h('input', {
            className: 'muche-field', value: apiKey,
            type: showKey ? 'text' : 'password', placeholder: 'muche_…(在小沐后台生成)',
            onChange: (e) => { invalidateTest(); dirtyRef.current = true; setApiKey(e.target.value) },
            style: { paddingRight: 32 },
          }),
          h('button', {
            type: 'button',
            onClick: () => setShowKey((v) => !v),
            title: showKey ? '隐藏' : '显示',
            'aria-label': showKey ? '隐藏 API key' : '显示 API key',
            style: {
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, cursor: 'pointer',
              background: 'none', border: 'none', padding: 0,
              color: 'var(--dsw-alias-label-tertiary)',
            },
          }, h(EyeIcon, { off: showKey })),
        )),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { type: 'button', className: 'muche-btn', onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
          h('button', {
            type: 'button', className: 'muche-btn', onClick: test, disabled: testing,
            style: { background: 'transparent', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)' },
          }, testing ? '测试中…' : '测试连接'),
          h('button', {
            type: 'button', className: 'muche-btn', onClick: () => panelStore.toggle(),
            style: { background: 'transparent', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)' },
          }, '打开聊天面板'),
          status && h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, status),
        ),
      )
    }

    // ── 插件主体 ──
    // 门控：`slots` 经 exports.inject 声明式依赖，Cordis 按声明 park 到就绪再跑
    // apply；此处保留 get 但禁静默返回——缺席即 loud 抛错，进 Boot 页报错而非无声消失。
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) throw new Error('muche-dsh-plugin: required service "slots" is missing (declare inject: [\'slots\', \'configForms\'])')
      const configForms = ctx.get('configForms')
      if (configForms === undefined || typeof configForms.get !== 'function') throw new Error('muche-dsh-plugin: required service "configForms" is missing (declare inject: [\'slots\', \'configForms\'])')

      const offBinding = runtimeStore.subscribe((value) => {
        const ns = value.context?.configNs
        if (ns && scopeStore.namespace !== ns) {
          scopeStore.namespace = ns
          scopeStore.set(configForms.get(ns))
        }
      })
      const onVisible = () => { if (document.visibilityState === 'visible') runtimeStore.ensureConnected() }
      document.addEventListener('visibilitychange', onVisible)
      ctx.effect(() => () => {
        offBinding()
        runtimeStore.dispose()
        document.removeEventListener('visibilitychange', onVisible)
        document.querySelector('style[data-plugin="muche-dsh-plugin"]')?.remove()
      })
      runtimeStore.start()

      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'muche-entry', order: 10, label: '小沐' },
        (props) => h(MucheEntry, { wide: props ? props.wide !== false : true }),
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'muche-chat-panel', order: 5, label: '小沐聊天' },
        () => h(ChatPanel),
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'muche-menu', order: 6, label: '小沐菜单' },
        () => h(MucheMenu),
      ))
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'muche', order: 30, label: SETTINGS_SECTION },
        () => h(MucheSettingsSection),
      ))
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms']
    exports.desktopView = { ChatPanel, start: () => runtimeStore.start(), dispose: () => runtimeStore.dispose() }
    return module.exports
  },
}
if (window.__ModuleLoader__) window.__ModuleLoader__.load(clientDefinition)
