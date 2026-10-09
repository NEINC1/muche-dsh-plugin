(() => {
  // lib/errors.js
  var NEED_SETUP = "NEED_SETUP";
  var NEED_KEY = "NEED_KEY";
  var AUTH_FAILED = "AUTH_FAILED";
  var NOT_API = "NOT_API";
  var UPSTREAM_HTML = "UPSTREAM_HTML";
  var NETWORK = "NETWORK";
  var TIMEOUT = "TIMEOUT";
  var CURSOR_INVALID = "CURSOR_INVALID";
  var QUOTA = "QUOTA";
  var RATE_LIMITED = "RATE_LIMITED";
  var TARGET = "TARGET";
  var FORBIDDEN = "FORBIDDEN";
  var HOST_UNAVAILABLE = "HOST_UNAVAILABLE";
  var INVALID_RESPONSE = "INVALID_RESPONSE";
  var HTTP_ERROR = "HTTP_ERROR";
  var STALE_RUNTIME = "STALE_RUNTIME";
  var INPUT_INVALID = "INPUT_INVALID";
  var BRIDGE_DEPENDENCIES = "BRIDGE_DEPENDENCIES";
  var BRIDGE_STARTUP = "BRIDGE_STARTUP";
  var BRIDGE_OFFLINE = "BRIDGE_OFFLINE";
  var CONFIG_CODES = /* @__PURE__ */ new Set([NEED_SETUP, NEED_KEY, AUTH_FAILED, TARGET, NOT_API]);
  var QUOTA_CODES = /* @__PURE__ */ new Set([QUOTA, "message_quota_exhausted"]);
  var INPUT_CODES = /* @__PURE__ */ new Set([INPUT_INVALID, CURSOR_INVALID]);
  var BRIDGE_CODES = /* @__PURE__ */ new Set([BRIDGE_DEPENDENCIES, BRIDGE_STARTUP, BRIDGE_OFFLINE]);
  var TIMEOUT_CODES = /* @__PURE__ */ new Set([
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ABORT_ERR",
    "ERR_OPERATION_TIMED_OUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT"
  ]);
  var NETWORK_CODES = /* @__PURE__ */ new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENETDOWN",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ERR_NETWORK",
    "UND_ERR_SOCKET",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID"
  ]);
  function exceptionCode(error) {
    const seen = /* @__PURE__ */ new Set();
    for (let e = error; e && typeof e === "object" && !seen.has(e); e = e.cause) {
      seen.add(e);
      if (e.name === "TimeoutError" || e.name === "AbortError" || TIMEOUT_CODES.has(e.code)) return TIMEOUT;
      if (e.name === "NetworkError" || NETWORK_CODES.has(e.code)) return NETWORK;
    }
    return "";
  }
  function classifyFailure(fact = {}) {
    const f = fact || {};
    const status = Number(f.status) || 0;
    let code = typeof f.code === "string" ? f.code : "";
    if (!code && status === 401) code = AUTH_FAILED;
    else if (!code && status === 403) code = FORBIDDEN;
    else if (!code && status === 429) code = RATE_LIMITED;
    if (!code) code = exceptionCode(f.error);
    const out = (kind, fallback, text, advice = "", retryable = false) => ({ kind, code: code || fallback, text, advice, retryable });
    if (CONFIG_CODES.has(code) || !code && f.kind === "config") {
      return out("config", NEED_SETUP, "请检查配置", "打开 dsh 设置 → 小沐，检查配置后保存");
    }
    if (code === FORBIDDEN) {
      return out("access", FORBIDDEN, "访问被拒绝", "请确认访问权限及来源限制");
    }
    if (code === RATE_LIMITED) return out("operation", RATE_LIMITED, "请求过于频繁，请稍后重试", "", true);
    if (QUOTA_CODES.has(code) || f.kind === "quota") {
      return out("quota", QUOTA, "消息额度已用完", "请等待额度恢复");
    }
    if (f.kind === "bridge" || BRIDGE_CODES.has(code)) {
      const startup = code === BRIDGE_DEPENDENCIES || code === BRIDGE_STARTUP;
      return out(
        "bridge",
        startup ? BRIDGE_STARTUP : BRIDGE_OFFLINE,
        startup ? "本机 dsh 启动失败" : "本机 dsh 连接异常",
        "请检查本机 dsh 状态及后端连接",
        typeof f.retryable === "boolean" ? f.retryable : code === NETWORK || code === TIMEOUT || code === UPSTREAM_HTML
      );
    }
    if (code === NETWORK || code === TIMEOUT || code === UPSTREAM_HTML) {
      return out("connection", NETWORK, "连接暂时中断，正在重连", "请稍候，连接恢复后重试", true);
    }
    if (code === HOST_UNAVAILABLE || code === STALE_RUNTIME) {
      return out(
        "host",
        HOST_UNAVAILABLE,
        code === STALE_RUNTIME ? "本机插件尚未就绪" : "本机服务暂不可用",
        "请检查本机服务与插件状态",
        code !== STALE_RUNTIME
      );
    }
    if (INPUT_CODES.has(code) || f.kind === "input") {
      const correction = typeof f.text === "string" ? f.text : typeof f.error === "string" ? f.error : "";
      return out(
        "input",
        INPUT_INVALID,
        correction || (code === CURSOR_INVALID ? "历史位置无效，请重新加载" : "请检查输入后重试")
      );
    }
    if (f.kind === "config") return out("config", TARGET, "请检查配置", "打开 dsh 设置 → 小沐，检查配置后保存");
    if (f.kind === "access") return out("access", FORBIDDEN, "访问被拒绝", "请确认访问权限及来源限制");
    if (f.kind === "host") return out("host", HOST_UNAVAILABLE, "本机服务暂不可用", "请检查本机服务与插件状态", true);
    if (f.kind === "connection") return out("connection", NETWORK, "连接暂时中断，正在重连", "请稍候，连接恢复后重试", true);
    return out(
      "operation",
      HTTP_ERROR,
      f.kind === "operation" && typeof f.text === "string" && f.text ? f.text : code === INVALID_RESPONSE ? "服务响应异常，请稍后重试" : "操作未完成，请稍后重试",
      "如仍失败，请检查服务状态",
      status >= 500 || status === 408 || status === 425
    );
  }

  // client/src/api.js
  async function request(path, { method = "GET", body, context, signal } = {}) {
    const headers = {};
    if (body !== void 0) headers["Content-Type"] = "application/json";
    if (context) {
      headers["X-Muche-Runtime"] = context.runtimeId;
      headers["X-Muche-Generation"] = String(context.generation);
    }
    try {
      const response = await fetch(path, { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body), signal });
      let value;
      try {
        value = await response.json();
      } catch {
        return { ok: false, code: INVALID_RESPONSE, status: response.status, error: "连接暂时不可用", localFailure: true };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: INVALID_RESPONSE, error: "连接暂时不可用", localFailure: true };
      return { ...value, ok: response.ok && value.ok !== false, status: value.status ?? response.status };
    } catch (error) {
      if (signal?.aborted) return { ok: false, code: STALE_RUNTIME, error: "请求已取消" };
      console.warn("muche client: same-origin request failed", String(error?.name || "Error"));
      return { ok: false, code: HOST_UNAVAILABLE, status: 0, error: "连接暂时中断，正在重连", localFailure: true };
    }
  }
  var apiGet = (path, options) => request(path, options);
  var apiPost = (path, body, options) => request(path, { ...options, method: "POST", body });

  // client/src/pure.js
  function localHM(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const d = new Date(t);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(5, 16);
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const now = /* @__PURE__ */ new Date();
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
    return d.getMonth() + 1 + "月" + d.getDate() + "日 " + hm;
  }
  function gapMinutes(a, b) {
    if (!a || !b) return null;
    const x = Date.parse(a), y = Date.parse(b);
    return Number.isFinite(x) && Number.isFinite(y) ? (y - x) / 6e4 : null;
  }
  function clipboardImageFiles(clipboard) {
    if (!clipboard) return [];
    const fromItems = Array.from(clipboard.items || []).filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
    return fromItems.length ? fromItems : Array.from(clipboard.files || []).filter((file) => String(file.type || "").startsWith("image/"));
  }

  // lib/runtime-contract.js
  function sameRuntimeContext(a, b) {
    return !!a && !!b && a.runtimeId === b.runtimeId && a.configNs === b.configNs && a.generation === b.generation;
  }
  function isRuntimeSnapshot(value) {
    return value?.schema === 1 && typeof value.runtimeId === "string" && !!value.runtimeId && typeof value.configNs === "string" && !!value.configNs && Number.isSafeInteger(value.generation) && value.generation >= 0 && Number.isSafeInteger(value.seq) && value.seq >= 0 && ["connecting", "online", "offline"].includes(value.chat?.phase) && !!value.configuration && !!value.bridge;
  }
  function projectClientRuntime(snapshot, delivery) {
    const phase = delivery.status === "offline" || snapshot?.chat.phase === "offline" ? "offline" : snapshot?.chat.phase === "online" && delivery.synced ? "online" : "connecting";
    const problem = snapshot?.configuration.code ? snapshot.problem : delivery.status === "offline" ? classifyFailure({ code: HOST_UNAVAILABLE }) : snapshot?.problem || null;
    return {
      phase,
      label: phase === "online" ? "在线" : phase === "offline" ? "离线" : "连接中",
      problem,
      context: snapshot ? { runtimeId: snapshot.runtimeId, configNs: snapshot.configNs, generation: snapshot.generation } : null,
      snapshot
    };
  }
  function isSameProblem(failure, problem) {
    if (!failure || !problem) return false;
    const structural = /* @__PURE__ */ new Set(["config", "connection", "host", "access"]);
    return failure.kind === problem.kind && (structural.has(failure.kind) || failure.code === problem.code);
  }

  // client/src/runtime-store.js
  function createRuntimeClient({ fetchSnapshot = (signal) => apiGet("/api/muche/runtime", { signal }), createEventSource = (path) => new EventSource(path), setTimer = setTimeout, clearTimer = clearTimeout, retryBaseMs = 3e3, retryMaxMs = 3e4 } = {}) {
    const listeners = /* @__PURE__ */ new Set(), frameListeners = /* @__PURE__ */ new Set(), pendingFrames = [];
    let snapshot = null, delivery = { status: "connecting", synced: false };
    let view = projectClientRuntime(snapshot, delivery);
    let source = null, sourceEpoch = 0, sourceBinding = null, streamContext = null;
    let identityPending = false, disposed = false, started = false;
    let retryTimer = null, deadlineTimer = null, attempts = 0, bootstrap = null, messageSeq = 0;
    const identityMatches = (a, b) => !!a && !!b && a.runtimeId === b.runtimeId && a.configNs === b.configNs;
    function emit() {
      view = projectClientRuntime(snapshot, delivery);
      if (identityPending) view = { ...view, context: null };
      for (const fn of [...listeners]) {
        try {
          fn(view);
        } catch (error) {
          console.error("muche client: runtime subscriber failed", String(error?.name || "Error"));
        }
      }
    }
    function retry() {
      if (disposed || retryTimer) return;
      const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempts++, 4));
      retryTimer = setTimer(() => {
        retryTimer = null;
        open();
        void refresh();
      }, delay);
    }
    function retire({ conflict = false, immediate = false, phase = "offline" } = {}) {
      ++sourceEpoch;
      bootstrap?.abort();
      bootstrap = null;
      if (deadlineTimer) {
        clearTimer(deadlineTimer);
        deadlineTimer = null;
      }
      if (source) {
        const old = source;
        source = null;
        old.onopen = old.onmessage = old.onerror = null;
        try {
          old.close();
        } catch (error) {
          console.warn("muche client: stream close failed", String(error?.name || "Error"));
        }
      }
      sourceBinding = streamContext = null;
      if (conflict) {
        identityPending = true;
        pendingFrames.length = 0;
      }
      delivery = { status: phase, synced: false };
      emit();
      if (immediate) {
        open();
        void refresh();
      } else retry();
    }
    function applySnapshot(next, { stream = false } = {}) {
      if (disposed || !isRuntimeSnapshot(next)) return false;
      if (snapshot && next.runtimeId === snapshot.runtimeId) {
        if (next.generation < snapshot.generation || next.seq < snapshot.seq) return false;
        if (next.configNs !== snapshot.configNs) return false;
      }
      if (snapshot && !sameRuntimeContext(snapshot, next)) {
        if (stream) {
          console.warn("muche client: stale stream scope refused; resynchronizing");
          retire({ conflict: true, immediate: true });
          return false;
        }
        pendingFrames.length = 0;
        if (sourceBinding && !identityMatches(sourceBinding, next)) retire({ immediate: true, phase: "connecting" });
      }
      snapshot = next;
      sourceBinding = { runtimeId: next.runtimeId, configNs: next.configNs };
      identityPending = false;
      if (stream) {
        delivery = { status: "ready", synced: true };
        attempts = 0;
        streamContext = { runtimeId: next.runtimeId, configNs: next.configNs, generation: next.generation };
      }
      emit();
      return true;
    }
    async function refresh() {
      if (disposed || bootstrap) return;
      const controller = new AbortController(), before = snapshot, epoch = sourceEpoch;
      bootstrap = controller;
      try {
        const result = await fetchSnapshot(controller.signal);
        if (disposed || bootstrap !== controller || epoch !== sourceEpoch) return;
        if (result?.ok && result.snapshot) {
          if (streamContext && source?.readyState === 1 && sameRuntimeContext(streamContext, result.snapshot)) delivery = { status: "ready", synced: true };
          applySnapshot(result.snapshot);
        } else if ((result?.localFailure || result?.code === HOST_UNAVAILABLE) && !(snapshot !== before && delivery.synced)) {
          delivery = { status: "offline", synced: false };
          emit();
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted && bootstrap === controller) {
          console.warn("muche client: runtime bootstrap failed", String(error?.name || "Error"));
          if (!(snapshot !== before && delivery.synced)) {
            delivery = { status: "offline", synced: false };
            emit();
          }
        }
      } finally {
        if (bootstrap === controller) bootstrap = null;
      }
    }
    function open() {
      if (disposed || source) return;
      const epoch = ++sourceEpoch;
      sourceBinding = streamContext = null;
      let es;
      try {
        es = createEventSource("/api/muche/events");
      } catch (error) {
        console.warn("muche client: stream construction failed", String(error?.name || "Error"));
        delivery = { status: "offline", synced: false };
        emit();
        retry();
        return;
      }
      source = es;
      const current = () => !disposed && source === es && sourceEpoch === epoch;
      const armDeadline = (ms) => {
        if (deadlineTimer) clearTimer(deadlineTimer);
        deadlineTimer = setTimer(() => {
          deadlineTimer = null;
          if (current()) retire();
        }, ms);
      };
      es.onopen = () => {
        if (!current()) return;
        streamContext = null;
        delivery = { status: "connecting", synced: false };
        emit();
        armDeadline(15e3);
        void refresh();
      };
      es.onmessage = (event) => {
        if (!current()) return;
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          console.warn("muche client: malformed event frame");
          return;
        }
        if (frame?.type === "runtime") {
          if (applySnapshot(frame.snapshot, { stream: true })) armDeadline(6e4);
          return;
        }
        if (!sameRuntimeContext(frame?.context, snapshot) || !sameRuntimeContext(streamContext, snapshot)) return;
        armDeadline(6e4);
        if (!delivery.synced) {
          delivery = { status: "ready", synced: true };
          emit();
        }
        if (frame.type === "heartbeat") return;
        if (!frameListeners.size) {
          pendingFrames.push(frame);
          if (pendingFrames.length > 20) pendingFrames.shift();
          return;
        }
        for (const fn of [...frameListeners]) {
          try {
            fn(frame);
          } catch (error) {
            console.error("muche client: message subscriber failed", String(error?.name || "Error"));
          }
        }
      };
      es.onerror = () => {
        if (!current()) return;
        delivery = { status: "offline", synced: false };
        streamContext = null;
        if (deadlineTimer) {
          clearTimer(deadlineTimer);
          deadlineTimer = null;
        }
        emit();
        if (es.readyState === 2) retire();
      };
    }
    return {
      getSnapshot: () => view,
      context: () => view.context,
      accepts: (context) => !disposed && !identityPending && sameRuntimeContext(context, snapshot),
      subscribe(fn) {
        listeners.add(fn);
        fn(view);
        return () => listeners.delete(fn);
      },
      subscribeFrames(fn) {
        frameListeners.add(fn);
        for (const frame of pendingFrames.splice(0)) if (sameRuntimeContext(frame.context, snapshot)) fn(frame);
        return () => frameListeners.delete(fn);
      },
      applySnapshot,
      observeReply(context, result) {
        if (disposed || identityPending || !sameRuntimeContext(context, snapshot)) return false;
        if (result?.snapshot) applySnapshot(result.snapshot);
        if (identityPending || !sameRuntimeContext(context, snapshot) || result?.code === STALE_RUNTIME) return false;
        if (result?.localFailure || result?.code === HOST_UNAVAILABLE) {
          delivery = { status: "offline", synced: false };
          emit();
          void refresh();
        }
        return true;
      },
      newId(prefix = "m") {
        return `${prefix}-${Date.now()}-${++messageSeq}`;
      },
      start() {
        if (started || disposed) return;
        started = true;
        open();
        void refresh();
      },
      ensureConnected() {
        if (!disposed && !source && !retryTimer) {
          open();
          void refresh();
        }
      },
      refresh,
      dispose() {
        if (disposed) return;
        disposed = true;
        ++sourceEpoch;
        bootstrap?.abort();
        bootstrap = null;
        if (retryTimer) clearTimer(retryTimer);
        if (deadlineTimer) clearTimer(deadlineTimer);
        retryTimer = deadlineTimer = null;
        if (source) {
          source.onopen = source.onmessage = source.onerror = null;
          source.close();
          source = null;
        }
        listeners.clear();
        frameListeners.clear();
        pendingFrames.length = 0;
      }
    };
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
      const runtimeStore = createRuntimeClient();
      function useRuntime() {
        const [value, setValue] = React.useState(runtimeStore.getSnapshot());
        React.useEffect(() => runtimeStore.subscribe(setValue), []);
        return value;
      }
      async function runtimeRequest(path, body) {
        const context = runtimeStore.context();
        if (!context) return { ok: false, stale: true, code: STALE_RUNTIME };
        const res = body === void 0 ? await apiGet(path, { context }) : await apiPost(path, body, { context });
        const current = runtimeStore.observeReply(context, res);
        return current ? res : { ok: false, stale: true, code: STALE_RUNTIME };
      }
      const scopeStore = {
        scope: null,
        namespace: null,
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
      function MucheEntry({ wide }) {
        const open = usePanelOpen();
        const unread = useUnread();
        const entryTitle = open ? "小沐面板已打开" : unread > 0 ? `小沐有 ${unread} 条未读` : "打开小沐";
        if (!wide) {
          return h(
            "button",
            {
              type: "button",
              onClick: () => panelStore.toggle(),
              title: entryTitle,
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
            title: entryTitle,
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
        const runtime = useRuntime();
        const problem = runtime.problem;
        const contextKey = runtime.context ? runtime.context.runtimeId + ":" + runtime.context.generation : "";
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
        const [inline, setInline] = React.useState(null);
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
        const failedImgsRef = React.useRef(/* @__PURE__ */ new Set());
        const markImgFailed = (src) => {
          if (!src || failedImgsRef.current.has(src)) return;
          failedImgsRef.current.add(src);
          setMsgs(renderMerged(baseRef.current));
        };
        const noticesRef = React.useRef(/* @__PURE__ */ new Map());
        const quotaUntilRef = React.useRef(0);
        const setQuota = (ms) => {
          quotaUntilRef.current = ms;
          setQuotaUntil(ms);
        };
        const failureNotice = () => ({ kind: "operation", text: "这条消息暂时没处理完，请稍后重试" });
        const withSticky = (rows2) => {
          const remaining = new Map(noticesRef.current);
          const result = [];
          for (const row of rows2) {
            result.push(row);
            const id = row.mid || row.delivery_id;
            if (id && remaining.has(id)) {
              result.push(remaining.get(id));
              remaining.delete(id);
            }
          }
          return [...result, ...remaining.values()];
        };
        const stickNotice = (failure, ts, mid) => {
          noticesRef.current.set(mid || "operation", { role: "system", content: failure.text, inner_thought: "", ts, notice: true, failure, mid });
          if (noticesRef.current.size > 50) noticesRef.current.delete(noticesRef.current.keys().next().value);
        };
        const reportFailure = (fact, { operation = "request", ts, mid } = {}) => {
          if (!fact || fact.stale || fact.code === STALE_RUNTIME) return;
          const failure = classifyFailure(fact);
          if (failure.kind === "quota") {
            const until = Date.parse(fact.reset_at);
            if (Number.isFinite(until) && until > Date.now()) setQuota(until);
            return;
          }
          if (isSameProblem(failure, runtimeStore.getSnapshot().problem)) return;
          if (operation === "message") {
            stickNotice(failure, ts || (/* @__PURE__ */ new Date()).toISOString(), mid);
            setMsgs(renderMerged(baseRef.current));
          } else setInline({ ...failure, operation: failure.kind === "input" ? "input" : operation });
        };
        const previousProblemRef = React.useRef(null);
        React.useEffect(() => {
          const previous = previousProblemRef.current;
          previousProblemRef.current = problem;
          if (!previous || isSameProblem(previous, problem)) return;
          setInline((current) => isSameProblem(current, previous) ? null : current);
          let changed = false;
          for (const [id, notice] of noticesRef.current) {
            if (isSameProblem(notice.failure, previous)) {
              noticesRef.current.delete(id);
              changed = true;
            }
          }
          if (changed) setMsgs(renderMerged(baseRef.current));
        }, [problem]);
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
          if (res?.stale) return;
          settleInflight(mid);
          if (!res?.ok) {
            reportFailure(res, { operation: "message", ts: nowIso, mid });
            return;
          }
          if (noticesRef.current.delete(mid)) setMsgs(renderMerged(baseRef.current));
          const parts = (res.messages || []).map((t) => ({ role: "assistant", content: String(t), inner_thought: res.inner_thought || "", ts: nowIso }));
          if (res.degraded && parts.length === 0 && !res.superseded && !res.waiting_for_decision) {
            reportFailure(failureNotice(), { operation: "message", ts: nowIso, mid });
          } else if (parts.length > 0) overlayAdd(parts);
        };
        const normalize = (rows2) => (rows2 || []).map((m) => ({
          role: m.role === "system" ? "system" : m.role === "user" ? "user" : "assistant",
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
          setInline((current) => current?.operation === "input" ? null : current);
          const okTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
          for (const f of list) {
            if (pendingImages.length >= 3) {
              reportFailure({ kind: "input", text: "最多发 3 张图" });
              break;
            }
            if (okTypes.indexOf(f.type) < 0) {
              reportFailure({ kind: "input", text: "只支持 JPEG/PNG/GIF/WebP" });
              continue;
            }
            if (f.size > 8 * 1024 * 1024) {
              reportFailure({ kind: "input", text: "单张图最大 8M" });
              continue;
            }
            const reader = new FileReader();
            const context = runtimeStore.context();
            reader.onload = () => {
              if (context && !runtimeStore.accepts(context)) return;
              setPendingImages((prev) => prev.length >= 3 ? prev : [...prev, String(reader.result || "")]);
            };
            reader.readAsDataURL(f);
          }
        };
        const settleInflight = (mid) => {
          if (mid) inflightRef.current.delete(mid);
          if (inflightRef.current.size === 0) setThinking(false);
        };
        React.useEffect(() => {
          const off = runtimeStore.subscribeFrames((data) => {
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
              settleInflight(data.message_id);
              if (data.duplicate) return;
              if (noticesRef.current.delete(data.message_id)) setMsgs(renderMerged(baseRef.current));
              const parts = (data.messages || []).map((t) => ({
                role: "assistant",
                content: String(t),
                inner_thought: data.inner_thought || "",
                ts: nowIso
              }));
              if (data.degraded && parts.length === 0 && !data.superseded && !data.waiting_for_decision) {
                reportFailure(failureNotice(), { operation: "message", ts: nowIso, mid: data.message_id });
              } else if (parts.length > 0) {
                overlayAdd(parts);
              }
            } else if (data.type === "dialogue_updated") {
              refreshNew();
            } else if (data.type === "error" && data.message_id && inflightRef.current.has(data.message_id)) {
              settleInflight(data.message_id);
              reportFailure(data, { operation: "message", ts: nowIso, mid: data.message_id });
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
        const fetchNew = React.useCallback(() => runtimeRequest("/api/muche/history?limit=20"), []);
        const loadHistory = React.useCallback(() => {
          return runtimeRequest("/api/muche/history?limit=50").then((res) => {
            if (res?.stale) return false;
            if (!res?.ok) {
              reportFailure(res, { operation: "history" });
              return false;
            }
            const page = normalize(res.messages);
            baseRef.current = page;
            reconcileOverlay();
            setMsgs(renderMerged(page));
            setHasMore(!!res.has_more);
            setOlderCursor(typeof res.next_before === "string" && res.next_before ? res.next_before : null);
            if (!res.has_more) setReachedStart(true);
            setInline((current) => current?.operation === "history" ? null : current);
            syncSeqRef.current += 1;
            return true;
          });
        }, []);
        const refreshNew = React.useCallback(() => {
          return fetchNew().then((delta) => {
            if (delta?.stale) return false;
            if (!delta.ok) {
              reportFailure(delta, { operation: "history" });
              return false;
            }
            setInline((current) => current?.operation === "history" ? null : current);
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
        const authFpRef = React.useRef("");
        React.useEffect(() => {
          if (!contextKey) return;
          if (authFpRef.current && authFpRef.current !== contextKey) {
            baseRef.current = [];
            overlayRef.current = [];
            noticesRef.current.clear();
            inflightRef.current.clear();
            setMsgs([]);
            setThinking(false);
            setInline(null);
            setInput("");
            setPendingImages([]);
            setQuota(0);
            setHasMore(false);
            setOlderCursor(null);
            setReachedStart(false);
            setLoadingOlder(false);
            failedImgsRef.current.clear();
            preserveRef.current = null;
            if (olderTimerRef.current) {
              clearTimeout(olderTimerRef.current);
              olderTimerRef.current = null;
            }
          }
          authFpRef.current = contextKey;
          if (!open) return;
          let cancelled = false;
          setLoading(true);
          stickRef.current = true;
          setReachedStart(false);
          setOlderCursor(null);
          loadHistory().then(() => {
            if (!cancelled) setLoading(false);
          });
          return () => {
            cancelled = true;
          };
        }, [open, contextKey, loadHistory]);
        const wasOnlineRef = React.useRef(false);
        React.useEffect(() => {
          const wasOnline = wasOnlineRef.current;
          wasOnlineRef.current = runtime.phase === "online";
          if (!wasOnline && runtime.phase === "online" && open) void refreshNew();
        }, [runtime.phase, open, refreshNew]);
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
        React.useEffect(() => () => {
          if (olderTimerRef.current) clearTimeout(olderTimerRef.current);
        }, []);
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
          runtimeRequest("/api/muche/history?limit=50" + (cursor ? "&before=" + encodeURIComponent(cursor) : "")).then((res) => {
            if (res?.stale) return;
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
              if (res?.code === "CURSOR_INVALID") void loadHistory();
              else reportFailure(res, { operation: "history" });
            }
          }, () => {
            setLoadingOlder(false);
            reportFailure({ kind: "operation", text: "加载更早的消息失败，请重试" }, { operation: "history" });
          });
        };
        const send = () => {
          const text = input.trim();
          const images = pendingImages.slice(0, 3);
          if (!text && !images.length) return;
          if (!runtimeStore.context()) return;
          if (quotaUntilRef.current > Date.now()) return;
          setInput("");
          setPendingImages([]);
          setInline((current) => current?.operation === "input" ? null : current);
          const nowIso = typeof Date !== "undefined" ? (/* @__PURE__ */ new Date()).toISOString() : "";
          const mid = runtimeStore.newId("m");
          overlayAdd([{ role: "user", content: text, inner_thought: "", ts: nowIso, previews: images, mid }]);
          setThinking(true);
          inflightRef.current.add(mid);
          runtimeRequest("/api/muche/chat", { text, message_id: mid, images: images.length ? images : void 0 }).then((res) => handleHttpReply(res, nowIso, mid));
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
          if (m.notice && isSameProblem(m.failure, problem)) continue;
          if (m.notice) {
            rows.push(h("div", { key: "notice-" + i, role: "status", style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)", marginBottom: 8 } }, "⚠ " + m.content));
            continue;
          }
          const key = m && (m.overlayKey || m.id) || i;
          let showTime = false;
          if (i === 0) showTime = true;
          else {
            const gap = gapMinutes(msgs[i - 1].ts, m.ts);
            if (gap === null || gap > 2) showTime = true;
          }
          if (m.role === "system") {
            rows.push(h("div", { key, role: "status", style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginBottom: 8 } }, m.content));
          } else rows.push(bubble(m, key, showTime));
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
            // The title consumes the synchronized runtime projection, never bridge state.
            h("span", {
              title: runtime.phase === "online" ? "能和小沐聊天" : runtime.phase === "connecting" ? "正在建立聊天连接" : "当前聊天连接不可用",
              style: {
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: runtime.phase === "online" ? "var(--dsw-alias-state-success-primary, #52c41a)" : runtime.phase === "connecting" ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-state-error-primary)"
              }
            }),
            h("span", {
              style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" }
            }, runtime.label),
            h("button", {
              type: "button",
              onClick: () => panelStore.close(),
              onPointerDown: (e) => e.stopPropagation(),
              style: { marginLeft: "auto", cursor: "pointer", background: "none", border: "none", color: "var(--dsw-alias-label-secondary)", fontSize: 16, padding: "2px 6px" }
            }, "×")
          ),
          // Structural faults remain outside the scrollable message list.
          problem ? h(
            "div",
            {
              style: {
                padding: "8px 14px",
                flex: "none",
                borderBottom: "1px solid var(--dsw-alias-border-l2)",
                fontSize: 12,
                lineHeight: "18px",
                // config 与 bridge 都是故障（横幅只在故障态渲染），一律错误色。
                // 此前清理废三元时把这个色值一起去掉了，变成普通正文色，看着
                // 不像告警。颜色是唯一区分「这是提示」与「这是故障」的信号。
                color: "var(--dsw-alias-state-error-primary)",
                background: "var(--dsw-alias-bg-base)"
              }
            },
            h("div", { role: "alert" }, "⚠ " + problem.text),
            problem.advice ? h("div", { style: { marginTop: 2, color: "var(--dsw-alias-label-secondary)" } }, problem.advice) : null
          ) : null,
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
            // An unrelated input/operation notice must not be swallowed by a bridge fault.
            inline && !isSameProblem(inline, problem) ? h("div", { role: "status", style: { fontSize: 13, color: "var(--dsw-alias-state-error-primary)" } }, "⚠ " + inline.text) : null,
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
        const testControllerRef = React.useRef(null);
        const scope = useScope();
        const invalidateTest = () => {
          testControllerRef.current?.abort();
          testControllerRef.current = null;
          setTesting(false);
          setStatus("");
        };
        React.useEffect(() => {
          dirtyRef.current = false;
          invalidateTest();
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
          const off = scope.subscribe(pull);
          return () => {
            off();
            testControllerRef.current?.abort();
          };
        }, [scope]);
        const save = () => {
          if (!scope) {
            setStatus("设置服务未就绪，稍后再试");
            return;
          }
          invalidateTest();
          setSaving(true);
          setStatus("");
          const ops = [];
          if (backendUrl.trim()) ops.push({ op: "set", path: ["backendUrl"], value: backendUrl.trim() });
          else ops.push({ op: "unset", path: ["backendUrl"] });
          ops.push({ op: "set", path: ["apiKey"], value: apiKey.trim() });
          Promise.resolve().then(() => scope.mutate(ops, revRef.current)).then(() => {
            setSaving(false);
            dirtyRef.current = false;
            revRef.current = scope.getSnapshot()?.revision;
            setStatus("✓ 已保存");
          }).catch((e) => {
            setSaving(false);
            dirtyRef.current = false;
            console.warn("muche settings: save rejected", String(e?.code || e?.name || "Error"));
            revRef.current = scope.getSnapshot()?.revision;
            setStatus(classifyFailure({ kind: "config" }).text);
          });
        };
        const test = () => {
          invalidateTest();
          const controller = new AbortController();
          testControllerRef.current = controller;
          setTesting(true);
          apiPost("/api/muche/health", { backendUrl: backendUrl.trim(), apiKey: apiKey.trim() }, { signal: controller.signal }).then((res) => {
            if (controller.signal.aborted || testControllerRef.current !== controller) return;
            testControllerRef.current = null;
            setTesting(false);
            const auth = res?.auth, history = res?.history;
            if (res?.ok && auth?.ok && history?.ok) setStatus("✓ 配置验证通过");
            else setStatus(classifyFailure(auth && !auth.ok ? auth : history && !history.ok ? history : res || {}).text);
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
              placeholder: "填小沐后端地址",
              onChange: (e) => {
                invalidateTest();
                dirtyRef.current = true;
                setBackendUrl(e.target.value);
              }
            })
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
                invalidateTest();
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
        const offBinding = runtimeStore.subscribe((value) => {
          const ns = value.context?.configNs;
          if (ns && scopeStore.namespace !== ns) {
            scopeStore.namespace = ns;
            scopeStore.set(configForms.get(ns));
          }
        });
        const onVisible = () => {
          if (document.visibilityState === "visible") runtimeStore.ensureConnected();
        };
        document.addEventListener("visibilitychange", onVisible);
        ctx.on("dispose", () => {
          offBinding();
          runtimeStore.dispose();
          document.removeEventListener("visibilitychange", onVisible);
          document.querySelector('style[data-plugin="muche-dsh-plugin"]')?.remove();
        });
        runtimeStore.start();
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
