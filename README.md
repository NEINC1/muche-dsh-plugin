# @muche/dsh-plugin — 小沐接入插件（正式版）

在 dsh 里与小沐聊天：左下角「小沐」入口 → 可拖动聊天浮层面板（微信式气泡/时间/分页），设置页填后端地址 + 自己的 API key（多用户各自配置）。小沐的主动消息（挂念/提醒）经 WS 实时弹入面板，面板关闭时入口显示未读红点。**面板不显示内心独白**（2026-08-15 用户拍板：消息上方的 💭 行已移除；`inner_thought` 数据仍照常解析，恢复显示只需加回 `client/client.js` bubble 渲染）。

**架构（勿改回）**：小沐聊天 = 插件自绘面板 + 直连后端（HTTP 历史 + WS 双向），**不进 dsh agent 循环、不建 dsh 会话**。原因（实测结论 2026-08-14）：
- dsh 会话的隐藏机制与可聊天互斥：归档会在当前会话被归档时被客户端强制清空选择；header.origin='subagent' 触发 api-remotes 的 subagent 路由门控（普通 session.prompt 被 agent-busy 拒绝）；blank/无 cwd 等通道同样不可用；
- 会话内 LLM 调用会把 AGENTS.md/runtime context/委派通知注入成 role='user' 消息——面板形态从根上消除注入面。

## 模块结构

| 文件 | 职责 |
|---|---|
| `cordis.patch.yml` | 组合包层（`package.json` 的 `dsh.bundle.patch`）：`dsh plugin add` 装包时自动进 profile 层列表，免手写 YAML |
| `lib/index.js` | Host 入口（inject/apply） |
| `lib/config.js` | settings 命名空间 'muche'（backendUrl/apiKey）+ 旧 JSON 配置迁移 |
| `lib/http.js` | 后端 JSON 请求封装（原生 fetch，统一错误形态） |
| `lib/routes.js` | `/api/muche/{chat,history,config,test}` HTTP 路由（浏览器同源直调；chat 为 WS 未就绪时的降级通道） |
| `client/client.js` | 客户端入口（入口按钮/聊天面板/设置页；`__ModuleLoader__` 格式，导出 inject/apply） |

## WS 双向（Task 3，2026-08-15；同源代理形态）

浏览器连本机 dsh 同源代理 `ws(s)://<dsh 主机>/api/muche/ws?token=<apiKey>`（经隧道可达），
Host 侧 `lib/ws-proxy.js` 按配置的 backendUrl 透传 upgrade 到后端（backendUrl 的 path
原样保留：远端 `http(s)://<公网>/api` 透传到 `/api/ws`，同机直连透传到 `/ws`；零注入）。

- 上行：`{"type":"user_message","message_id","message"}`（聊天主通道）/ `{"type":"tool_result","message_id","tool_result_fact"}`；`message_id` 幂等（服务端 Redis SET NX 300s，同 id 重发回 `duplicate`，不重复执行）。
- 下行：`{"type":"proactive","messages","inner_thought",...}`（主动消息，实时弹入+红点）；`{"type":"reply","message_id","messages","inner_thought","degraded","waiting_for_decision","superseded"}`（空+失败→面板系统提示并钉住到下一次发送，空+等待/被合并→静默）；`{"type":"error","message_id","error"}`；额度用尽为 `code:"message_quota_exhausted"` + `reset_at`（面板提示恢复时刻并禁发到恢复点）。
- 心跳：客户端 25s ping（服务端 60s 无消息断开）；断线指数退避重连（≤30s）；设置页保存后换连新 key。
- HTTP 历史 `/api/muche/history` 保留（分页来源），HTTP chat 降级通道与 WS 同达后端 `chat_core`（行为同源）；降级请求沿用 WS 生成的 `message_id`，避免发送竞态产生第二条用户消息。若使用同源 WS 代理，upgrade 阶段的浏览器/后端 `head` 缓冲必须按来源互喂，否则后端会报 `incorrect masking`。

## 安装（每个用户的 dsh 实例一次）

插件是**自带配置层的 bundle**（`dsh.bundle.patch` → `cordis.patch.yml`）：`dsh plugin add`
装包时 dsh 会自动把本包追加进 profile 的 `dsh.profile.bundles`，**不需要手工编辑
YAML**（2026-09-19 起；此前必须手写才启用）。

```bash
dsh --profile web plugin add <包名/本地路径/tgz>   # 例：add ./dsh；发行包用 /dl/ 下载到的 muche-dsh-plugin-<版本>.tgz
dsh --profile web --dump-config | grep -c '^# == @muche/dsh-plugin$'   # 期望 1：本包恰好贡献一层
sudo systemctl restart dsh-web            # 生效
```

> 断言数的是**层标题**：直接 `grep -c '@muche/dsh-plugin'` 会数到 2 行（层标题 + 插件行的
> `name`），把正常安装误判成重复加载。重复加载的判据是层标题出现 2 次。老装法手写行 +
> bundle 层并存时就是这个症状。

用户侧安装（一条命令、老装法自动迁移）见实施方案
[`docs/archive/2026-09-19-dsh-plugin-distribution.md`](../docs/archive/2026-09-19-dsh-plugin-distribution.md)；
出包用 `make pack-dsh-plugin`（`scripts/pack_dsh_plugin.sh`：打包前跑测试守卫 → `pnpm pack`
→ sha256 + `versions.json`，产物在 `deploy/artifacts/`，不入 git，由 nginx `/dl/` 提供下载）。

**老装法迁移（2026-09-19 之前装过的机器，含本机与服务器 dsh）**：删掉
`$DSH_HOME/profiles/web/cordis.patch.yml` 里手写的那段——

