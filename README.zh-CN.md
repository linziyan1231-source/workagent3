# WorkAgent3

[English](README.md) | 简体中文

WorkAgent3 是一个自托管、浏览器访问的多用户办公智能体平台。智能体执行运行在公司自己的服务器上，每个用户拥有相互隔离的工作区，平台集成各家模型厂商的原生智能体 harness，而不是让所有模型共用同一个 harness 环境。

## 为什么选择 WorkAgent3

- **公司自有基础设施：** 智能体进程和文件都留在公司服务器上——重要文件不会离开公司管控，员工电脑不承担运行时负载，工作区 7×24 小时可用，不依赖任何个人电脑。
- **为协作而生：** 共享项目、共享助手和共享公司上下文让团队协作成为一等使用场景，公司还可以根据实时需求在平台上自研定制功能。
- **每家厂商使用原生 harness：** 前沿大模型越来越多地针对自家智能体 harness 训练，原生工具层也越来越重——把模型放在外来 harness 上运行会明显损害模型能力。因此 WorkAgent3 集成各家厂商自己的 harness（官方 DeepSeek Harness Web 客户端组合，以及原生 Codex 和 Kimi 引擎），而不是用一个 harness 套所有智能体。

## WorkAgent3 与 WorkAgent2 的区别

WorkAgent3 是 WorkAgent2（https://github.com/linziyan1231-source/workagent2）的重构版本：保留原有的托管、按用户隔离的平台模型，架构重写：

- **架构：** WorkAgent2 自带运行时层，通过可评审的补丁扩展智能体运行时。WorkAgent3 直接组合官方 DeepSeek Harness（dsh）Web 客户端：Go 负责 Windows 平台和 Portal，TypeScript 负责 dsh 客户端组合和 WorkAgent 插槽插件。组合式架构更轻、更易维护，新功能以插槽插件形式交付，而不改动核心。
- **新功能：** 多 harness 模型接入（托管 Harness provider 模型与原生 Codex/Kimi 引擎）、IM 渠道连接（微信、企业微信、飞书/Lark、钉钉、QQ、Telegram）、任务完成提醒推送到 IM 聊天、定时任务、共享项目与协作助手、一键 Web 发布，以及带配额、审计和发布管理的管理员后台。

## 平台组成

Go 负责 Windows 平台和 Portal，TypeScript 负责官方 DeepSeek Harness Web 客户端组合、WorkAgent 插槽插件和共享契约。

## 使用指南

中文操作说明见 [WorkAgent3 使用指南](docs/user-guide.md)，覆盖首次使用、对话与文件、助手与技能、定时任务、共享协作、消息渠道和管理员操作。

## 环境要求

