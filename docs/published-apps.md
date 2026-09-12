# 应用预览与发布

在项目文件面板打开“应用预览与发布”，选择 HTML/JavaScript、Node.js 或 Python，填写项目内入口路径。每次预览或发布复制入口所在目录作为固定版本；原工作区后续编辑不会改变已有版本。运行中的应用对版本文件只有读取权限，持久数据写入应用自己的目录。这里的固定版本不表示能抵御作者本人直接篡改其私有运行目录。

Node/Python 入口的主进程必须监听环境变量 `HOST`（127.0.0.1）与 `PORT` 指定的地址，不支持热重载子进程代为监听。应用数据写入 `WORKAGENT_APP_DATA` 或 `APP_DATA`。依赖应随应用目录提供；不使用员工的私人 Python 环境、个人凭据或全局可写 PATH。预览与正式版本的数据空间分开；正式版本切换保留该应用正式数据。单次快照上限为 20,000 个文件、512 MiB；私有元数据、回收站和符号链接不进入快照。

应用按需启动，空闲五分钟后回收。应用进程、子进程、快照与外部请求代理均纳入作者已有 Windows Job 配额，应用包、缓存、日志和数据放在作者个人存储配额之内。查看“运行状态与日志”可以了解启动失败原因。共享项目仅负责人可发布；项目归档或完成转让后，旧负责人的应用停止对外访问，旧负责人仍可停止其运行实例。

## 外部 API

先声明允许的 HTTP(S) 来源，例如 `https://api.example.com`。后端通过 `WORKAGENT_APP_BROKER_URL` 的 `/fetch?url=<编码后的完整目标URL>` 请求该来源，并设置 `X-App-Broker-Token: <WORKAGENT_APP_BROKER_TOKEN>`。请求方法和正文用于实际 API 请求；业务 Authorization 可照常传递。

代理自行完成 DNS、TLS 和 Host 校验；拒绝内网、本机、未声明来源、CONNECT 与 WebSocket 隧道。重定向返回应用，下一跳仍须重新经过同样检查。应用无法绕过代理直接出网。代理令牌仅供后端调用，不应放入前端网页。

## HTTP 公网入口

每个应用拥有永久独立的正式端口和预览端口，更新版本沿用端口；端口不分配给其他应用。可以选择仅自己、指定成员、全站登录用户或公开免登录。私有访问经 Portal 登录和一次性 POST 票据交换，撤权后普通长请求及 WebSocket 都会关闭。

同一 IP 的不同端口不是 Cookie 隔离边界。平台 Cookie 为 HttpOnly，入口向应用删除全部 Cookie 和内部身份头，并删除应用响应中的 Set-Cookie、Clear-Site-Data 等头。当前 HTTP 方案不承诺安全上下文、Service Worker 或跨端口 Cookie 的完整隔离。

部署需配置 Portal `--apps-public-url`、`--apps-bind`、`--apps-employee-root` 和端口范围；employee root 必须与 employee-manager 的 dataRootBase 一致。Python 使用管理员配置的 `publishedPythonCommand`。只给公开版本中的 UserHost、Node/Python 软件授予 AppContainer 所需读取/执行权限，不能扩大员工私人目录权限。

如原公网入口是 TCP 端口转发，应改用 Portal `--public-addr` 直接监听原公网端口，保留原内部 `--addr`，以获取真实访问者 IP。迁移必须保存原端口映射和服务配置用于回滚；公共监听器拒绝所有 `/internal/` 路由。域名、DNS 与 HTTPS 不是此 IP/HTTP 方案的启用条件。
