# @muche/dsh-plugin — 和有持续状态的小沐聊天

[![npm](https://img.shields.io/npm/v/@muche/dsh-plugin.svg)](https://www.npmjs.com/package/@muche/dsh-plugin)
[![license](https://img.shields.io/npm/l/@muche/dsh-plugin.svg)](LICENSE)
[![Awesome DSH Plugin](https://beancookie.github.io/awesome-dsh-plugin/badge.svg)](https://beancookie.github.io/awesome-dsh-plugin)

连接小沐（MuChe 数字生命）的 dsh 插件：可以和有持续状态的小沐聊天，小沐可调用本机 dsh 执行任务。

* **聊天浮层**：左下角「小沐」入口，可拖动面板，微信式气泡，未读红点，主动消息实时弹入。
* **反向桥接**：小沐可调用你本机 dsh 执行任务（出站常驻连接，不开入站端口）。
* **设置页**：后端地址 + API key，每用户各自配置。

## 安装

市场里点安装，重启 dsh 即用。或命令行：

```bash
dsh --profile web plugin add @muche/dsh-plugin
dsh --profile web --dump-config | grep -c '^# == @muche/dsh-plugin$'   # 期望 1
sudo systemctl restart dsh-web
```

## 使用

1. 打开 dsh 设置 → 小沐，填后端地址和 API key（小沐后台生成），保存。
2. 点左下角「小沐」开聊。反向桥接配好 key 即在线，无需额外操作。

## 卸载

```bash
dsh --profile web plugin remove '@muche/dsh-plugin'
sudo systemctl restart dsh-web
```

`remove` 只摘层与代码；本机配置（settings `muche` 命名空间）保留，重装免配。彻底清掉：按 dsh settings 用法删掉 `muche` 命名空间。

## 技术细节

<details>
<summary>架构（勿改回）与模块说明</summary>

小沐聊天 = 插件自绘面板 + 直连后端（HTTP 历史 + WS 双向），**不进 dsh agent 循环、不建 dsh 会话**（实测结论：dsh 会话的隐藏机制与可聊天互斥，会话内 LLM 调用会注入 AGENTS.md 等噪音——面板形态从根上消除注入面）。

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
| `client/client.js` | 入口按钮/聊天面板/设置页 |

反向桥接语义（一任务只执行一次）：同 `session_id` 串行、`task_id` 去重、断连在途即失败；会话复用/新建由小沐在工作区别名里决定。`message_id` 幂等（服务端 Redis SET NX 300s）。

依赖：`@deepseek-ai/schemastery` 为 peer（用宿主那份）；`ws` 自带。改动依赖前后必跑 `pnpm test`（`deps.test.js` 守卫，2026-08-16 崩溃循环教训）。

</details>

## 开发

```bash
cd dsh && pnpm test   # 重启 dsh-web 前必跑，全绿才动
```

## 许可

MIT