- Node.js 24 或更新
- pnpm 11
- Go 1.26 或更新
- 运行 SID、ACL、任务计划程序和 UserHost 集成测试需要 Windows

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm profile:dump
```

构建浏览器客户端和 Portal：

```powershell
pnpm build
& scripts/go.ps1 @('build', '-o', 'bin/portal.exe', './cmd/portal')
```

认证之后，Portal 提供按 SID 隔离的官方 dsh Web 客户端，并保留
`apps/web/dist` 用于登录、管理、OAuth 和临时的
`?frontend=legacy` 回退落地页。Portal 默认使用安全 cookie。
本地纯 HTTP 开发运行时，传入 `-secure-cookie=false`。托管 Harness
provider 模型必须用 `-harness-model`（或
`WORKAGENT_HARNESS_MODEL`）声明为配置的 Codex 模型——与
employee-manager 配置中的 `modelGateway.codexModel` 相同（见
`docs/employee-manager.config.example.json`）；缺少该值时 Portal 拒绝启动。
首个本地用户可以用 `WORKAGENT_BOOTSTRAP_USERNAME`、
`WORKAGENT_BOOTSTRAP_PASSWORD` 和 `WORKAGENT_BOOTSTRAP_SID` 一次性创建；
不要把这些值提交到源代码管理。`WORKAGENT_RUNTIME_URL`、
`WORKAGENT_RUNTIME_TOKEN` 和 `WORKAGENT_RUNTIME_SID` 用于注册回环
开发运行时。生产环境的运行时注册由 UserHost 负责。

要把独立部署的 ChatForward 服务挂载到 `/chatgpt/`，设置
`WORKAGENT_CHATFORWARD_URL` 和 `WORKAGENT_CHATFORWARD_SECRET_FILE`。密钥
文件必须是非符号链接的普通文件、至少 32 字节，并且
也要在 ChatForward 中配置，用于委托请求验证。Portal
会移除浏览器凭据，只发送短期签名的用户 ID。

DSH Web 的 **设置 → 消息渠道** 页面使用锁定的社区插件
`@michengai/dsh-im-connect@0.1.30`，支持微信、企业微信、飞书/Lark、钉钉、
QQ 和 Telegram。在该页面添加账号并完成扫码登录或机器人
凭据配置。中文账号设置可选择 Harness provider 模型
或原生 Codex/Kimi 模型。原生对话使用现有的 WorkAgent
运行时，包括模型/权限选择、配额准入、持久化
历史和重启恢复。完整的
WorkAgent profile 已包含该插件及其原生账号管理界面；
此页面不需要单独的 IM Gateway 进程。

每位员工的渠道状态存放在其 SID 私有的 `DSH_HOME` 下。
隔离的 Cordis 凭据域为渠道插件提供官方
持久本地凭据提供器，而托管模型凭据继续
使用仅内存的 Broker 投影。因此插件凭据
能在运行时重启后保留，且不持久化托管模型密钥。私聊
访问默认仅限已授权用户。在 `pnpm profile:dump` 之后运行
`node scripts/smoke-dsh-channel-profile.mjs`
验证持久化和凭据隔离；用常规 smoke 凭据运行
`node scripts/smoke-dsh-channels.mjs` 进行
认证设置检查。
`scripts/smoke-dsh-channel-routing.mjs` 检查四个适配器路由、
授权、去重、引擎切换和持久化渠道映射。
`scripts/smoke-dsh-channel-models.mjs` 通过真实认证浏览器会话
验证对外展示的 Codex/Kimi 模型，不会向外部联系人发消息。

**设置 → 消息提醒** 启用可选的任务完成推送。选择一个
已连接账号的现有聊天和外部可访问的 WorkAgent
地址，然后保存。提醒默认关闭，按员工存储在
服务器上。成功的网页对话和定时任务会发送其最终
回复、当前已登记产物的链接或回复中引用的工作区文件
链接，以及会话链接。下载需要同一员工登录；
输入附件和工作区外的文件不会添加为产物。
IM 渠道发起的对话保留自己的回复，不重复推送。
持久化投递日志显示失败记录，支持重试未发送的部分。
企业微信使用其 SDK 的主动发消息方法；钉钉使用现有卡片
客户端，因此提醒不依赖近期的入站消息 webhook。
运行 `scripts/smoke-dsh-completion-notifications.mjs` 进行
提醒关闭状态下的认证设置检查；测试从不向真实外部接收者发消息。

旧的外部 IM Gateway 仍作为独立可选进程保留，用于其
现有的 `/api/channels/` 集成：

```powershell
$env:WORKAGENT_IM_DELIVERY_TOKEN = '<共享机器令牌，至少 32 字节>'
$env:WORKAGENT_IM_ADMIN_TOKEN = '<Gateway 管理员令牌，至少 32 字节>'
go run ./cmd/im-gateway -portal-url http://127.0.0.1:8080
```

Portal 需要相同的 `WORKAGENT_IM_DELIVERY_TOKEN`，以及
`WORKAGENT_IM_GATEWAY_URL` 和对应的 `WORKAGENT_IM_ADMIN_TOKEN`，用于其
认证的、注入 SID 的 ChannelPort 代理。浏览器会话永远不会收到
该令牌。连接器凭据是
Gateway `-credential-root` 下的普通非符号链接文件；Gateway
数据库只存储其不透明文件名。版本锁定的微信
连接器使用 iLink `getupdates` 和 `sendmessage` 协议。其公开
配置、扫码登录、启用状态、运行实例、配对列表和
授权用户均按所有者 SID 隔离。Gateway 将扫码登录
令牌直接存储在其私有凭据目录中，SSE 流不返回任何令牌。
配对审批只能针对 Portal 认证的所有者 SID，
在此之前任何消息都无法到达该员工的运行时。

除非 Portal 管理员同时设置
`WORKAGENT_SPEECH_URL` 和 `WORKAGENT_SPEECH_TOKEN`，否则语音输入保持禁用。
该 URL 指向私有批量/WebSocket 转写适配器；令牌仅由
Portal 代理注入，永远不会返回给浏览器。启用适配器
还要求员工被授权使用稳定的
`speech-transcription` 资源并持有相应配额预算。Portal
在打开任一适配器路由前预留配置的最大流秒数，
关闭时按实际整秒结算；当授权、预算或配额
不可用时，准入在音频到达适配器之前即失败关闭。

通知由独立的 `notifications.db` 模块存储拥有，
按员工 SID 划分作用域，全局公告用 `*` 表示。
Portal 暴露认证的列表/已读/确认和 SSE 端点，并使用
正式的 WorkAgent2 通知弹窗。管理员无需访问 Portal/Auth 表
即可发布有限公告：

```powershell
go run ./cmd/notification-publish -db data/notifications.db -kind maintenance -title "Maintenance" -message "The service will restart in 10 minutes." -expires-in 2h
```

Portal 为每个请求生成新的关联 ID，以
`X-WorkAgent-Correlation-ID` 返回，传播到下游服务，并在仅追加的
`audit.db` 模块中记录写入/安全结果，不包含请求
体、查询字符串、密码、令牌、提示词或文件内容。特权
操作员可以在本地导出有限的审计结果：

```powershell
go run ./cmd/audit-export -db data/audit.db -correlation-id '<id>' -limit 100
```

正式的 WorkAgent2 系统和关于页面使用 Portal 的认证系统
端口。`GET /api/system/status` 报告构建元数据和组件健康，
`POST /api/system/runtime/restart` 请求当前 SID 的 UserHost 退出以便
任务计划程序恢复，`GET /api/system/diagnostics` 下载一个
权限受限的 ZIP，仅包含脱敏的构建/组件元数据和
请求关联 ID。运行时 URL、令牌、SID、请求体、提示词
和文件内容均被排除。发布构建可以通过
Go 链接器标志注入 `workagent3/internal/buildinfo.Version`、`Commit` 和
`BuildTime` 版本元数据；开发构建报告 `dev` 和 `unknown` 值。

`scripts/go.ps1` 中的 Go 包装器使用 `PATH` 中的 `go`，或本开发机器上
安装于 `C:\Users\Administrator\.codex\tools\go1.26.5-verified` 的经校验和验证的便携工具链。

运行时数据、密钥、员工 profile 和 `DSH_HOME` 永远不会存入本仓库。

发布激活、回滚、受限所有者备份和隔离恢复
演练记录在 [docs/operations.md](docs/operations.md)。发布
门禁要求 60 秒升级预告，加上真实 Harness、Codex、
Kimi 和托管 Provider 就绪证据全部通过。
