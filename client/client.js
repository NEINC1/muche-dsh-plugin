// muche-dsh-plugin — 客户端入口（浏览器）。
// 形态：左下角「小沐」入口按钮 + 可拖动聊天浮层面板 + 设置页。
// 聊天与同步数据经 /api/muche/* 路由直连后端，不进 dsh agent 循环（零注入）。
// 配置不走自建路由：设置页与面板经官方客户端设置服务（configForms 镜像）
// 读写，存储唯一真源是宿主 profile patch（见 lib/config.js）。
window.__ModuleLoader__.load({
  id: 'muche-dsh-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let React = require('react')

    const h = React.createElement

    // ── 样式 ──
    const CSS = `
      .muche-settings-entry{background:0 0}
      .muche-settings-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .muche-field{box-sizing:border-box;width:100%;height:34px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
      .muche-field:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
      .muche-btn{box-sizing:border-box;height:32px;padding:0 14px;border:none;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;font-size:13px;cursor:pointer}
    `
    if (typeof document !== 'undefined') {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'muche-dsh-plugin'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── 面板共享状态(open + 未读小红点) ──
    const panelStore = {
      open: false,
      unread: 0,
      subs: [],
      toggle() {
        this.open = !this.open
        if (this.open) this.unread = 0
        for (const f of this.subs) f()
      },
      close() { if (this.open) { this.open = false; for (const f of this.subs) f() } },
      bumpUnread() { if (!this.open) { this.unread += 1; for (const f of this.subs) f() } },
      markRead() { if (this.unread !== 0) { this.unread = 0; for (const f of this.subs) f() } },
      subscribe(f) { this.subs.push(f); return () => { this.subs = this.subs.filter((x) => x !== f) } },
    }
    function usePanelOpen() {
      const [open, setOpen] = React.useState(panelStore.open)
      React.useEffect(() => panelStore.subscribe(() => setOpen(panelStore.open)), [])
      return open
    }

    // 额度恢复时刻的本地时分（lib/quota.js 为 node 侧单源；浏览器 loader 只挂
    // 静态模块表，无法相对 require，这里仅做时刻格式化）
    function localHM(iso) {
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return ''
      const d = new Date(t)
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    // ── HTTP 封装（同源 /api/muche/* 路由） ──
    async function apiGet(path) {
      try {
        const r = await fetch(path)
        return await r.json().catch(() => ({ ok: false, error: '响应解析失败' }))
      } catch (e) { return { ok: false, error: '请求失败' } }
    }
    async function apiPost(path, body) {
      try {
        const r = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        return await r.json().catch(() => ({ ok: false, error: '响应解析失败' }))
      } catch (e) { return { ok: false, error: '请求失败' } }
    }

    // ── 后端 WS 长连接（同源代理形态，实测定案） ──
    // 浏览器连本机 dsh 同源代理 /api/muche/ws?token=<apiKey>（经隧道可达），
    // Host 侧 ws-proxy 按配置的 backendUrl（含 /api 前缀，原样保留）透传到后端
    // （铁律:零注入，不进 dsh agent 循环）:
    // 下行:proactive(主动消息,manager 向本用户全连接广播)→ 面板实时弹入 +
    //       未读红点;reply(本连接 user_message 的回复,仅回本连接)。
    // 上行:user_message(聊天迁 WS 契约;HTTP /api/muche/chat 保留为 WS
    //       未就绪时的降级通道——两者同达后端 chat_core,行为同源)。
    // 心跳:25s ping(服务端 60s 无消息断开);断开指数退避重连(≤30s)。
    const wsStore = {
      status: 'idle', // idle | connecting | open | closed
      sock: null,
      listeners: [],
      pingTimer: null,
      reconnectTimer: null,
      attempts: 0,
      cfg: null,
      msgSeq: 0,
      diagSummary: null, // 本机→后端探针结论（人话），失败自诊断一次后填入，面板直显
      diagKey: '', // 探针已跑过的配置指纹（同配置不重复打后端）
      start(cfg) {
        const changed = !!cfg && (this.cfg === null || cfg.apiKey !== this.cfg.apiKey || cfg.backendUrl !== this.cfg.backendUrl)
        this.cfg = cfg || this.cfg
        if (!this.cfg || !this.cfg.apiKey) { this._teardown(); return }
        if (changed && this.sock) {
          // 换 key/地址:断开旧连接,交给 _open 建新连接
          const old = this.sock
          this.sock = null
          try { old.onclose = null; old.close() } catch (e) { /* 忽略 */ }
          if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
        }
        this._open()
      },
      _wsUrl() {
        // 同源代理:浏览器直连 backendUrl 在跨机/隧道
        // 场景会指向用户本机而非服务器;WS 走本插件 Host 的 /api/muche/ws
        // 升级代理(同源经隧道),Host 进程内代理到后端。token 仍取配置 key。
        const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss' : 'ws'
        const host = typeof location !== 'undefined' ? location.host : '127.0.0.1:3080'
        return proto + '://' + host + '/api/muche/ws?token=' + encodeURIComponent(this.cfg.apiKey)
      },
      _open() {
        if (this.sock) return
        this._setStatus('connecting')
        let sock
        try {
          sock = new WebSocket(this._wsUrl())
        } catch (e) {
          // 构造即失败(如 https 页面连 ws:// 的混合内容拦截):记录原因,
          // 面板可见诊断,不再无声重试
          this.lastError = '连接被浏览器拒绝: ' + String(e && e.message ? e.message : e).slice(0, 200)
          this._setStatus('error')
          this._scheduleReconnect()
          return
        }
        this.sock = sock
        // 连接超时:本地/远端黑洞时 onopen 永不触发,status 卡 connecting
        // 导致自愈跳过——10s 未 open 即视为失败,拆除重试
        this.openTimer = setTimeout(() => {
          if (sock.readyState === WebSocket.OPEN) return
          this.lastError = '连接超时（10s 未建立）'
          this.runDiag()
          try { sock.close() } catch (e) { /* onclose 收尾 */ }
        }, 10000)
        sock.onopen = () => {
          if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null }
          this.attempts = 0
          this.lastError = null
          this._setStatus('open')
          this.pingTimer = setInterval(() => {
            try { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'ping' })) } catch (e) { /* 忽略:断连由 onclose 收尾 */ }
          }, 25000)
        }
        sock.onmessage = (ev) => {
          let data = null
          try { data = JSON.parse(ev.data) } catch (e) { return }
          for (const f of this.listeners) { try { f(data) } catch (e) { /* 监听器异常不拖垮分发 */ } }
        }
        sock.onclose = (ev) => {
          if (ev && ev.code && ev.code !== 1000 && ev.code !== 1006) {
            this.lastError = '连接被关闭(code=' + ev.code + ')'
            this.runDiag()
          }
          this._teardown()
          this._scheduleReconnect()
        }
        sock.onerror = (ev) => {
          // 记录错误信息(浏览器 event 可能无 message,尽力而为)
          this.lastError = 'WebSocket 错误' + (ev && ev.message ? ': ' + String(ev.message).slice(0, 200) : '')
          this.runDiag()
          try { sock.close() } catch (e) { /* onclose 收尾 */ }
        }
      },
      // 失败自诊断（排障口）：socket 建连失败时取一次 Host 侧探针，定位
      // “本机→后端”还是“浏览器→本机”。同配置只跑一次（重连退避不重复打
      // 后端）；结论进 diagSummary，面板在“未连接”后直显，无需找日志。
      runDiag() {
        const cfg = this.cfg
        if (!cfg || !cfg.apiKey) return
        const key = cfg.apiKey + '|' + cfg.backendUrl
        if (this.diagKey === key) return
        this.diagKey = key
        try {
          apiGet('/api/muche/ws-diag').then((res) => {
            this.diagSummary = summarizeDiag(res)
            this._setStatus(this.status) // 只触发重渲染，无状态迁移
          }).catch(() => { /* 诊断失败不影响主流程 */ })
        } catch (e) { /* 同上 */ }
      },
      _teardown() {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
        if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null }
        this.sock = null
        this._setStatus('closed')
      },
      _scheduleReconnect() {
        if (this.reconnectTimer) return
        const delay = Math.min(30000, 3000 * Math.pow(2, Math.min(this.attempts, 4)))
        this.attempts += 1
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          if (this.cfg && this.cfg.apiKey) this._open()
        }, delay)
      },
      // 连接自愈:页面级周期检查(30s)。cfg 缺失(官方镜像尚未就绪)则重读
      // 镜像再连;已配置但未连接则补连。保证 muche/dsh 重启后最终恢复。
      ensureConnected() {
        if (this.isOpen()) return
        // connecting 状态若超过 10s(openTimer 已触发 close)会转 closed;
        // 此处兜底:卡在 connecting 且无 sock 则强制重开
        if (this.status === 'connecting' && !this.sock) { this._setStatus('closed'); this._open(); return }
        if (this.status === 'connecting') return
        if (this.cfg && this.cfg.apiKey) {
          this._open()
          return
        }
        syncWsFromScope() // 仍无 key 则下个周期再试
      },
      _setStatus(s) {
        this.status = s
        for (const f of this.listeners) { try { f({ type: '_status', status: s }) } catch (e) { /* 同上 */ } }
      },
      subscribe(f) { this.listeners.push(f); return () => { this.listeners = this.listeners.filter((x) => x !== f) } },
      isOpen() { return this.sock !== null && this.sock.readyState === 1 },
      send(obj) {
        if (!this.isOpen()) return false
        try { this.sock.send(JSON.stringify(obj)); return true } catch (e) { return false }
      },
      newId(prefix) { this.msgSeq += 1; return prefix + '-' + Date.now() + '-' + this.msgSeq },
    }

    // 探针回包翻人话（只读 stage/backend，不碰 token——回包本来就没有）。
    function summarizeDiag(res) {
      if (!res || typeof res !== 'object') return null
      const b = (res && res.backend) || {}
      const where = [b.host || '', b.pathPrefix && b.pathPrefix !== '(根)' ? b.pathPrefix : ''].join('')
      if (res.ok && res.stage === 'backend-reached') {
        return '本机到后端通（后端应答' + (res.status || '?') + '），查浏览器到本机'
      }
      if (res.stage === 'target') return '后端地址配错（' + (where || '空') + '）：' + (res.error || '')
      if (res.stage) return '本机到后端不通（' + res.stage + '）：' + (res.error || '')
      return '探针异常：' + (res.error || '未知')
    }

    // 面板所在页的源（只取协议+主机，不含路径与参数）：WS 与 HTTP 同源，
    // 连不上时把“经什么地址连的”摆出来——主机名写法（127.0.0.1/localhost/
    // 域名）与协议（http/https）是浏览器到本机这一跳的唯一定位。
    function wsVia() {
      try {
        if (typeof location === 'undefined' || !location.host) return ''
        return location.protocol + '//' + location.host
      } catch (e) { return '' }
    }
    function wsViaSuffix() {
      const via = wsVia()
      return via ? '（经' + via + '）' : ''
    }

    // ── 官方配置作用域（configForms 镜像，不自存配置） ──
    // 宿主 Config 在浏览器侧的唯一读取口：快照 { status, value, base, user,
    // revision, writable }，写经 scope.mutate（revision fence），变化经
    // subscribe。命名空间＝宿主 profile 条目 id（apply 里问 /api/muche/status
    // 要唯一真源）。WS 的启动/换连/ key 清除停连全部由此订阅驱动，不再由
    // 设置页保存回调直调（保存与换连解耦：官方表单写入同样触发）。
    const scopeStore = {
      scope: null,
      subs: [],
      set(next) { this.scope = next; for (const f of this.subs) f() },
      subscribe(f) { this.subs.push(f); return () => { this.subs = this.subs.filter((x) => x !== f) } },
    }
    function useScope() {
      const [, force] = React.useState(0)
      React.useEffect(() => scopeStore.subscribe(() => force((n) => n + 1)), [])
      return scopeStore.scope
    }
    // 配置快照 → WS 参数同步（幂等：wsStore.start 内部比对，相同不重连；
    // key 被清空即 teardown，与旧保存回调语义一致）。
    function syncWsFromScope() {
      const s = scopeStore.scope
      if (!s) return
      let snap = null
      try { snap = s.getSnapshot() } catch (e) { return }
      const v = (snap && snap.value) || {}
      wsStore.start({
        backendUrl: typeof v.backendUrl === 'string' ? v.backendUrl : '',
        apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
      })
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

    // ── 聊天式时间 ──
    function fmtTime(iso) {
      if (!iso) return ''
      try {
        if (typeof Date === 'undefined') return String(iso).slice(5, 16)
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return String(iso).slice(5, 16)
        const pad = (n) => (n < 10 ? '0' + n : String(n))
        const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
        const now = new Date()
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
      } catch (e) { return '' }
    }
    function gapMinutes(a, b) {
      try {
        if (!a || !b || typeof Date === 'undefined') return null
        const va = new Date(a).getTime()
        const vb = new Date(b).getTime()
        if (Number.isNaN(va) || Number.isNaN(vb)) return null
        return (vb - va) / 60000
      } catch (e) { return null }
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

    function useWsOpen() {
      const [open, setOpen] = React.useState(wsStore.isOpen())
      React.useEffect(() => wsStore.subscribe(() => setOpen(wsStore.isOpen())), [])
      return open
    }

    function MucheEntry({ wide }) {
      const open = usePanelOpen()
      const unread = useUnread()
      if (!wide) {
        return h('button', {
          type: 'button', onClick: () => panelStore.toggle(),
          title: open ? '小沐面板已打开' : '打开小沐',
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
        type: 'button', onClick: () => panelStore.toggle(),
        title: open ? '小沐面板已打开' : (unread > 0 ? `小沐有 ${unread} 条未读` : '打开小沐'),
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

    // ── 聊天面板 ──
    function ChatPanel() {
      const open = usePanelOpen()
      const wsOpen = useWsOpen()
      const [msgs, setMsgs] = React.useState([])
      const [hasMore, setHasMore] = React.useState(false)
      const [nextBefore, setNextBefore] = React.useState(null)
      const [loadingOlder, setLoadingOlder] = React.useState(false)
      const [input, setInput] = React.useState('')
      // 在途回复只是一个提示状态：输入框永不为它禁用，连续追发由后端合并语义承接。
      const [thinking, setThinking] = React.useState(false)
      const [pendingImages, setPendingImages] = React.useState([])
      const fileRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [quotaUntil, setQuotaUntil] = React.useState(0)
      const [pos, setPos] = React.useState(null)
      const listRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const preserveRef = React.useRef(null)
      // 在途登记：同一用户可有多条消息等回复，各按 message_id 独立清账。
      const inflightRef = React.useRef(new Set())
      const timersRef = React.useRef(new Map())
      const stuckNoticeRef = React.useRef(null) // 报错钉住：历史刷新不刷掉，发新消息才清
      const quotaUntilRef = React.useRef(0)
      const setQuota = (ms) => { quotaUntilRef.current = ms; setQuotaUntil(ms) }
      const failureNotice = () => '⚠️ 这条消息暂时没处理完，请稍后重试'
      // rows 末尾补钉住的报错（loadHistory 整页替换时调用；分页 prepend 不用）。
      const withSticky = (rows) => stuckNoticeRef.current ? [...rows, stuckNoticeRef.current] : rows
      const stickNotice = (content, ts) => {
        stuckNoticeRef.current = { role: 'assistant', content, inner_thought: '', ts }
      }

      const handleHttpReply = (res, nowIso, mid) => {
        settleInflight(mid)
        if (res && !res.ok && res.code === 'message_quota_exhausted') {
          const until = Date.parse(res.reset_at)
          if (Number.isFinite(until) && until > Date.now()) setQuota(until)
        }
        if (res && res.ok) {
          const parts = (res.messages || []).map((t) => ({ role: 'assistant', content: String(t), inner_thought: res.inner_thought || '', ts: nowIso }))
          // 只有明确失败才钉报错：等待中/被合并保持静默（新轮会回）。
          if (res.degraded && parts.length === 0 && !res.superseded && !res.waiting_for_decision) {
            stickNotice(failureNotice(), nowIso)
            parts.push(stuckNoticeRef.current)
          }
          setMsgs((prev) => [...prev, ...parts])
        } else {
          const error = res && res.error ? res.error : '发送失败'
          stickNotice('⚠️ ' + error, nowIso)
          setMsgs((prev) => [...prev, stuckNoticeRef.current])
        }
      }

      const normalize = (rows) => (rows || []).map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content || '',
        inner_thought: m.inner_thought || '',
        ts: m.created_at || '',
        id: m.id || '',
        medium: m.medium || 'text',
        image_count: Number(m.image_count) || 0,
        kind: m.kind || '',
      }))

      // 附图选择:最多 3 张、单张 8M、仅四格式由后端强校验；前端先拦 obvious 的。
      const pickFiles = (files) => {
        const list = Array.from(files || [])
        if (!list.length) return
        setError('')
        const okTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
        for (const f of list) {
          if (pendingImages.length >= 3) {
            setError('最多发 3 张图')
            break
          }
          if (okTypes.indexOf(f.type) < 0) {
            setError('只支持 JPEG/PNG/GIF/WebP')
            continue
          }
          if (f.size > 8 * 1024 * 1024) {
            setError('单张图最大 8M')
            continue
          }
          const reader = new FileReader()
          reader.onload = () => {
            setPendingImages((prev) => prev.length >= 3 ? prev : [...prev, String(reader.result || '')])
          }
          reader.readAsDataURL(f)
        }
      }

      // WS 下行:proactive(主动消息,实时弹入+未读红点) / reply(本连接回复)。
      // 常驻订阅:面板关闭时主动消息照收,只涨红点不弹面板。
      // 在途收账：各条消息按自己的 message_id 独立清账；全部回齐才熄提示。
      // 超时只清自己的账并钉一条报错，不挡后发的消息。
      const settleInflight = (mid) => {
        if (mid) {
          inflightRef.current.delete(mid)
          const timer = timersRef.current.get(mid)
          if (timer) { clearTimeout(timer); timersRef.current.delete(mid) }
        }
        if (inflightRef.current.size === 0) setThinking(false)
      }
      React.useEffect(() => {
        const off = wsStore.subscribe((data) => {
          const nowIso = typeof Date !== 'undefined' ? new Date().toISOString() : ''
          if (data.type === 'proactive') {
            const parts = (data.messages || []).map((t) => ({
              role: 'assistant', content: String(t), inner_thought: data.inner_thought || '', ts: nowIso,
            }))
            if (parts.length > 0) {
              setMsgs((prev) => [...prev, ...parts])
              panelStore.bumpUnread()
            }
          } else if (data.type === 'reply') {
            if (data.duplicate) return
            settleInflight(data.message_id)
            const parts = (data.messages || []).map((t) => ({
              role: 'assistant', content: String(t), inner_thought: data.inner_thought || '', ts: nowIso,
            }))
            if (data.degraded && parts.length === 0 && !data.superseded && !data.waiting_for_decision) {
              stickNotice(failureNotice(), nowIso)
              parts.push(stuckNoticeRef.current)
            } else if (data.degraded === false && parts.length === 0) {
              parts.push({ role: 'assistant', content: '（没有回复）', inner_thought: '', ts: nowIso })
            }
            if (parts.length > 0) setMsgs((prev) => [...prev, ...parts])
          } else if (data.type === 'dialogue_updated') {
            // 对话更新广播——先同步再读本地，显示最新消息与回复
            refreshFromLocal()
          } else if (data.type === 'error' && data.message_id && inflightRef.current.has(data.message_id)) {
            settleInflight(data.message_id)
            if (data.code === 'message_quota_exhausted') {
              const until = Date.parse(data.reset_at)
              if (Number.isFinite(until) && until > Date.now()) setQuota(until)
            }
            const hm = data.code === 'message_quota_exhausted' ? localHM(data.reset_at) : ''
            const text = hm
              ? '消息额度已用完，' + hm + ' 后恢复'
              : '⚠️ ' + (data.error || '处理失败')
            stickNotice('⚠️ ' + text, nowIso)
            setMsgs((prev) => [...prev, stuckNoticeRef.current])
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
      // OI-074 单真源串行：整页替换只发生在确认同步成功之后——同步完成
      // 再读本地，读到的是同步后的新鲜文件；在途行（乐观用户行/reply 行）
      // 与文件内容一致，替换不丢话。同步失败则保留内存现状，下次再收敛。
      // 服务端 history 只作同步源，不直接显示。
      // 同步串行排队：多次广播重叠时按序执行，防并发写本地竞态。
      const syncChainRef = React.useRef(Promise.resolve())
      const triggerSync = React.useCallback(() => {
        const run = syncChainRef.current.then(() => apiPost('/api/muche/sync', {}).then(
          (res) => !!(res && res.ok),
          () => false,
        ))
        // 断链保护：本次失败不影响后续排队。
        syncChainRef.current = run.then(() => undefined, () => undefined)
        return run
      }, [])
      const loadHistory = React.useCallback(() => {
        apiGet('/api/muche/local-history?limit=20').then((res) => {
          if (res && res.ok) {
            // 钉住的报错不受刷新影响，一直显示到发新消息。
            // 本地 reset_mark 行按系统提醒渲染（normalize 保留 kind）。
            setMsgs(withSticky(normalize(res.messages)))
            setHasMore(!!res.has_more)
            setNextBefore(res.next_before || null)
            setError('')
          } else if (res && !res.ok && res.error) {
            // 首装未配 key 时后端回可操作指引：开门即见，不再静默空白。
            setError(res.error)
          }
        }).catch(() => { /* 静默:下次打开/广播再试 */ })
      }, [])
      const refreshFromLocal = React.useCallback(() => {
        return triggerSync().then((ok) => { if (ok) loadHistory() })
      }, [triggerSync, loadHistory])
      React.useEffect(() => {
        if (!open) return
        setLoading(true)
        refreshFromLocal().then(() => setLoading(false))
      }, [open])

      React.useEffect(() => {
        const el = listRef.current
        if (!el) return
        if (preserveRef.current) {
          const p = preserveRef.current
          preserveRef.current = null
          el.scrollTop = el.scrollHeight - p.prevHeight + p.prevScrollTop
        } else {
          el.scrollTop = el.scrollHeight
        }
      }, [msgs])

      const loadOlder = () => {
        // OI-070 本地口径：本地无 before 游标，翻页即 limit 翻倍重读
        // （本地文件全量在机，200 上限内一次到位，无第二套游标）。
        // OI-074：同样等同步成功后再整页替换，失败则保留现状。
        if (loadingOlder || !hasMore) return
        setLoadingOlder(true)
        const el = listRef.current
        const prevHeight = el ? el.scrollHeight : 0
        const prevScrollTop = el ? el.scrollTop : 0
        const nextLimit = Math.min(200, msgs.length + 20)
        triggerSync().then((ok) => {
          if (!ok) { setLoadingOlder(false); return }
          apiGet('/api/muche/local-history?limit=' + nextLimit).then((res) => {
            setLoadingOlder(false)
            if (res && res.ok) {
              preserveRef.current = { prevHeight, prevScrollTop }
              setMsgs(withSticky(normalize(res.messages)))
              setHasMore(!!res.has_more)
              setNextBefore(res.next_before || null)
            }
          }).catch(() => setLoadingOlder(false))
        })
      }

      const send = () => {
        const text = input.trim()
        const images = pendingImages.slice(0, 3)
        if ((!text && !images.length)) return
        if (quotaUntilRef.current > Date.now()) return
        setInput('')
        setPendingImages([])
        // 发新消息即清掉钉住的报错（报错只留到下一次发送）。
        stuckNoticeRef.current = null
        const nowIso = typeof Date !== 'undefined' ? new Date().toISOString() : ''
        setMsgs((prev) => [...prev, { role: 'user', content: text, inner_thought: '', ts: nowIso, previews: images }])
        // 不锁输入框：连续追发由后端合并语义承接；在途只做提示。
        setThinking(true)
        // WS 优先(聊天走 WS 契约);未就绪时 HTTP 降级(同达后端 chat_core)
        const mid = wsStore.newId('m')
        inflightRef.current.add(mid)
        if (wsStore.isOpen()) {
          if (wsStore.send({ type: 'user_message', message_id: mid, message: text, images: images.length ? images : undefined })) {
            // 90s 无 reply/error 视为超时(后端降级兜底也走 reply,正常不会触发)
            timersRef.current.set(mid, setTimeout(() => {
              if (inflightRef.current.has(mid)) {
                settleInflight(mid)
                stickNotice('⚠️ 回复超时,请重试', nowIso)
                setMsgs((prev) => [...prev, stuckNoticeRef.current])
              }
            }, 90000))
            if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
            return
          }
          // isOpen 与实际 send 之间可能发生断线；WS 未确认写入时沿用同一
          // message_id 走 HTTP，同一消息仍由后端 ingress 幂等边界负责。
        }
        apiPost('/api/muche/chat', { text, message_id: mid, images: images.length ? images : undefined }).then((res) => handleHttpReply(res, nowIso, mid))
        if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
      }

      const bubble = (m, i, showTime) => {
        // OI-070 重置留痕：本地 reset_mark 行居中系统提醒，不占用户/小沐气泡。
        if (m.kind === 'reset_mark') {
          return h('div', { key: i },
            h('div', {
              style: { textAlign: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '6px 0 10px' },
            }, m.content || '小沐已被重置'),
          )
        }
        const mine = m.role === 'user'
        const previews = Array.isArray(m.previews) ? m.previews : []
        const histCount = !previews.length && mine && m.medium === 'image' && m.image_count > 0 && m.id
          ? Math.min(m.image_count, 3) : 0
        const histUrls = []
        for (let k = 0; k < histCount; k++) {
          histUrls.push('/api/muche/image?id=' + encodeURIComponent(m.id) + '&index=' + k)
        }
        const imgUrls = previews.length ? previews : histUrls
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
                imgUrls.map((src, k) => h('img', {
                  key: 'img' + k, src,
                  style: { width: '100%', borderRadius: 8, display: 'block', marginBottom: k + 1 < imgUrls.length ? 6 : 0 },
                })),
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
            ),
          ),
        )
      }

      const rows = []
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]
        let showTime = false
        if (i === 0) showTime = true
        else {
          const gap = gapMinutes(msgs[i - 1].ts, m.ts)
          if (gap === null || gap > 2) showTime = true
        }
        rows.push(bubble(m, i, showTime))
      }

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
      const dragHandle = {
        onPointerDown: onDragStart, onPointerMove: onDragMove,
        onPointerUp: onDragEnd, onPointerCancel: onDragEnd,
      }

      return h('div', {
        ref: panelRef,
        style: {
          position: 'fixed',
          ...(pos ? { left: pos.left, top: pos.top } : { right: 24, bottom: 24 }),
          zIndex: 1200,
          width: 380, height: 560, display: 'flex', flexDirection: 'column',
          background: 'var(--dsw-alias-bg-base)',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 16,
          boxShadow: 'var(--dsw-shadow-lv2)', overflow: 'hidden',
          pointerEvents: 'auto',
        },
      },
        h('div', {
          ...dragHandle,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            cursor: 'grab', userSelect: 'none', touchAction: 'none',
          },
        },
          h('span', { style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '小沐'),
          h('span', {
            style: {
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              background: wsOpen ? '#52c41a' : '#fa8c16',
            },
          }),
          h('span', {
            style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
            title: [wsStore.lastError, wsStore.diagSummary, wsVia()].filter(Boolean).join('；') || '',
          }, wsOpen ? '在线' : '实时通道未连接' + (wsStore.lastError ? '：' + wsStore.lastError : '') + (wsStore.diagSummary ? '；' + wsStore.diagSummary : '') + wsViaSuffix()),
          h('button', {
            type: 'button', onClick: () => panelStore.close(),
            onPointerDown: (e) => e.stopPropagation(),
            style: { marginLeft: 'auto', cursor: 'pointer', background: 'none', border: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: 16, padding: '2px 6px' },
          }, '×'),
        ),
        h('div', { ref: listRef, style: { flex: 1, overflowY: 'auto', padding: 12 } },
          hasMore ? h('div', { style: { textAlign: 'center', marginBottom: 8 } },
            h('button', {
              type: 'button', onClick: loadOlder, disabled: loadingOlder,
              style: { cursor: 'pointer', background: 'none', border: 'none', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
            }, loadingOlder ? '加载中…' : '查看更早的消息'),
          ) : null,
          error ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary)' } }, '⚠️ ' + error) : null,
          loading ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, '加载中…') : null,
          rows,
        ),
        quotaUntil > Date.now() ? h('div', { style: { padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } },
          '消息额度已用完，' + (localHM(new Date(quotaUntil).toISOString()) || '稍后') + ' 后恢复') : null,
        h('div', { style: { display: 'flex', gap: 8, padding: 10, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
          h('input', {
            ref: fileRef, type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', multiple: true,
            style: { display: 'none' },
            onChange: (e) => { pickFiles(e.target.files); e.target.value = '' },
          }),
          h('button', {
            type: 'button', className: 'muche-btn', title: '发图片（最多3张，单张8M）',
            onClick: () => { if (fileRef.current) fileRef.current.click() },
            disabled: quotaUntil > Date.now(),
          }, '图'),
          h('input', {
            ref: inputRef, className: 'muche-field', value: input,
            placeholder: quotaUntil > Date.now() ? '额度已用完…' : (thinking ? '小沐正在想…（可继续发）' : '发消息…'),
            onChange: (e) => setInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') send() },
            disabled: quotaUntil > Date.now(),
            style: { flex: 1 },
          }),
          h('button', { type: 'button', className: 'muche-btn', onClick: send, disabled: quotaUntil > Date.now() }, '发送'),
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
      const scope = useScope()
      React.useEffect(() => {
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
        return scope.subscribe(pull)
      }, [scope])
      const save = () => {
        if (!scope) {
          setStatus('设置服务未就绪，稍后再试')
          return
        }
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
            setStatus('✓ 已保存(仅存本机 dsh 配置)')
            // WS 换连由 scope 订阅驱动（syncWsFromScope），此处不再直调。
          })
          .catch((e) => {
            setSaving(false)
            dirtyRef.current = false // 冲突时放开，让订阅拉回最新值
            setStatus('保存失败:' + (e && e.message ? String(e.message).slice(0, 200) : '未知错误'))
          })
      }
      const test = () => {
        setTesting(true)
        setStatus('')
        apiPost('/api/muche/test', { backendUrl: backendUrl.trim(), apiKey: apiKey.trim() }).then((res) => {
          setTesting(false)
          if (res && res.ok) setStatus('✓ 连接成功:user_id=' + res.userId)
          else setStatus('连接失败:' + (res ? res.error : '未知错误'))
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
        row('小沐后端地址', h('input', {
          className: 'muche-field', value: backendUrl,
          placeholder: '默认同机直连，免填',
          onChange: (e) => { dirtyRef.current = true; setBackendUrl(e.target.value) },
        })),
        row('API key', h('div', { style: { position: 'relative' } },
          h('input', {
            className: 'muche-field', value: apiKey,
            type: showKey ? 'text' : 'password', placeholder: 'muche_…(在小沐后台生成)',
            onChange: (e) => { dirtyRef.current = true; setApiKey(e.target.value) },
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

      // 配置绑定：命名空间问宿主拿唯一真源（市场安装可能不是 insert id）；
      // 拿不到按 insert id 绑。scope 就绪与变化后由订阅驱动 WS 启动/换连。
      apiGet('/api/muche/status').then((res) => {
        const ns = res && res.ok && typeof res.configNs === 'string' && res.configNs ? res.configNs : 'muche'
        scopeStore.set(configForms.get(ns))
      }).catch(() => {
        scopeStore.set(configForms.get('muche'))
      })
      const offScope = scopeStore.subscribe(syncWsFromScope)
      // 连接自愈:周期检查 + 回到标签页立即检查——
      // muche/dsh 重启或首次 config 失败后,连接最终自动恢复(实时弹入/红点
      // 依赖 WS 在线;HTTP fallback 只保发送不保接收)。
      const selfHealTimer = setInterval(() => wsStore.ensureConnected(), 30000)
      const onVisible = () => { if (document.visibilityState === 'visible') wsStore.ensureConnected() }
      document.addEventListener('visibilitychange', onVisible)
      ctx.on('dispose', () => {
        offScope()
        clearInterval(selfHealTimer)
        document.removeEventListener('visibilitychange', onVisible)
      })

      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'muche-entry', order: 10, label: '小沐' },
        (props) => h(MucheEntry, { wide: props ? props.wide !== false : true }),
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'muche-chat-panel', order: 5, label: '小沐聊天' },
        () => h(ChatPanel),
      ))
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'muche', order: 30, label: '小沐' },
        () => h(MucheSettingsSection),
      ))
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms']
    return module.exports
  },
})
