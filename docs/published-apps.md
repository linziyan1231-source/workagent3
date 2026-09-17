# 网页发布

网页发布由助手代劳：员工在对话里说“把这个网页发布出去”，助手通过内置的 `workagent-app-publish` MCP 工具（`app_publish` / `app_publish_list`，Codex、Kimi、DSH 会话都可用）完成发布，员工不需要填写端口、运行方式等技术参数。助手发布前必须向员工确认：

- **有效时间**：默认 5 天，到期后网页自动停止对外访问；重新发布会重新计算有效期。
- **访问范围**：`authenticated`（仅 WorkAgent 登录用户）、`token`（任何人凭带密钥的完整链接，路径 `/t/<令牌>/`）或 `password`（任何人凭 8 位访问密码）。后两者不需要访问者登录。

`web-publish` 托管技能向助手描述这一流程。员工在 **设置 → 网页发布** 查看已发布网页的链接、访问范围、有效期和状态，可以停用/启用（启用过期网页会顺延 5 天有效期）或删除（链接立即失效）。发布结果里的 `shareUrl` 与 `accessCode` 面向员工本人，可自由转发给目标访问者。

每次发布复制入口所在目录作为固定版本；原工作区后续编辑不会改变已有版本。同名同项目的发布会复用原应用，保留端口与链接。运行中的应用对版本文件只有读取权限，持久数据写入应用自己的目录。这里的固定版本不表示能抵御作者本人直接篡改其私有运行目录。

Node/Python 入口的主进程必须监听环境变量 `HOST`（127.0.0.1）与 `PORT` 指定的地址，不支持热重载子进程代为监听。应用数据写入 `WORKAGENT_APP_DATA` 或 `APP_DATA`。依赖应随应用目录提供；不使用员工的私人 Python 环境、个人凭据或全局可写 PATH。单次快照上限为 20,000 个文件、512 MiB；私有元数据、回收站和符号链接不进入快照。

应用按需启动，空闲五分钟后回收。应用进程、子进程、快照与外部请求代理均纳入作者已有 Windows Job 配额，应用包、缓存、日志和数据放在作者个人存储配额之内。共享项目仅负责人可发布；项目归档或完成转让后，旧负责人的应用停止对外访问，旧负责人仍可停止其运行实例。

## Agent 通道

会话内的发布工具通过员工运行时回环地址的 `/v1/app-publishing`（列出）与 `/v1/app-publishing/publish`（发布）进入，使用管家凭据并受 butler 路由白名单限制；员工运行时再以平台凭据转发到 Portal 的 `/internal/runtime/published-apps/list|publish`（仅回环、按 SID 限定归属）。Portal 完成建记录、分配端口、快照版本与启用，返回带 `shareUrl`/`accessCode` 的摘要。

## 外部 API

先声明允许的 HTTP(S) 来源，例如 `https://api.example.com`。后端通过 `WORKAGENT_APP_BROKER_URL` 的 `/fetch?url=<编码后的完整目标URL>` 请求该来源，并设置 `X-App-Broker-Token: <WORKAGENT_APP_BROKER_TOKEN>`。请求方法和正文用于实际 API 请求；业务 Authorization 可照常传递。

代理自行完成 DNS、TLS 和 Host 校验；拒绝内网、本机、未声明来源、CONNECT 与 WebSocket 隧道。重定向返回应用，下一跳仍须重新经过同样检查。应用无法绕过代理直接出网。代理令牌仅供后端调用，不应放入前端网页。

## HTTP 公网入口

每个应用拥有永久独立的正式端口和预览端口，更新版本沿用端口；端口不分配给其他应用。访问范围除登录体系（仅自己/指定成员/全站登录用户）外，还支持链接令牌与 8 位访问密码两种匿名方式：链接令牌在应用端口 `/t/<令牌>/` 路径直接换取匿名授权；访问密码在 Portal 落地页输入，按应用和来源 IP 限制为 10 分钟 10 次尝试。匿名授权最长 12 小时且不超过应用有效期；撤权、删除或过期后普通长请求及 WebSocket 都会关闭。密码按应用记录明文保存并向作者本人展示，用于转发给访问者。

同一 IP 的不同端口不是 Cookie 隔离边界。平台 Cookie 为 HttpOnly，入口向应用删除全部 Cookie 和内部身份头，并删除应用响应中的 Set-Cookie、Clear-Site-Data 等头。当前 HTTP 方案不承诺安全上下文、Service Worker 或跨端口 Cookie 的完整隔离。

部署需配置 Portal `--apps-public-url`、`--apps-bind`、`--apps-employee-root` 和端口范围；employee root 必须与 employee-manager 的 dataRootBase 一致。Python 使用管理员配置的 `publishedPythonCommand`。只给公开版本中的 UserHost、Node/Python 软件授予 AppContainer 所需读取/执行权限，不能扩大员工私人目录权限。

## 端口范围与每员工上限

`--apps-port-first/--apps-port-last/--apps-max-employee-ports` 只是首次启动的初始值。管理员在 **管理空间 → 应用发布** 查看并调整（`GET/PUT /api/portal/admin/published-apps/settings`，持久化在 published-apps.db 的 settings 表，保存后重启仍然生效并覆盖 flag）：

- **端口范围**：必须与云防火墙开放的端口段一致，否则 token/password 直链不可达。保存新范围会把现有应用按创建顺序重映射进新范围（每应用 2 个连续端口），监听器按需在新端口重绑，旧端口链接失效；范围放不下现有应用时拒绝保存（`application_ports_exceeded`）。
- **每员工最大端口数**：按公开端口计数（1 个/应用），默认 3。超限发布返回 `application_employee_ports_exceeded`，引导员工在设置→网页发布删除旧网页或由管理员上调。

分配取范围内最低可用端口对，删除应用立即回收其端口，小范围可以长期复用。

如原公网入口是 TCP 端口转发，应改用 Portal `--public-addr` 直接监听原公网端口，保留原内部 `--addr`，以获取真实访问者 IP。迁移必须保存原端口映射和服务配置用于回滚；公共监听器拒绝所有 `/internal/` 路由。域名、DNS 与 HTTPS 不是此 IP/HTTP 方案的启用条件。