```yaml
- insert:
    - id: muche
      name: '@muche/dsh-plugin'
```

**必须删**：`insert` 不按 id 去重，Bundle 层自带同一 id 的行，两行会让插件被加载两次。
删完后 `dsh plugin add` 一次（已装则先 `remove` 再 `add`）并重启。

**依赖说明（勿改回 dependencies）**：`@deepseek-ai/schemastery` 声明为
`peerDependencies`——由 dsh 安装提供，每次启动 profile 时 dsh 把安装的依赖闭包
镜像到 `$DSH_HOME/profiles/node_modules`，插件按 Node 解析规则用宿主那一份
（不装第二份、版本跟随用户的 dsh）。`ws` 是本包自有的真实依赖，留在
`dependencies`。改动这两类依赖前后必须 `pnpm test`
（`test/deps.test.js` 按 Node 真实解析规则守卫，2026-08-16 崩溃循环事故的教训）。

## 卸载

```bash
dsh --profile web plugin remove '@muche/dsh-plugin'
sudo systemctl restart dsh-web            # 摘层生效
```

`remove` 只摘掉插件层与代码，重装免配——本机配置（settings 命名空间 `muche`：
后端地址/API key）会保留。

彻底清掉：按 dsh settings 用法删掉 `muche` 命名空间。
反向桥接不落任何本地文件（任务去重集只在内存），卸载即清。

## 能力桥（小沐调用用户本机 dsh，反向桥接）

方向：后端拨不进用户机器（NAT），不建任何入站隧道。用户本机插件经出站常驻
WS（`channel=dsh-bridge`，配了 API key 即在线）连后端；
小沐的 dsh 工具任务由后端从这条连接递下来（`dsh_task`：`task_id`/`task`/
`session_id?`），插件在本机进程内执行（`dsh-call.js` 执行核：建会话/发消息走
进程内直调 `ctx.sessionController.create/prompt`，与人用客户端同一实现，零 wire
复制；回复走进程内 `ctx.on('session/event')` 事件流收集，零轮询），结果以
`dsh_result` 原路回传。实现见 `lib/dsh-bridge.js`，传输类为 `lib/backend_ws.js` 的
`BackendWs`（通道名不同，后端额度池独立）。

语义（一任务只执行一次）：后端选该用户一个桥接连下发（多机多连不扇出），
插件侧 `task_id` 去重；同 `session_id` 的任务按到达序串行执行（后任务等前任务的
turn/end 监听退订后再 prompt，新会话彼此独立可并发；追单 `dsh_append` 除外，
它只向同一会话 queue 追消息、不另起 waiter，与在途轮合并只出一个结果）；
发送失败/桥接中途断开→在途任务立即失败（本机孤儿
计算一并中止），用户重试即新 `task_id`；无桥接（dsh 未开/插件旧）→后端明确
失败事实，不回退调服务器。会话复用：请求带 `session_id` → 跳过 create 直接
prompt 该会话（上下文延续）；不带 → 新建会话（标题由 dsh 自动生成）。继续/新开由
小沐（LLM）在 `tool_use.arguments.session` 工作区别名（`sN`，见【dsh工作区】）里决定：
写别名即复用，不写即新建；别名解析与落账由后端工作区 Owner 持有；
复用正在运行中的别名即追单并单：追加需求并进在途 run（DB 行锁合并 + append 帧
同步执行侧），最终只出一个工具结果，不起新 run。

- 任务约束：`task` 必填（4000 字截断）；`agentPreset` 可选，默认 `ptc`。
- 发消息带 client-minted `requestId`（服务端按 rpcId 去重，同 id 重发不重复执行）。
- 已知债：agentPreset 暂用 ptc（功能全），生产化应为小沐建受限 preset + 独立工作区。

## 维护约定

- 后端契约：`/chat`、`/chat/history`、`/auth/me`、`/ws`（muche 仓库 `src/api/app.py` / `ws.py` / `chat_core.py`）；改契约先对账本插件 `routes.js` + `client.js` 的 wsStore。
- 能力桥契约：`dsh-bridge`（执行核 `dsh-call.js`）与后端 `src/infra/dsh.py` + `src/api/ws.py`（桥接池/`dsh_task`/`dsh_result`）+ `src/domains/tools/registry.py`（dsh 工具条目）对账；回复获取只走事件流（`dsh-call.js` 的 `ctx.on('session/event')`），禁轮询。
- 每用户配置：dsh settings 命名空间 'muche'（本机 dsh 配置，key 由小沐 web 后台签发）。
  **backendUrl 写法**：同机直连 `http://127.0.0.1:8000`；远端经公网入口必须带 `/api`
  前缀（`http://<地址>/api`）——公网 nginx 只反代 `/api/` 到后端，少写前缀会拿到 SPA
  首页（200 text/html），插件侧表现为连接失败（2026-09-19 实测修正）。
- 消息总线单点：面板消息 set 逻辑在 `ChatPanel`（WS 下行消费 + 历史加载共用 normalize/append 路径）。
- 客户端门控（2026-09-11 治本）：bundle 的 `exports.inject` 声明 `slots`（fiber 激活门控），`package.json` 的 `dsh.client.inject` 声明 renderer 包（bundle 到达门控），`apply` 禁 `slots` 缺席静默返回（须 loud 抛错）；改动由 `test/client-gating.test.js` 守卫。


**测试**：`cd dsh && pnpm test`（deps.test.js 依赖守卫；**重启 dsh-web 前必跑**——AGENTS.md §10 依赖铁律）。
