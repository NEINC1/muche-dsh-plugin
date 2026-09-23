# @muche/dsh-plugin — 和有持续状态的小沐聊天

[![npm](https://img.shields.io/npm/v/@muche/dsh-plugin.svg)](https://www.npmjs.com/package/@muche/dsh-plugin)
[![license](https://img.shields.io/npm/l/@muche/dsh-plugin.svg)](LICENSE)
[![Awesome DSH Plugin](https://beancookie.github.io/awesome-dsh-plugin/badge.svg)](https://beancookie.github.io/awesome-dsh-plugin)

连接小沐（MuChe 数字生命）的 dsh 插件：可以和有持续状态的小沐聊天，小沐可调用本机 dsh 执行任务。

* **聊天浮层**：左下角「小沐」入口，可拖动面板，微信式气泡，未读红点，主动消息实时弹入。
* **反向桥接**：小沐可调用你本机 dsh 执行任务（出站常驻连接，不开入站端口）。
* **设置页**：后端地址 + API key，每用户各自配置。

## 安装

用户在小沐后台「接入设置」复制安装命令，在自己机器上执行（装完重启 dsh 即用）：

```bash
dsh plugin --profile web add @muche/dsh-plugin
dsh --profile web --dump-config | grep -c '^# == @muche/dsh-plugin$'   # 期望 1
sudo systemctl restart dsh-web
```

升级是同一条命令（重跑即升到最新版）。当前插件版本见 `package.json` 的 `version`（现为 0.4.4），dsh 本体须为上游锁定的 `0.1.5-rc.2` 同 cohort（见 `pnpm-workspace.yaml`）。

## 使用

1. 打开 dsh 设置 → 小沐，填后端地址和 API key（小沐后台生成），保存。
2. 点左下角「小沐」开聊。反向桥接配好 key 即在线，无需额外操作。

后端地址口径：远端用户填 `<公网基址>/api`（公网入口只把 `/api` 反代到后端，少写前缀会打到 SPA 首页）；与后端同机时填 `http://127.0.0.1:8000`。

## 卸载

```bash
dsh plugin --profile web remove '@muche/dsh-plugin'
sudo systemctl restart dsh-web
```

`remove` 只摘层与代码；本机配置（settings `muche` 命名空间）保留，重装免配。彻底清掉：按 dsh settings 用法删掉 `muche` 命名空间。

## 故障排查

| 现象 | 原因 | 做法 |
|---|---|---|
| 面板显示“连接不上” | 后端地址缺 `/api` 前缀，打到 SPA 首页 | 远端地址改为 `<基址>/api` |
| 面板 401，桥接也不在线 | API key 失效（账号重置或后台吊销） | 去小沐后台重签，到设置页更新 |
| 小沐说“dsh 没连上” | 本机 dsh 未运行，或插件版本低于桥接要求 | 先启动本机 dsh，再重跑安装命令升级插件 |
| 面板正常但桥接不工作 | dsh 本体缺本地执行依赖，或插件被加载两次（桌面端市场与 bundles 双挂载） | 看 dsh 日志有无反向桥接停用警告，升级 dsh 本体；桌面端到插件页确认小沐只装了一处 |
| 要看桥到底什么状态 | 面板“在线”只证明路由可达，工具要的是桥接池在线 | 同机 `GET /api/muche/status`（需过 dsh 鉴权），看 `fibers[].mode/reason` |
| 反向桥接任务无响应 | 同会话串行排队，或会话已失效 | 等待在途任务完成；`sN` 别名超 3 天消除后重开 |

反向桥接只调用户本机：后端把任务帧从该用户的桥接连递下来，插件在本地 dsh 进程内执行、结果原路回传。桥不在时后端明确失败，不回退服务器。

## 技术细节

<details>
<summary>架构（勿改回）与模块说明</summary>

小沐聊天 = 插件自绘面板 + 直连后端（HTTP 历史 + WS 双向），**不进 dsh agent 循环、不建 dsh 会话**（dsh 会话的隐藏机制与可聊天互斥，会话内 LLM 调用会注入 AGENTS.md 等噪音——面板形态从根上消除注入面）。

| 文件 | 职责 |
|---|---|
| `cordis.patch.yml` | 组合包层：`dsh plugin add` 自动进 profile 层列表，免手写 YAML |
| `lib/index.js` | Host 入口（inject/apply） |
| `lib/config.js` | settings 命名空间 `muche` + 旧 JSON 配置迁移 |
| `lib/http.js` | 后端 JSON 请求封装 |
| `lib/routes.js` | `/api/muche/{chat,history,config,test}` 同源路由 |
| `lib/backend_ws.js` | 后端 WS 常驻客户端（桥接通道） |
| `lib/ws-proxy.js` | 浏览器 WS 同源代理（backendUrl path 原样保留，远端须带 `/api` 前缀） |
| `lib/dsh-bridge.js` + `lib/dsh-call.js` | 反向桥接：出站收 `dsh_task`，进程内直调 `sessionController` 执行，结果原路回传 |

反向桥接语义（一任务只执行一次）：同 `session_id` 串行、`task_id` 去重、断连在途即失败；会话复用/新建由小沐在工作区别名里决定。`message_id` 幂等（服务端 Redis SET NX 300s）。

执行核按上游锁定的 `0.1.5-rc.2` 接口编写：进程内直调 `sessionController.create/prompt`（与人用客户端同一实现），回复走 `session/event` 事件订阅（`assistant/message` 累积文本，`turn/end` 按 `reason.kind` 判定完成）。`turn/end` 共六种终态（`completed/aborted/blocked/error/max-tokens/interrupted`），调用方按种收敛，不静默。

依赖：`@deepseek-ai/schemastery` 为 peer（用宿主那份）；`ws` 自带。改动依赖前后必跑 `pnpm test`（`deps.test.js` 守卫，未声明依赖致 dsh-web 崩溃循环的教训）；重启 dsh-web 前必跑全量测试，全绿才动。

</details>

## 开发

```bash
cd dsh && pnpm test   # 重启 dsh-web 前必跑，全绿才动
```

## 许可

MIT
