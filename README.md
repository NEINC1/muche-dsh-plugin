# muche-dsh-plugin — 和有持续状态的小沐聊天

[![npm](https://img.shields.io/npm/v/muche-dsh-plugin.svg)](https://www.npmjs.com/package/muche-dsh-plugin)
[![license](https://img.shields.io/npm/l/muche-dsh-plugin.svg)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

连接小沐（MuChe 数字生命）的 dsh 插件：可以和有持续状态的小沐聊天，小沐可调用本机 dsh 执行任务。

* **聊天浮层**：左下角「小沐」入口，可拖动面板，聊天气泡，未读红点，主动消息实时弹入；输入框支持 `Ctrl+V` 粘贴图片。
* **服务端直读**：聊天记录只在服务端，面板首屏单页、增量归一、游标翻页；本机不存任何聊天文件，重装换机天然可用。
* **反向桥接**：小沐可调用你本机 dsh 执行任务（出站常驻连接，不开入站端口）。
* **设置页**：后端地址 + API key，每用户各自配置。

## 安装

在 DSH Desktop 的 DSH Terminal 里执行（裸命令默认装到当前激活 profile，
装完在托盘重启 DSH Desktop 即用）：

```bash
dsh plugin add muche-dsh-plugin
```

升级是同一条命令（重跑即升到最新版）。插件版本见 `package.json` 的 `version`（0.7.0 起使用桥接协议 v2），dsh 本体须为上游锁定的 `0.1.7-rc.2` 同 cohort（见 `pnpm-workspace.yaml`，旧 cohort 不再兼容）。`package.json` 已经 `engines.dsh`（`^0.1.7`）显式声明该要求，市场会对不满足的旧宿主阻断安装并提示升级。

注意 `dsh --profile desktop plugin add` 的父 flag 写法上游不接受（`plugin`
子命令自带 `--profile`，见上游 `rejectParentOptions`），必报
`required option '--profile <name>' not specified`——别写。

## 使用

1. 打开 dsh 设置 → 小沐，填后端地址和 API key（小沐后台生成），保存。
2. 点左下角「小沐」开聊。输入框可用 `Ctrl+V` 粘贴剪贴板图片，和点「图」按钮选图一样进入预览、校验与发送；纯文本粘贴保留浏览器原行为。反向桥接配好 key 即在线，无需额外操作。

后端地址口径：填实际后端基址（如 `<公网基址>/api`）。插件不再补写、不再要求 `/api` 结尾、也不替用户判定地址形态——部署路径归项目决定，成不成立由「测试连接」的真实请求说了算。统一健康口 `GET /api/muche/health` 一次返回鉴权＋历史＋WS 三段结论，设置页「测试连接」可带候选值试连（不写回配置）。

## 面板状态与提示

标题栏指示的是**聊天通道**是否可收发（与反向桥接无关）：

| 显示 | 含义 |
|---|---|
| 连接中 | 启动后正在建立聊天连接 |
| 在线 | 收发两侧都已就绪 |
| 离线 | 连接不可用 |

配置类问题统一显示「请检查配置」，不出现地址、接口路径等技术细节；网络中断显示「连接暂时中断，正在重连」，恢复后自动消失；额度耗尽是独立提示，不影响在线状态。结构性故障固定在面板顶部、不随消息滚动消失。

## 卸载

```bash
dsh plugin remove 'muche-dsh-plugin'
```

`remove` 只摘层与代码；本机配置（profile patch 里 `muche` 条目的配置）保留，重装免配。0.5.0 起插件不在本机存任何聊天文件；旧版遗留的本地存档（`~/muche-dsh-workspace/messages/`）原样保留，可手动删除。装完在托盘重启 DSH Desktop 生效。彻底清掉：删掉 profile patch 里 `muche` 条目的 `config` 段。

反向桥接只调用户本机：后端把任务帧从该用户的桥接连递下来，插件在本地 dsh 进程内执行、结果原路回传。桥不在时后端明确失败，不回退服务器。

## 技术细节

<details>
<summary>架构（勿改回）与模块说明</summary>

小沐聊天 = 插件自绘面板 + 直连后端（HTTP 收发 + 后端 WS 下行），**不进 dsh agent 循环、不建 dsh 会话**（dsh 会话的隐藏机制与可聊天互斥，会话内 LLM 调用会注入 AGENTS.md 等噪音——面板形态从根上消除注入面）。

状态只有一条链路：官方配置 → 宿主运行状态（`runtime-state.js`）→ 完整快照／SSE → 浏览器镜像（`client/src/runtime-store.js`）→ 面板呈现。每个维度只有一个真源：连接是否可用、某次操作是否失败、输入是否合规、额度是否用尽是四个独立维度，互不覆盖。所有异步结果按 `{runtimeId, configNs, generation}` 校验代际，配置一改，HTTP、面板下行与桥接同时切换，旧的迟到结果一律拒收。

| 文件 | 职责 |
|---|---|
| `cordis.patch.yml` | 组合包层：`dsh plugin add` 自动进 profile 层列表，免手写 YAML |
| `lib/index.js` | Host 入口（inject/apply） |
| `lib/config.js` | 插件 Config（全 volatile，官方 settings 读写） |
| `lib/backend.js` | 后端地址唯一真源：归一＋拼装＋形态判定 |
| `lib/errors.js` | 失败分类唯一真源（`classifyFailure` 返回 kind/code/text/advice/retryable；调用方只给事实，不猜正文、不猜地址形态） |
| `lib/http.js` | 后端 JSON/二进制请求唯一出口（归一前置＋UPSTREAM_HTML 分流） |
| `lib/runtime-state.js` | 宿主运行状态 Owner：配置代际、聊天收发就绪、桥接生命周期的唯一投影（快照无凭据，订阅即回放当前全量） |
| `lib/runtime-contract.js` | 宿主/浏览器共用的快照契约与故障去重（同因只去重一次，无关错误不吞） |
| `lib/routes.js` | `/api/muche/{runtime,chat,history,image,health,events}` 同源路由（配置读写走官方服务，不在此；历史直读服务端唯一真源，本机零落盘；游标 422 转 CURSOR_INVALID） |
| `lib/connections.js` | 连接生命周期唯一 Owner（面板上游＋桥接各持一个 ChannelConnection，指纹换连） |
| `lib/backend_ws.js` | 后端 WS 传输类（桥接通道＋面板 SSE 上游，ping/重连/缓冲；`ready` 只由后端真实 hello 置真） |
| `lib/panel-events.js` | 面板 SSE 扇出 Owner：首位订阅先发完整快照，业务帧按配置 context 盖章 |
| `lib/register-guard.js` | 注册事务守卫：双挂载降级时原子撤销本轮注册，不留混合 Owner 的孤儿路由 |
| `lib/dsh-bridge.js` + `lib/dsh-call.js` | 反向桥接：宿主归属、稳定指令、应用回执、只读查询；执行订阅先于 prompt，按所属 turn 收口 |
| `lib/protocol.json` | 桥接 v2 版本、能力和执行失败枚举的唯一真源；后端读取同一文件 |
| `client/src/` | 面板源码（`pure.js` 纯格式函数＋`api.js` 同源封装＋`runtime-store.js` 浏览器镜像＋`entry.js` 工厂与 UI），esbuild 打包到 `client/client.js`（构建产物随包发布，不手改） |

反向桥接先用 `dsh_hello` 登记持久的宿主身份与 v2 能力，后端以 `dsh_hello_ack` 确认登记成功与否（成功带 `host_id` 回显，失败带已有枚举 `code` 且不登记）；插件只认该 ACK 为登记事实，不以 socket hello 或本地 ready 代替，未收到 ACK 前保持 starting。任务只发送给所属宿主，旧插件需升级；同 `session_id` 串行、稳定 `task_id` 去重，执行阶段和结果分别上报。会话不存在保留具体上游事实，由小沐说明并按剩余任务续接新会话；失效的 `sN` 不再复用。断连与未知结果保留受理确定性，不据此重做副作用任务；重启恢复先只读查询原 task。

在途追加只在相同 live run 的自有 turn 使用公开 `Agent.steer`，用同 cohort 的 `createUserMessage` 构造消息并同步受理；原任务尚未进入自有 turn 时返回 `turn_pending`，后端保留同一 `append_id` 重试。终态后拒收，不转成无人收结果的新轮。明确拒收的追加保留完整任务，等原任务结果落账后由小沐续办；曾丢失回执的追加仍保留结果未知事实。授权/提问先登记 resolver 再经 `dsh_interactive` 上行，每次交互有独立 opaque id，原始问题与选项完整保留。其他 turn 透传。小沐能拿捏就提交决定，需要用户时提交真实问题并保留等待；`dsh_decide_result` 确认实际应用后才算完成。宿主进程缓存相同 `command_id` 的回执：活跃 run 的收据保留，终态收据按最近 200 项收敛；相同身份不同内容拒收。

用户等待暂停活跃执行计时。卸载、断连、取消、上限与错误均清理订阅/等待，保留终态和部分输出；技术失效不表示用户拒绝。宿主 `bridgeId` 经官方 settings 保存且同宿主双挂载共享，排障勿删除或复制该身份。

回答与追加的交付有独立尝试预算；原任务结束、交互超期或交付耗尽后，本地技术收口保留原决定和未知回执，resolver 关闭最多尝试一次，不等待离线宿主无限返回 ACK。未完成追加与恢复事实原子保存，正常等待用户不消耗交付次数。已结束问题的重复上报不会重新暂停后端执行计时。

执行核按上游锁定的 `0.1.7-rc.2` 接口编写：进程内直调 `sessionController.create/prompt`（与人用客户端同一实现），回复走 `session/event` 事件订阅（`assistant/message` 累积文本，`turn/end` 按 `reason.kind` 判定完成）。`turn/end` 共六种终态（`completed/aborted/blocked/error/max-tokens/interrupted`），调用方按种收敛，不静默。

执行前同时订阅 `agent/inbox/claimed`，按消息 rpcId 与所属 turn 绑定来源；上游 pre-step 在写入正文前拒绝或结束时仍保留实际终态，其他 turn 不结算当前任务，所有退出清理两类订阅。

依赖：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-llm` 为 peer（用宿主同 cohort 的服务和消息类型）；`ws`、`undici` 自带。改动依赖前后必跑 `pnpm test`（`deps.test.js` 守卫）；重启 Desktop 前必跑全量测试，全绿才动。

</details>

## 开发

```bash
cd dsh && pnpm test   # 先 esbuild 打包 client 再跑全量，重启 Desktop 前必跑，全绿才动
```

客户端改 `client/src/` 后禁手改 `client/client.js`（构建产物，`pnpm test` 自动重建）。

## 许可

MIT
