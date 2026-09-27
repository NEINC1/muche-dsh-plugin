# muche-dsh-plugin — 和有持续状态的小沐聊天

[![npm](https://img.shields.io/npm/v/muche-dsh-plugin.svg)](https://www.npmjs.com/package/muche-dsh-plugin)
[![license](https://img.shields.io/npm/l/muche-dsh-plugin.svg)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

连接小沐（MuChe 数字生命）的 dsh 插件：可以和有持续状态的小沐聊天，小沐可调用本机 dsh 执行任务。

* **聊天浮层**：左下角「小沐」入口，可拖动面板，聊天气泡，未读红点，主动消息实时弹入。
* **服务端直读**：聊天记录只在服务端，面板首屏单页、增量归一、游标翻页；本机不存任何聊天文件，重装换机天然可用。
* **反向桥接**：小沐可调用你本机 dsh 执行任务（出站常驻连接，不开入站端口）。
* **设置页**：后端地址 + API key，每用户各自配置。

## 安装

在 DSH Desktop 的 DSH Terminal 里执行（裸命令默认装到当前激活 profile，
装完在托盘重启 DSH Desktop 即用）：

```bash
dsh plugin add muche-dsh-plugin
```

升级是同一条命令（重跑即升到最新版）。当前插件版本见 `package.json` 的 `version`（现为 0.5.2），dsh 本体须为上游锁定的 `0.1.7-rc.2` 同 cohort（见 `pnpm-workspace.yaml`；0.4.10 及更早只认 `0.1.5-rc.2`）。`package.json` 已经 `engines.dsh`（`^0.1.7`）显式声明该要求，市场会对不满足的旧宿主阻断安装并提示升级。

注意 `dsh --profile desktop plugin add` 的父 flag 写法上游不接受（`plugin`
子命令自带 `--profile`，见上游 `rejectParentOptions`），必报
`required option '--profile <name>' not specified`——别写。

## 使用

1. 打开 dsh 设置 → 小沐，填后端地址和 API key（小沐后台生成），保存。
2. 点左下角「小沐」开聊。反向桥接配好 key 即在线，无需额外操作。

后端地址口径（全员远端唯一口径）：填 `<公网基址>/api`（公网入口只把 `/api` 反代到后端，少写前缀会打到 SPA 首页，面板报"后端地址可能少了 /api 后缀"）；不再提供同机直连分支。

## 卸载

```bash
dsh plugin remove 'muche-dsh-plugin'
```

`remove` 只摘层与代码；本机配置（profile patch 里 `muche` 条目的配置）保留，重装免配。0.5.0 起插件不在本机存任何聊天文件；旧版遗留的本地存档（`~/muche-dsh-workspace/messages/`）原样保留，可手动删除。装完在托盘重启 DSH Desktop 生效。彻底清掉：删掉 profile patch 里 `muche` 条目的 `config` 段。

反向桥接只调用户本机：后端把任务帧从该用户的桥接连递下来，插件在本地 dsh 进程内执行、结果原路回传。桥不在时后端明确失败，不回退服务器。

## 技术细节

<details>
<summary>架构（勿改回）与模块说明</summary>

小沐聊天 = 插件自绘面板 + 直连后端（HTTP 历史 + WS 双向），**不进 dsh agent 循环、不建 dsh 会话**（dsh 会话的隐藏机制与可聊天互斥，会话内 LLM 调用会注入 AGENTS.md 等噪音——面板形态从根上消除注入面）。

| 文件 | 职责 |
|---|---|
| `cordis.patch.yml` | 组合包层：`dsh plugin add` 自动进 profile 层列表，免手写 YAML |
| `lib/index.js` | Host 入口（inject/apply） |
| `lib/config.js` | 插件 Config（全 volatile，官方 settings 读写）+ 旧 JSON 配置迁移 |
| `lib/http.js` | 后端 JSON 请求封装 |
| `lib/routes.js` | `/api/muche/{chat,history,image,test,ws-diag,status}` 同源路由（配置读写走官方服务，不在此；历史直读服务端唯一真源，本机零落盘） |
| `lib/backend_ws.js` | 后端 WS 常驻客户端（桥接通道＋面板 SSE 上游） |
| `lib/dsh-bridge.js` + `lib/dsh-call.js` | 反向桥接：出站收 `dsh_task`，进程内直调 `sessionController` 执行，结果原路回传 |

反向桥接语义（一任务只执行一次）：同 `session_id` 串行、`task_id` 去重、断连在途即失败；会话复用/新建由小沐在工作区别名里决定。`message_id` 幂等（服务端 Redis SET NX 300s）。在途追加走 `steer`（当前轮 step 边界，闲时开新轮）＋`run_id`/`task_id` 在途寻址（含首轮占位，`dsh_session_created` 早期上报）；在途授权/提问以 prepend 拦截经 `dsh_interactive` 上行、`dsh_decide` 按 id 回决，他会话一律透传。

执行核按上游锁定的 `0.1.7-rc.2` 接口编写：进程内直调 `sessionController.create/prompt`（与人用客户端同一实现），回复走 `session/event` 事件订阅（`assistant/message` 累积文本，`turn/end` 按 `reason.kind` 判定完成）。`turn/end` 共六种终态（`completed/aborted/blocked/error/max-tokens/interrupted`），调用方按种收敛，不静默。

依赖：`@deepseek-ai/schemastery` 为 peer（用宿主那份）；`ws` 自带。改动依赖前后必跑 `pnpm test`（`deps.test.js` 守卫）；重启 Desktop 前必跑全量测试，全绿才动。

</details>

## 开发

```bash
cd dsh && pnpm test   # 重启 Desktop 前必跑，全绿才动
```

## 许可

MIT
