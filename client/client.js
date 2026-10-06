(() => {
  // client/src/api.js
  async function apiGet(path) {
    try {
      const r = await fetch(path);
      return await r.json().catch(() => ({ ok: false, error: "响应解析失败" }));
    } catch (e) {
      return { ok: false, error: "请求失败" };
    }
  }
  async function apiPost(path, body) {
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      return await r.json().catch(() => ({ ok: false, error: "响应解析失败" }));
    } catch (e) {
      return { ok: false, error: "请求失败" };
    }
  }

  // client/src/pure.js
  function localHM(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const d = new Date(t);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function fmtTime(iso) {
    if (!iso) return "";
    try {
      if (typeof Date === "undefined") return String(iso).slice(5, 16);
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso).slice(5, 16);
      const pad = (n) => n < 10 ? "0" + n : String(n);
      const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
      const now = /* @__PURE__ */ new Date();
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
      return d.getMonth() + 1 + "月" + d.getDate() + "日 " + hm;
    } catch (e) {
      return "";
    }
  }
  function gapMinutes(a, b) {
    try {
      if (!a || !b || typeof Date === "undefined") return null;
      const va = new Date(a).getTime();
      const vb = new Date(b).getTime();
      if (Number.isNaN(va) || Number.isNaN(vb)) return null;
      return (vb - va) / 6e4;
    } catch (e) {
      return null;
    }
  }
  function clipboardImageFiles(clipboard) {
    if (!clipboard) return [];
    const fromItems = Array.from(clipboard.items || []).filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
    if (fromItems.length > 0) return fromItems;
    return Array.from(clipboard.files || []).filter((file) => String(file.type || "").startsWith("image/"));
  }
  function summarizeDiag(res) {
    if (!res || typeof res !== "object") return null;
    const b = res && res.backend || {};
    const where = [b.host || "", b.pathPrefix && b.pathPrefix !== "(根)" ? b.pathPrefix : ""].join("");
    if (res.ok && res.stage === "backend-reached") {
      return "本机到后端通（后端应答" + (res.status || "?") + "），查浏览器到本机";
    }
    if (res.stage === "target") return "后端地址配错（" + (where || "空") + "）：" + (res.error || "");
    if (res.stage) return "本机到后端不通（" + res.stage + "）：" + (res.error || "");
    return "探针异常：" + (res.error || "未知");
  }
  function wsVia() {
    try {
      if (typeof location === "undefined" || !location.host) return "";
      return location.protocol + "//" + location.host;
    } catch (e) {
      return "";
    }
  }
  function wsViaSuffix() {
    const via = wsVia();
    return via ? "（经" + via + "）" : "";
  }
  function missingApiSuffix(url) {
    const raw = String(url || "").trim();
    if (!raw) return false;
    let u;
    try {
      u = new URL(raw);
    } catch (e) {
      return false;
    }
    const p = String(u.pathname || "").replace(/\/+$/, "");
    if (p === "" || p === "/") return true;
    return !/(^|\/)api$/.test(p);
  }

  // client/src/entry.js
  window.__ModuleLoader__.load({
    id: "muche-dsh-plugin",
    factory: (require2) => {
      var module = { exports: {} };
      var exports = module.exports;
      let React = require2("react");
      const h = React.createElement;
      const CSS = `
      .muche-settings-entry{background:0 0}
      .muche-settings-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .muche-field{box-sizing:border-box;width:100%;height:34px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
      .muche-field:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
      .muche-btn{box-sizing:border-box;height:32px;padding:0 14px;border:none;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;font-size:13px;cursor:pointer}
    `;
      if (typeof document !== "undefined") {
        const tag = document.createElement("style");
        tag.dataset.plugin = "muche-dsh-plugin";
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
      const panelStore = {
        open: false,
        unread: 0,
        subs: [],
        toggle() {
          this.open = !this.open;
          if (this.open) this.unread = 0;
          for (const f of this.subs) f();
        },
        close() {
          if (this.open) {
            this.open = false;
            for (const f of this.subs) f();
          }
        },
        bumpUnread() {
          if (!this.open) {
            this.unread += 1;
            for (const f of this.subs) f();
          }
        },
        markRead() {
          if (this.unread !== 0) {
            this.unread = 0;
            for (const f of this.subs) f();
          }
        },
        subscribe(f) {
          this.subs.push(f);
          return () => {
            this.subs = this.subs.filter((x) => x !== f);
          };
        }
      };
      function usePanelOpen() {
        const [open, setOpen] = React.useState(panelStore.open);
        React.useEffect(() => panelStore.subscribe(() => setOpen(panelStore.open)), []);
        return open;
      }
      const wsStore = {
        status: "idle",
        // idle | connecting | open | closed
        es: null,
        sseOpen: false,
        lastError: null,
        listeners: [],
        cfg: null,
        msgSeq: 0,
        diagSummary: null,
        // 本机→后端探针结论（人话），失败自诊断一次后填入，面板直显
        diagKey: "",
        // 探针已跑过的配置指纹（同配置不重复打后端）
        start(cfg) {
          const changed = !!cfg && (this.cfg === null || cfg.apiKey !== this.cfg.apiKey || cfg.backendUrl !== this.cfg.backendUrl);
          this.cfg = cfg || this.cfg;
          if (!this.cfg || !this.cfg.apiKey) {
            this._teardown();
            return;
          }
          if (changed) this._teardown();
          this._open();
        },
        // 失败自诊断（排障口）：通道建连失败时取一次 Host 侧探针，定位
        // “本机→后端”还是“浏览器→本机”。同配置只跑一次（重连退避不重复打
        // 后端）；结论进 diagSummary，面板在“未连接”后直显，无需找日志。
        runDiag() {
          const cfg = this.cfg;
          if (!cfg || !cfg.apiKey) return;
          const key = cfg.apiKey + "|" + cfg.backendUrl;
          if (this.diagKey === key) return;
          this.diagKey = key;
          try {
            apiGet("/api/muche/health").then((res) => {
              this.diagSummary = summarizeDiag(res && res.ws);
              this._setStatus(this.status);
            }).catch(() => {
            });
          } catch (e) {
          }
        },
        _teardown() {
          this.sseOpen = false;
          if (this.es) {
            const old = this.es;
            this.es = null;
            try {
              old.close();
            } catch (e) {
            }
          }
          this._setStatus("closed");
        },
        // 连接自愈:页面级周期检查(30s)。EventSource 自带断线重连，此处只补
        // “已彻底关闭”态；cfg 缺失则重读镜像再连。保证 muche/dsh 重启后最终恢复。
        ensureConnected() {
          if (this.isOpen()) return;
          if (this.status === "connecting") return;
          if (this.cfg && this.cfg.apiKey) {
            this._open();
            return;
          }
          syncWsFromScope();
        },
        _setStatus(s) {
          this.status = s;
          for (const f of this.listeners) {
            try {
              f({ type: "_status", status: s });
            } catch (e) {
            }
          }
        },
        subscribe(f) {
          this.listeners.push(f);
          return () => {
            this.listeners = this.listeners.filter((x) => x !== f);
          };
        },
        isOpen() {
          return this.sseOpen === true;
        },
        // 上行恒走 HTTP：调用方 send() 在 false 时自动降级走同 mid 的 HTTP
        // 发送（见 ChatPanel send），幂等由后端 ingress 边界负责。
        send(obj) {
          return false;
        },
        // SSE 下行：同源相对地址（与 apiGet 同门：http(s) 与 dsh-app:// 通用）。
        // 帧进同一 listeners 总线，React 零改动。
        _open() {
          if (this.es) return;
          if (typeof EventSource === "undefined") {
            this.lastError = "当前页面不支持 SSE";
            this._setStatus("error");
            this.runDiag();
            return;
          }
          this._setStatus("connecting");
          let es;
          try {
            es = new EventSource("/api/muche/events");
          } catch (e) {
            this.lastError = "SSE 建连被拒绝: " + String(e && e.message ? e.message : e).slice(0, 200);
            this._setStatus("error");
            this.runDiag();
            return;
          }
          this.es = es;
          es.onopen = () => {
            this.lastError = null;
            this.sseOpen = true;
            this._setStatus("open");
          };
          es.onmessage = (ev) => {
            let data = null;
            try {
              data = JSON.parse(ev.data);
            } catch (e) {
              return;
            }
            for (const f of this.listeners) {
              try {
                f(data);
              } catch (e) {
              }
            }
          };
          es.onerror = () => {
            try {
              if (es.readyState === EventSource.CLOSED) {
                this.sseOpen = false;
                this.lastError = "事件通道中断";
                this._setStatus("closed");
                this.runDiag();
              }
            } catch (e) {
            }
          };
        },
        newId(prefix) {
          this.msgSeq += 1;
          return prefix + "-" + Date.now() + "-" + this.msgSeq;
        }
      };
      const scopeStore = {
        scope: null,
        subs: [],
        set(next) {
          this.scope = next;
          for (const f of this.subs) f();
        },
        subscribe(f) {
          this.subs.push(f);
          return () => {
            this.subs = this.subs.filter((x) => x !== f);
          };
        }
      };
      function useScope() {
        const [, force] = React.useState(0);
        React.useEffect(() => scopeStore.subscribe(() => force((n) => n + 1)), []);
        return scopeStore.scope;
      }
      function syncWsFromScope() {
        const s = scopeStore.scope;
        if (!s) return;
        let snap = null;
        try {
          snap = s.getSnapshot();
        } catch (e) {
          return;
        }
        const v = snap && snap.value || {};
        wsStore.start({
          backendUrl: typeof v.backendUrl === "string" ? v.backendUrl : "",
          apiKey: typeof v.apiKey === "string" ? v.apiKey : ""
        });
      }
      function PersonIcon({ size }) {
        return h(
          "svg",
          {
            width: size || 16,
            height: size || 16,
            viewBox: "0 0 16 16",
            fill: "none",
            "aria-hidden": true
          },
          h("path", {
            d: "M11.0307 5.46369C11.0305 3.78995 9.6734 2.43357 7.99961 2.43357C6.32601 2.43379 4.96972 3.79009 4.96949 5.46369C4.96949 7.13748 6.32587 8.49455 7.99961 8.49477C9.67354 8.49477 11.0307 7.13762 11.0307 5.46369ZM12.3163 5.46369C12.3163 7.84777 10.3837 9.78042 7.99961 9.78042C5.61572 9.7802 3.68288 7.84763 3.68288 5.46369C3.6831 3.07993 5.61586 1.14718 7.99961 1.14695C10.3836 1.14695 12.3161 3.0798 12.3163 5.46369Z",
            fill: "currentColor"
          }),
          h("path", {
            d: "M8.00002 10.3316C11.7343 10.3316 14.1864 11.8997 15.0387 14.4445L14.4292 14.6483L13.8197 14.8531C13.1955 12.9893 11.3673 11.6182 8.00002 11.6182C4.63277 11.6182 2.80455 12.9893 2.18031 14.8531L1.5708 14.6483L0.961304 14.4445C1.81368 11.8997 4.26579 10.3316 8.00002 10.3316Z",
            fill: "currentColor"
          })
        );
      }
      function useUnread() {
        const [unread, setUnread] = React.useState(panelStore.unread);
        React.useEffect(() => panelStore.subscribe(() => setUnread(panelStore.unread)), []);
        return unread;
      }
      function useWsOpen() {
        const [open, setOpen] = React.useState(wsStore.isOpen());
        React.useEffect(() => wsStore.subscribe(() => setOpen(wsStore.isOpen())), []);
        return open;
      }
      function MucheEntry({ wide }) {
        const open = usePanelOpen();
        const unread = useUnread();
        if (!wide) {
          return h(
            "button",
            {
              type: "button",
              onClick: () => panelStore.toggle(),
              title: open ? "小沐面板已打开" : "打开小沐",
              className: "muche-settings-entry",
              style: {
                position: "relative",
                boxSizing: "border-box",
                cursor: "pointer",
                border: "none",
                overflow: "visible",
                width: 36,
                height: 36,
                borderRadius: "50%",
                margin: "8px 0 10px",
                justifyContent: "center",
                alignItems: "center",
                gap: 0,
                padding: 0,
                color: "var(--dsw-alias-label-primary)",
                display: "flex"
              }
            },
            h(PersonIcon, { size: 18 }),
            unread > 0 ? h("span", { style: { position: "absolute", top: 5, right: 5, width: 8, height: 8, borderRadius: "50%", background: "var(--dsw-alias-state-error-primary)" } }) : null
          );
        }
        return h(
          "button",
          {
            type: "button",
            onClick: () => panelStore.toggle(),
            title: open ? "小沐面板已打开" : unread > 0 ? `小沐有 ${unread} 条未读` : "打开小沐",
            className: "muche-settings-entry",
            style: {
              position: "relative",
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "calc(100% + 8px)",
              height: 34,
              margin: "4px -4px 4px",
              padding: "6px 2px 6px 10px",
              boxSizing: "border-box",
              border: "none",
              borderRadius: 12,
              overflow: "visible",
              cursor: "pointer",
              color: "var(--dsw-alias-label-primary)",
              fontFamily: "inherit",
              fontSize: 14,
              lineHeight: "22px"
            }
          },
          h(PersonIcon, { size: 16 }),
          h("span", { style: { whiteSpace: "nowrap", overflow: "hidden" } }, open ? "小沐(已打开)" : "小沐"),
          unread > 0 ? h("span", { style: { position: "absolute", top: 6, right: 8, minWidth: 14, height: 14, padding: "0 4px", borderRadius: 7, background: "var(--dsw-alias-state-error-primary)", color: "#fff", fontSize: 10, lineHeight: "14px", textAlign: "center" } }, unread > 99 ? "99+" : String(unread)) : null
        );
      }
      function ChatPanel() {
        const open = usePanelOpen();
        const wsOpen = useWsOpen();
        const [msgs, setMsgs] = React.useState([]);
        const [hasMore, setHasMore] = React.useState(false);
        const [olderCursor, setOlderCursor] = React.useState(null);
        const [loadingOlder, setLoadingOlder] = React.useState(false);
        const [input, setInput] = React.useState("");
        const [thinking, setThinking] = React.useState(false);
        const [pendingImages, setPendingImages] = React.useState([]);
        const fileRef = React.useRef(null);
        const inputRef = React.useRef(null);
        const [loading, setLoading] = React.useState(false);
        const [error, setError] = React.useState("");
        const [reachedStart, setReachedStart] = React.useState(false);
        const [quotaUntil, setQuotaUntil] = React.useState(0);
        const [pos, setPos] = React.useState(null);
        const listRef = React.useRef(null);
        const panelRef = React.useRef(null);
        const dragRef = React.useRef(null);
        const preserveRef = React.useRef(null);
        const bottomRef = React.useRef(null);
        const stickRef = React.useRef(true);
        const inflightRef = React.useRef(/* @__PURE__ */ new Set());
        const timersRef = React.useRef(/* @__PURE__ */ new Map());
        const failedImgsRef = React.useRef(/* @__PURE__ */ new Set());
        const markImgFailed = (src) => {
          if (!src || failedImgsRef.current.has(src)) return;
          failedImgsRef.current.add(src);
          setMsgs(renderMerged(baseRef.current));
        };
        const stuckNoticeRef = React.useRef(null);
        const quotaUntilRef = React.useRef(0);
        const setQuota = (ms) => {
          quotaUntilRef.current = ms;
          setQuotaUntil(ms);
        };
        const failureNotice = () => "⚠️ 这条消息暂时没处理完，请稍后重试";
        const withSticky = (rows2) => stuckNoticeRef.current ? [...rows2, stuckNoticeRef.current] : rows2;
        const stickNotice = (content, ts) => {
          stuckNoticeRef.current = { role: "assistant", content, inner_thought: "", ts };
        };
        const baseRef = React.useRef([]);
        const overlayRef = React.useRef([]);
        const overlaySeqRef = React.useRef(0);
        const syncSeqRef = React.useRef(0);
        const overlayCovered = (o, base) => {
          if (!o || typeof o !== "object" || o.role === "system") return false;
          if (o.mid && base.some((b) => b.delivery_id && b.delivery_id === o.mid)) return true;
          const content = typeof o.content === "string" ? o.content : "";
          if (content && base.some((b) => b.role === o.role && b.content === content)) return true;
          if (!content) {
            const ot = Date.parse(o.ts);
            if (Number.isFinite(ot) && base.some((b) => {
              if (b.role !== o.role) return false;
              if (!(b.medium === "image" || Number(b.image_count) > 0)) return false;
              const bt = Date.parse(b.ts);
              return Number.isFinite(bt) && Math.abs(bt - ot) < 10 * 60 * 1e3;
            })) return true;
          }
          const born = Date.parse(o.ts);
          if (Number.isFinite(born) && Date.now() - born > 18e4 && o.birthSync !== void 0 && syncSeqRef.current > o.birthSync) return true;
          return false;
        };
        const renderMerged = (base) => {
          const rows2 = [...base || []];
          for (const o of overlayRef.current) {
            if (overlayCovered(o, base)) continue;
            rows2.push(o);
          }
          rows2.sort((a, b) => {
            const ta = Date.parse(a.ts);
            const tb = Date.parse(b.ts);
            if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
            return ta - tb;
          });
          return withSticky(rows2);
        };
        const overlayAdd = (rows2) => {
          const list = Array.isArray(rows2) ? rows2 : [rows2];
          for (const r of list) {
            if (!r || typeof r !== "object") continue;
            overlaySeqRef.current += 1;
            overlayRef.current.push({ ...r, overlayKey: "o" + Date.now() + "-" + overlaySeqRef.current, birthSync: syncSeqRef.current });
          }
          setMsgs(renderMerged(baseRef.current));
        };
        const reconcileOverlay = () => {
          const base = baseRef.current;
          const kept = overlayRef.current.filter((o) => !overlayCovered(o, base));
          if (kept.length !== overlayRef.current.length) overlayRef.current = kept;
        };
        const handleHttpReply = (res, nowIso, mid) => {
          settleInflight(mid);
          if (res && !res.ok && res.code === "message_quota_exhausted") {
            const until = Date.parse(res.reset_at);
            if (Number.isFinite(until) && until > Date.now()) setQuota(until);
          }
          if (res && res.ok) {
            const parts = (res.messages || []).map((t) => ({ role: "assistant", content: String(t), inner_thought: res.inner_thought || "", ts: nowIso }));
            if (res.degraded && parts.length === 0 && !res.superseded && !res.waiting_for_decision) {
              stickNotice(failureNotice(), nowIso);
              setMsgs(renderMerged(baseRef.current));
            } else if (parts.length > 0) {
              overlayAdd(parts);
            }
          } else {
            const error2 = res && res.error ? res.error : "发送失败";
            stickNotice("⚠️ " + error2, nowIso);
            setMsgs(renderMerged(baseRef.current));
          }
        };
        const normalize = (rows2) => (rows2 || []).map((m) => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.content || "",
          inner_thought: m.inner_thought || "",
          ts: m.created_at || "",
          id: m.id || "",
          medium: m.medium || "text",
          image_count: Number(m.image_count) || 0,
          delivery_id: typeof m.delivery_id === "string" ? m.delivery_id : typeof m.ingress_id === "string" ? m.ingress_id : "",
          vision: typeof m.vision_descriptions === "string" ? m.vision_descriptions : ""
        }));
        const pickFiles = (files) => {
          const list = Array.from(files || []);
          if (!list.length) return;
          setError("");
          const okTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
          for (const f of list) {
            if (pendingImages.length >= 3) {
              setError("最多发 3 张图");
              break;
            }
            if (okTypes.indexOf(f.type) < 0) {
              setError("只支持 JPEG/PNG/GIF/WebP");
              continue;
            }
            if (f.size > 8 * 1024 * 1024) {
              setError("单张图最大 8M");
              continue;
            }
            const reader = new FileReader();
            reader.onload = () => {
              setPendingImages((prev) => prev.length >= 3 ? prev : [...prev, String(reader.result || "")]);
            };
            reader.readAsDataURL(f);
          }
        };
        const settleInflight = (mid) => {
          if (mid) {
            inflightRef.current.delete(mid);
            const timer = timersRef.current.get(mid);
            if (timer) {
              clearTimeout(timer);
              timersRef.current.delete(mid);
            }
          }
          if (inflightRef.current.size === 0) setThinking(false);
        };
        React.useEffect(() => {
          const off = wsStore.subscribe((data) => {
            const nowIso = typeof Date !== "undefined" ? (/* @__PURE__ */ new Date()).toISOString() : "";
            if (data.type === "proactive") {
              const parts = (data.messages || []).map((t) => ({
                role: "assistant",
                content: String(t),
                inner_thought: data.inner_thought || "",
                ts: nowIso
              }));
              if (parts.length > 0) {
                overlayAdd(parts);
                panelStore.bumpUnread();
              }
            } else if (data.type === "reply") {
              if (data.duplicate) return;
              settleInflight(data.message_id);
              const parts = (data.messages || []).map((t) => ({
                role: "assistant",
                content: String(t),
                inner_thought: data.inner_thought || "",
                ts: nowIso
              }));
              if (data.degraded && parts.length === 0 && !data.superseded && !data.waiting_for_decision) {
                stickNotice(failureNotice(), nowIso);
                setMsgs(renderMerged(baseRef.current));
              } else if (data.degraded === false && parts.length === 0) {
                overlayAdd([{ role: "assistant", content: "（没有回复）", inner_thought: "", ts: nowIso }]);
              } else if (parts.length > 0) {
                overlayAdd(parts);
              }
            } else if (data.type === "dialogue_updated") {
              refreshNew();
            } else if (data.type === "error" && data.message_id && inflightRef.current.has(data.message_id)) {
              settleInflight(data.message_id);
              if (data.code === "message_quota_exhausted") {
                const until = Date.parse(data.reset_at);
                if (Number.isFinite(until) && until > Date.now()) setQuota(until);
              }
              const hm = data.code === "message_quota_exhausted" ? localHM(data.reset_at) : "";
              const text = hm ? "消息额度已用完，" + hm + " 后恢复" : "⚠️ " + (data.error || "处理失败");
              stickNotice("⚠️ " + text, nowIso);
              setMsgs(renderMerged(baseRef.current));
            }
          });
          return off;
        }, []);
        React.useEffect(() => {
          if (!quotaUntil) return;
          const timer = setInterval(() => setQuotaUntil((v) => v && v <= Date.now() ? 0 : v), 15e3);
          return () => clearInterval(timer);
        }, [quotaUntil]);
        React.useEffect(() => {
          if (!open) return;
          if (quotaUntil > Date.now()) return;
          const el = inputRef.current;
          if (el && typeof el.focus === "function") el.focus();
        }, [open, quotaUntil]);
        const fetchNew = React.useCallback(() => {
          return apiGet("/api/muche/history?limit=20").then(
            (res) => res && res.ok ? { ok: true, error: "", messages: res.messages || [] } : { ok: false, error: String(res && res.error || "未知错误"), messages: [] },
            () => ({ ok: false, error: "请求失败", messages: [] })
          );
        }, []);
        const loadHistory = React.useCallback(() => {
          return apiGet("/api/muche/history?limit=50").then((res) => {
            if (res && res.ok) {
              const page = normalize(res.messages);
              baseRef.current = page;
              reconcileOverlay();
              setMsgs(renderMerged(page));
              setHasMore(!!res.has_more);
              setOlderCursor(typeof res.next_before === "string" && res.next_before ? res.next_before : null);
              if (!res.has_more) setReachedStart(true);
              setError("");
              syncSeqRef.current += 1;
              return true;
            }
            if (res && !res.ok && res.error) {
              setError(res.error);
            }
            return false;
          }).catch(() => false);
        }, []);
        const refreshNew = React.useCallback(() => {
          return fetchNew().then((delta) => {
            if (!delta.ok) {
              setError("刷新失败" + (delta.error ? "（" + delta.error.slice(0, 80) + "）" : ""));
              return false;
            }
            const rows2 = normalize(delta.messages);
            if (rows2.length > 0) {
              const known = new Set(baseRef.current.map((m) => m.id));
              const fresh = rows2.filter((m) => m.id && !known.has(m.id));
              if (fresh.length > 0) {
                const merged = [...baseRef.current, ...fresh];
                merged.sort((a, b) => {
                  const ta = Date.parse(a.ts);
                  const tb = Date.parse(b.ts);
                  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
                  return ta - tb;
                });
                baseRef.current = merged.slice(-200);
              }
              reconcileOverlay();
              setMsgs(renderMerged(baseRef.current));
            }
            syncSeqRef.current += 1;
            return true;
          });
        }, [fetchNew]);
        React.useEffect(() => {
          if (!open) return;
          setLoading(true);
          stickRef.current = true;
          setReachedStart(false);
          setOlderCursor(null);
          loadHistory().then(() => setLoading(false));
        }, [open]);
        const authFpRef = React.useRef("");
        React.useEffect(() => scopeStore.subscribe(() => {
          let fp = "";
          try {
            const snap = scopeStore.scope && scopeStore.scope.getSnapshot();
            const v = snap && snap.value || {};
            fp = (v.backendUrl || "") + "|" + (v.apiKey || "");
          } catch (e) {
            return;
          }
          if (authFpRef.current && fp !== authFpRef.current) {
            authFpRef.current = fp;
            baseRef.current = [];
            overlayRef.current = [];
            stuckNoticeRef.current = null;
            setMsgs([]);
            setHasMore(false);
            setReachedStart(false);
            setOlderCursor(null);
            setError("");
            if (panelStore.open) loadHistory();
          } else if (!authFpRef.current) {
            authFpRef.current = fp;
          }
        }), [loadHistory]);
        const pinToBottom = () => {
          const anchor = bottomRef.current;
          if (!anchor) return;
          const go = () => {
            try {
              anchor.scrollIntoView({ block: "end" });
            } catch (e) {
            }
          };
          if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => requestAnimationFrame(go));
          else go();
        };
        const onListScroll = () => {
          const el = listRef.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        };
        const onHistoryImageLoad = () => {
          if (stickRef.current) pinToBottom();
        };
        React.useEffect(() => {
          const el = listRef.current;
          if (!el) return;
          if (preserveRef.current) {
            const p = preserveRef.current;
            preserveRef.current = null;
            el.scrollTop = el.scrollHeight - p.prevHeight + p.prevScrollTop;
          } else if (stickRef.current) {
            pinToBottom();
          }
        }, [msgs]);
        const olderTimerRef = React.useRef(null);
        const loadOlder = () => {
          if (loadingOlder || !hasMore && reachedStart) return;
          if (olderTimerRef.current) return;
          olderTimerRef.current = setTimeout(() => {
            olderTimerRef.current = null;
          }, 300);
          setLoadingOlder(true);
          const el = listRef.current;
          const prevHeight = el ? el.scrollHeight : 0;
          const prevScrollTop = el ? el.scrollTop : 0;
          preserveRef.current = { prevHeight, prevScrollTop };
          const cursor = olderCursor;
          if (!cursor) {
            setReachedStart(true);
            setLoadingOlder(false);
            preserveRef.current = { prevHeight, prevScrollTop };
            return;
          }
          apiGet("/api/muche/history?limit=50" + (cursor ? "&before=" + encodeURIComponent(cursor) : "")).then((res) => {
            if (res && res.ok) {
              const rows2 = normalize(res.messages);
              const known = new Set(baseRef.current.map((m) => m.id));
              const fresh = rows2.filter((m) => m.id && !known.has(m.id));
              if (fresh.length > 0) {
                const merged = [...fresh, ...baseRef.current];
                baseRef.current = merged.slice(-200);
                reconcileOverlay();
                setMsgs(renderMerged(baseRef.current));
              }
              setHasMore(!!res.has_more);
              setOlderCursor(typeof res.next_before === "string" && res.next_before ? res.next_before : null);
              if (!res.has_more) setReachedStart(true);
              syncSeqRef.current += 1;
              setLoadingOlder(false);
              preserveRef.current = { prevHeight, prevScrollTop };
            } else {
              setLoadingOlder(false);
              setError("加载更早的消息失败" + (res && res.error ? "（" + String(res.error).slice(0, 80) + "）" : ""));
            }
          }, () => {
            setLoadingOlder(false);
            setError("加载更早的消息失败（请求失败）");
          });
        };
        const send = () => {
          const text = input.trim();
          const images = pendingImages.slice(0, 3);
          if (!text && !images.length) return;
          if (quotaUntilRef.current > Date.now()) return;
          setInput("");
          setPendingImages([]);
          stuckNoticeRef.current = null;
          const nowIso = typeof Date !== "undefined" ? (/* @__PURE__ */ new Date()).toISOString() : "";
          const mid = wsStore.newId("m");
          overlayAdd([{ role: "user", content: text, inner_thought: "", ts: nowIso, previews: images, mid }]);
          setThinking(true);
          inflightRef.current.add(mid);
          if (wsStore.isOpen()) {
            if (wsStore.send({ type: "user_message", message_id: mid, message: text, images: images.length ? images : void 0 })) {
              timersRef.current.set(mid, setTimeout(() => {
                if (inflightRef.current.has(mid)) {
                  settleInflight(mid);
                  stickNotice("⚠️ 回复超时,请重试", nowIso);
                  setMsgs(renderMerged(baseRef.current));
                }
              }, 9e4));
              if (inputRef.current && typeof inputRef.current.focus === "function") inputRef.current.focus();
              return;
            }
          }
          apiPost("/api/muche/chat", { text, message_id: mid, images: images.length ? images : void 0 }).then((res) => handleHttpReply(res, nowIso, mid));
          if (inputRef.current && typeof inputRef.current.focus === "function") inputRef.current.focus();
        };
        const bubble = (m, i, showTime) => {
          const mine = m.role === "user";
          const previews = Array.isArray(m.previews) ? m.previews : [];
          const histCount = !previews.length && mine && m.medium === "image" && m.image_count > 0 && m.id ? Math.min(m.image_count, 3) : 0;
          const histUrls = [];
          for (let k = 0; k < histCount; k++) {
            histUrls.push("/api/muche/image?id=" + encodeURIComponent(m.id) + "&index=" + k);
          }
          const imgUrls = previews.length ? previews : histUrls;
          const expiredVision = typeof m.vision === "string" ? m.vision : "";
          return h(
            "div",
            { key: i },
            showTime ? h("div", {
              style: { textAlign: "center", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", margin: "6px 0 10px" }
            }, fmtTime(m.ts)) : null,
            h(
              "div",
              { style: { display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 10 } },
              mine ? null : h("div", {
                style: {
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  flex: "none",
                  marginRight: 8,
                  background: "var(--dsw-alias-interactive-bg-hover)",
                  color: "var(--dsw-alias-label-primary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }
              }, h(PersonIcon, { size: 16 })),
              h(
                "div",
                { style: { maxWidth: "72%" } },
                // 面板不显示内心独白(💭 行移除)。
                // inner_thought 字段与赋值链路保留(数据照常解析入库,恢复显示只需加回渲染)。
                imgUrls.length && mine ? h(
                  "div",
                  { style: { marginBottom: m.content ? 6 : 0 } },
                  imgUrls.map((src, k) => failedImgsRef.current.has(src) ? h("div", {
                    key: "imgx" + k,
                    style: { width: "100%", borderRadius: 8, padding: "10px 12px", marginBottom: k + 1 < imgUrls.length ? 6 : 0, fontSize: 13, lineHeight: "18px", background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-secondary)" }
                  }, "图片已过期" + (expiredVision ? "：" + expiredVision : "")) : h("img", {
                    key: "img" + k,
                    src,
                    onLoad: onHistoryImageLoad,
                    onError: () => markImgFailed(src),
                    style: { width: "100%", borderRadius: 8, display: "block", marginBottom: k + 1 < imgUrls.length ? 6 : 0 }
                  }))
                ) : null,
                m.content ? h("div", {
                  style: {
                    display: "inline-block",
                    padding: "8px 12px",
                    borderRadius: 12,
                    fontSize: 14,
                    lineHeight: "20px",
                    wordBreak: "break-word",
                    whiteSpace: "pre-wrap",
                    background: mine ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-button-ghost-active-fill)",
                    color: mine ? "#fff" : "var(--dsw-alias-label-primary)"
                  }
                }, m.content) : null
              )
            )
          );
        };
        const rows = [];
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          const key = m && (m.overlayKey || m.id) || i;
          let showTime = false;
          if (i === 0) showTime = true;
          else {
            const gap = gapMinutes(msgs[i - 1].ts, m.ts);
            if (gap === null || gap > 2) showTime = true;
          }
          rows.push(bubble(m, key, showTime));
        }
        if (!open) return null;
        const onDragStart = (e) => {
          const panel = panelRef.current;
          if (!panel) return;
          const rect = panel.getBoundingClientRect();
          dragRef.current = { sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top };
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch (err) {
          }
        };
        const onDragMove = (e) => {
          const d = dragRef.current;
          if (!d) return;
          setPos({ left: d.left + (e.clientX - d.sx), top: d.top + (e.clientY - d.sy) });
        };
        const onDragEnd = () => {
          dragRef.current = null;
        };
        const dragHandle = {
          onPointerDown: onDragStart,
          onPointerMove: onDragMove,
          onPointerUp: onDragEnd,
          onPointerCancel: onDragEnd
        };
        return h(
          "div",
          {
            ref: panelRef,
            style: {
              position: "fixed",
              ...pos ? { left: pos.left, top: pos.top } : { right: 24, bottom: 24 },
              zIndex: 1200,
              width: 380,
              height: 560,
              display: "flex",
              flexDirection: "column",
              background: "var(--dsw-alias-bg-base)",
              border: "1px solid var(--dsw-alias-border-l1)",
              borderRadius: 16,
              boxShadow: "var(--dsw-shadow-lv2)",
              overflow: "hidden",
              pointerEvents: "auto"
            }
          },
          h(
            "div",
            {
              ...dragHandle,
              style: {
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                borderBottom: "1px solid var(--dsw-alias-border-l2)",
                cursor: "grab",
                userSelect: "none",
                touchAction: "none"
              }
            },
            h("span", { style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "小沐"),
            h("span", {
              style: {
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: wsOpen ? "#52c41a" : "#fa8c16"
              }
            }),
            h("span", {
              style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
              title: [wsStore.lastError, wsStore.diagSummary, wsVia()].filter(Boolean).join("；") || ""
            }, wsOpen ? "在线" : "实时通道未连接" + (wsStore.lastError ? "：" + wsStore.lastError : "") + (wsStore.diagSummary ? "；" + wsStore.diagSummary : "") + wsViaSuffix()),
            h("button", {
              type: "button",
              onClick: () => panelStore.close(),
              onPointerDown: (e) => e.stopPropagation(),
              style: { marginLeft: "auto", cursor: "pointer", background: "none", border: "none", color: "var(--dsw-alias-label-secondary)", fontSize: 16, padding: "2px 6px" }
            }, "×")
          ),
          h(
            "div",
            { ref: listRef, onScroll: onListScroll, style: { flex: 1, overflowY: "auto", padding: 12 } },
            hasMore || !reachedStart ? h(
              "div",
              { style: { textAlign: "center", marginBottom: 8 } },
              h("button", {
                type: "button",
                onClick: loadOlder,
                disabled: loadingOlder,
                style: { cursor: "pointer", background: "none", border: "none", fontSize: 12, color: "var(--dsw-alias-label-secondary)" }
              }, loadingOlder ? "加载中…" : "查看更早的消息")
            ) : null,
            error ? h("div", { style: { fontSize: 13, color: "var(--dsw-alias-state-error-primary)" } }, "⚠️ " + error) : null,
            loading ? h("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, "加载中…") : null,
            rows,
            h("div", { ref: bottomRef, style: { height: 1 } })
          ),
          quotaUntil > Date.now() ? h(
            "div",
            { style: { padding: "6px 12px", fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } },
            "消息额度已用完，" + (localHM(new Date(quotaUntil).toISOString()) || "稍后") + " 后恢复"
          ) : null,
          h(
            "div",
            { style: { display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--dsw-alias-border-l2)" } },
            h("input", {
              ref: fileRef,
              type: "file",
              accept: "image/jpeg,image/png,image/gif,image/webp",
              multiple: true,
              style: { display: "none" },
              onChange: (e) => {
                pickFiles(e.target.files);
                e.target.value = "";
              }
            }),
            h("button", {
              type: "button",
              className: "muche-btn",
              title: "发图片（最多3张，单张8M）",
              onClick: () => {
                if (fileRef.current) fileRef.current.click();
              },
              disabled: quotaUntil > Date.now()
            }, "图"),
            h("input", {
              ref: inputRef,
              className: "muche-field",
              value: input,
              placeholder: quotaUntil > Date.now() ? "额度已用完…" : thinking ? "小沐正在想…（可继续发）" : "发消息…",
              onChange: (e) => setInput(e.target.value),
              onPaste: (e) => {
                const files = clipboardImageFiles(e.clipboardData);
                if (!files.length) return;
                e.preventDefault();
                pickFiles(files);
              },
              onKeyDown: (e) => {
                if (e.key === "Enter") send();
              },
              disabled: quotaUntil > Date.now(),
              style: { flex: 1 }
            }),
            h("button", { type: "button", className: "muche-btn", onClick: send, disabled: quotaUntil > Date.now() }, "发送")
          ),
          pendingImages.length ? h(
            "div",
            { style: { display: "flex", gap: 6, padding: "0 10px 10px", flexWrap: "wrap" } },
            pendingImages.map((src, k) => h(
              "div",
              { key: "p" + k, style: { position: "relative", width: 56, height: 56 } },
              h("img", { src, style: { width: 56, height: 56, objectFit: "cover", borderRadius: 8 } }),
              h("button", {
                type: "button",
                onClick: () => setPendingImages((prev) => prev.filter((_, j) => j !== k)),
                style: { position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", border: "none", cursor: "pointer", fontSize: 12, lineHeight: "18px" }
              }, "×")
            ))
          ) : null,
          h(
            "div",
            {
              ...dragHandle,
              title: "拖动面板",
              style: {
                height: 12,
                flex: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "grab",
                userSelect: "none",
                touchAction: "none"
              }
            },
            h("div", { style: { width: 36, height: 4, borderRadius: 2, background: "var(--dsw-alias-border-l2)" } })
          )
        );
      }
      function EyeIcon({ off }) {
        return h(
          "svg",
          {
            width: 14,
            height: 14,
            viewBox: "0 0 16 16",
            fill: "none",
            "aria-hidden": true
          },
          h("path", {
            d: off ? "M6.6 3.2A6.9 6.9 0 0 1 8 3c4.1 0 6.5 5 6.5 5a9.4 9.4 0 0 1-1.3 1.7M3.6 5.3A9.7 9.7 0 0 0 1.5 8s2.4 5 6.5 5a6.1 6.1 0 0 0 2.9-.8M9.9 6.1a2.2 2.2 0 0 0-3.8 3.8M1.8 1.8l12.4 12.4" : "M1.5 8s2.4-5 6.5-5 6.5 5 6.5 5-2.4 5-6.5 5S1.5 8 1.5 8Z",
            stroke: "currentColor",
            strokeWidth: 1.3,
            strokeLinecap: "round",
            strokeLinejoin: "round"
          }),
          off ? null : h("circle", { cx: 8, cy: 8, r: 2, stroke: "currentColor", strokeWidth: 1.3, fill: "none" })
        );
      }
      function MucheSettingsSection() {
        const [backendUrl, setBackendUrl] = React.useState("");
        const [apiKey, setApiKey] = React.useState("");
        const [showKey, setShowKey] = React.useState(false);
        const [status, setStatus] = React.useState("");
        const [testing, setTesting] = React.useState(false);
        const [saving, setSaving] = React.useState(false);
        const dirtyRef = React.useRef(false);
        const revRef = React.useRef(void 0);
        const scope = useScope();
        React.useEffect(() => {
          if (!scope) return void 0;
          const pull = () => {
            if (dirtyRef.current) return;
            let snap = null;
            try {
              snap = scope.getSnapshot();
            } catch (e) {
              return;
            }
            const user = snap && snap.user || {};
            const value = snap && snap.value || {};
            const base = snap && snap.base || {};
            const shownBackend = typeof user.backendUrl === "string" && user.backendUrl && user.backendUrl !== base.backendUrl ? user.backendUrl : "";
            setBackendUrl(shownBackend);
            setApiKey(typeof value.apiKey === "string" ? value.apiKey : "");
            revRef.current = snap ? snap.revision : void 0;
          };
          pull();
          return scope.subscribe(pull);
        }, [scope]);
        const save = () => {
          if (!scope) {
            setStatus("设置服务未就绪，稍后再试");
            return;
          }
          setSaving(true);
          setStatus("");
          const ops = [];
          if (backendUrl.trim()) ops.push({ op: "set", path: ["backendUrl"], value: backendUrl.trim() });
          else ops.push({ op: "unset", path: ["backendUrl"] });
          ops.push({ op: "set", path: ["apiKey"], value: apiKey.trim() });
          Promise.resolve().then(() => scope.mutate(ops, revRef.current)).then(() => {
            setSaving(false);
            dirtyRef.current = false;
            setStatus("✓ 已保存(仅存本机 dsh 配置)");
          }).catch((e) => {
            setSaving(false);
            dirtyRef.current = false;
            setStatus("保存失败:" + (e && e.message ? String(e.message).slice(0, 200) : "未知错误"));
          });
        };
        const test = () => {
          setTesting(true);
          setStatus("");
          if (missingApiSuffix(backendUrl)) {
            setStatus("地址可能少了 /api 后缀：远端请填 https://公网地址/api（仍为你测试连接）");
          }
          apiPost("/api/muche/health", { backendUrl: backendUrl.trim(), apiKey: apiKey.trim() }).then((res) => {
            setTesting(false);
            const auth = res && res.auth;
            const history = res && res.history;
            if (res && res.ok && auth && auth.ok) {
              setStatus("✓ 连接成功:user_id=" + auth.userId + (history && history.ok ? "（历史通）" : "（历史：" + (history && history.error || "不可读") + "）"));
            } else {
              const seg = auth && !auth.ok ? "鉴权：" + auth.error : history && !history.ok ? "历史：" + history.error : "未知错误";
              setStatus("连接失败：" + seg);
            }
          });
        };
        const row = (label, node) => h(
          "div",
          { style: { marginBottom: 14 } },
          h("div", { style: { fontSize: 13, marginBottom: 6, color: "var(--dsw-alias-label-secondary)" } }, label),
          node
        );
        return h(
          "div",
          { style: { maxWidth: 520, padding: "8px 0" } },
          h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, "小沐接入配置"),
          h(
            "div",
            { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginBottom: 16 } },
            "填后端地址和 API key（小沐后台生成），保存即用。"
          ),
          row("小沐后端地址", h(
            "div",
            null,
            h("input", {
              className: "muche-field",
              value: backendUrl,
              placeholder: "填 https://公网地址/api（/api 后缀必填）",
              onChange: (e) => {
                dirtyRef.current = true;
                setBackendUrl(e.target.value);
              }
            }),
            missingApiSuffix(backendUrl) ? h("div", {
              style: { fontSize: 12, marginTop: 6, color: "var(--dsw-alias-state-error-primary)" }
            }, "地址少了 /api 后缀：远端请填 https://公网地址/api，否则只会收到网页、报响应解析失败") : null
          )),
          row("API key", h(
            "div",
            { style: { position: "relative" } },
            h("input", {
              className: "muche-field",
              value: apiKey,
              type: showKey ? "text" : "password",
              placeholder: "muche_…(在小沐后台生成)",
              onChange: (e) => {
                dirtyRef.current = true;
                setApiKey(e.target.value);
              },
              style: { paddingRight: 32 }
            }),
            h("button", {
              type: "button",
              onClick: () => setShowKey((v) => !v),
              title: showKey ? "隐藏" : "显示",
              "aria-label": showKey ? "隐藏 API key" : "显示 API key",
              style: {
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                cursor: "pointer",
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--dsw-alias-label-tertiary)"
              }
            }, h(EyeIcon, { off: showKey }))
          )),
          h(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "center" } },
            h("button", { type: "button", className: "muche-btn", onClick: save, disabled: saving }, saving ? "保存中…" : "保存"),
            h("button", {
              type: "button",
              className: "muche-btn",
              onClick: test,
              disabled: testing,
              style: { background: "transparent", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" }
            }, testing ? "测试中…" : "测试连接"),
            h("button", {
              type: "button",
              className: "muche-btn",
              onClick: () => panelStore.toggle(),
              style: { background: "transparent", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" }
            }, "打开聊天面板"),
            status && h("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" } }, status)
          )
        );
      }
      function apply(ctx) {
        const slots = ctx.get("slots");
        if (slots === void 0) throw new Error(`muche-dsh-plugin: required service "slots" is missing (declare inject: ['slots', 'configForms'])`);
        const configForms = ctx.get("configForms");
        if (configForms === void 0 || typeof configForms.get !== "function") throw new Error(`muche-dsh-plugin: required service "configForms" is missing (declare inject: ['slots', 'configForms'])`);
        apiGet("/api/muche/health").then((res) => {
          const ns = res && res.ok && typeof res.configNs === "string" && res.configNs ? res.configNs : "muche";
          scopeStore.set(configForms.get(ns));
        }).catch(() => {
          scopeStore.set(configForms.get("muche"));
        });
        const offScope = scopeStore.subscribe(syncWsFromScope);
        const selfHealTimer = setInterval(() => wsStore.ensureConnected(), 3e4);
        const onVisible = () => {
          if (document.visibilityState === "visible") wsStore.ensureConnected();
        };
        document.addEventListener("visibilitychange", onVisible);
        ctx.on("dispose", () => {
          offScope();
          clearInterval(selfHealTimer);
          document.removeEventListener("visibilitychange", onVisible);
        });
        slots.inject("sidebar.footer.action", () => slots.register(
          { name: "sidebar.footer.action", id: "muche-entry", order: 10, label: "小沐" },
          (props) => h(MucheEntry, { wide: props ? props.wide !== false : true })
        ));
        slots.inject("shell.overlay", () => slots.register(
          { name: "shell.overlay", id: "muche-chat-panel", order: 5, label: "小沐聊天" },
          () => h(ChatPanel)
        ));
        slots.inject("settings.section", () => slots.register(
          { name: "settings.section", id: "muche", order: 30, label: "小沐" },
          () => h(MucheSettingsSection)
        ));
      }
      exports.apply = apply;
      exports.inject = ["slots", "configForms"];
      return module.exports;
    }
  });
})();
