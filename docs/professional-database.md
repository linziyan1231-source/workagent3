# 专业数据库 MCP

专业数据库部署在当前服务器的 Employee Manager 中，通过 Kimi 专业数据服务查询数据。它采用 WorkAgent2 的统一转发和按用户计次方式，使用独立的配额数据库与 Kimi 授权文件。无需运行或迁移 WorkAgent2。

## 管理与使用

管理员在「管理 → 账户 → 专业数据库」为每个用户开通服务、选择数据源，并设置每天、每月的总调用次数。新用户默认未开通。额度设为 0 表示该周期不可调用；每日最多 10,000 次、每月最多 100,000 次，月额度不得小于日额度。调整额度不会清除已用次数。

用户在 MCP 市场获取「专业数据库」后，连接自动绑定到当前账户，不需要填写 Token。详情展示当前账户今日、本月的剩余次数、总次数和已用次数，支持刷新。将包含该 MCP 的助手再次发布到市场时，也会为接收者重新绑定身份。

计次归属是连接绑定的员工账户。同一账户在多个项目中的调用共用额度；共享项目使用其所有者的连接时，调用计入所有者的额度。

计次规则：接口说明 `get_data_source_desc` 和数据查询 `call_data_source_tool` 每次发往上游计 1 次，同时占用日、月额度；已发出的失败请求计次。连接检查、列出工具、参数或权限拒绝，以及尚未完成服务授权的请求不计次。日/月按北京时间自然日和自然月重新计算。额度检查和扣减在同一数据库事务中完成，防止并发超额。停用账户、离职或收回数据源权限后，已安装的连接也会立即受限。

本地账户额度与 Kimi 上游账户额度分别生效；本地有剩余次数不代表上游一定接受请求。没有 Kimi 服务授权时，详情显示「服务待授权」，仍可分配额度和安装连接。

## 数据源

对齐 [Kimi 官方专业数据库插件](https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins) 的 25 个数据源标识：

`stock_finance_data`、`yahoo_finance`、`world_bank_open_data`、`tianyancha`、`arxiv`、`scholar`、`yuandian_law`、`wind`、`imf`、`gildata`、`sec_edgar`、`sp_data`、`china_nda`、`china_nbs`、`china_standards`、`who`、`fao`、`unsd`、`ecb`、`eurostat`、`unicef`、`oecd`、`fred`、`xhcj`、`caixin`。

实际可查内容由 Kimi 上游账户权限与服务可用性决定；此服务不包含各供应商原始数据库的镜像或独立接口授权。

## 服务配置

Employee Manager 私有配置中的 `professionalDatabase` 包含：

| 字段 | 用途 |
| --- | --- |
| `endpoint` | 该 Manager 监听地址下的完整 `/professional-database/mcp` 本机 HTTP URL |
| `databasePath` | 独立配额数据库的绝对路径 |
| `credentialPath` | 独立 Kimi 授权文件的绝对路径 |
| `oauthHost` | 可选，默认 `https://auth.kimi.com` |
| `apiUrl` | 可选，默认 `https://api.kimi.com/coding/v1/tools` |
| `outboundProxyUrl` | 可选，显式指定出站代理；留空直连 |

额度和授权文件应位于持久私有目录，位于公开软件版本、个人及共享配额目录之外，仅 SYSTEM/管理员可访问。每个员工的 UserHost 配置 `professionalDatabaseUrl` 必须与 `endpoint` 相同，用于允许对这一明确的本机服务进行连接检查。新用户配置和修复流程会从 Manager 配置继承该地址。

服务挂载 `/professional-database/healthz`，返回 `ready` 或 `needs_auth`。MCP 使用员工专属随机 Token；Token 加密存储，安装时写入接收者的凭据库，公开市场条目不包含连接地址、凭据引用或密钥。

完成服务器配置后，管理员可通过已登录会话请求 `POST /api/portal/admin/marketplace/professional-database` 发布内置条目。此操作可重复执行，不会产生重复的同版条目。

## 后续补充 Kimi 授权

在新服务私有目录下设置 `KIMI_CODE_HOME`，使用官方 Kimi CLI 运行 `kimi login --region mainland-cn`，由管理员用计划提供数据库服务的 Kimi 账户完成设备授权。把 `credentialPath` 指向这个 home 下的 `credentials/kimi-code.json`。登录输出中的授权链接和验证码可以用于完成登录，访问令牌与刷新令牌不得分享或写入公开配置。

授权文件就位后，服务会读取它并自行刷新到期凭据，无需重新发布市场条目。不要让另一套常驻程序使用同一份刷新凭据；重新登录时也应使用此服务的独立目录。授权未补充前的健康状态应保持 `needs_auth`，不能当成已经通过真实上游查询验收。

## 实现归属

- `internal/professionaldb`：数据源、授权、MCP 协议、Kimi 查询及事务计次。
- `internal/employeemanager`：员工状态校验、管理员策略和专属连接发放。
- `internal/portal/professional_database.go`：市场发布、接收者身份绑定和额度详情。
- 管理账户功能和市场详情分别拥有自己的界面、状态与测试。

此配额独立于模型的 Token/美元配额；浏览市场、安装 MCP 和打开详情不会消耗数据库查询次数。
