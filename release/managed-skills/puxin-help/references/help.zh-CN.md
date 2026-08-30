# Puxin AI WorkAgent3 使用帮助

本文对应 Web 版 WorkAgent3。页面沿用正式桌面 Renderer 的组件和视觉，但数据通过同源
HTTP/SSE 接入员工自己的 Runtime。

## 登录与会话

- 登录后进入会话页。左侧“新对话”创建个人会话；最近会话支持打开、重命名、删除、置顶
  和批量删除。
- 欢迎页先选择助手和 Engine，再输入任务。首次发送时才创建会话。
- Engine 包括 Personal assistant、Codex 和 Kimi。显示“需要登录”“不可用”时不能启动新
  Turn；到“设置 → Agents”查看对应状态。
- 消息发送后可停止正在运行的 Turn。工具需要授权时，消息区显示正式审批卡；选择允许一次
  或拒绝后确认。

## 文件、Workspace 与产物

- 欢迎页或会话输入框的“+”可从设备选择文件。欢迎页选择文件时会先建立当前助手和 Engine
  的会话，再将文件上传到该会话的 Workspace。
- 已上传文件显示在会话文件区，可选择是否随下一条消息引用。文件始终属于当前员工和当前
  Workspace，不会自动共享给其他员工。
- 上传失败时检查文件大小、Runtime 状态和 Workspace 权限；不要把私有文件改传到公共链接
  作为绕过方式。

## 助手与 Engine

- 左侧“助手”进入助手/Preset 页面。Preset 固定默认 Engine、说明、Skills、MCP 和审批策略。
- 修改 Preset 只影响之后创建的会话；已有会话继续使用创建时的快照。
- “设置 → Agents”列出员工 Runtime 实际报告的 Engine 状态。“Test connection”刷新该
  Engine 的健康状态；缺失与需要认证是不同问题。
- “设置 → Models”管理可用模型与 Provider；浏览器不会显示明文凭据。

## Skills 与 MCP

- “设置 → Capabilities”查看 Skills 与 MCP Server。“WorkAgent Skill Center”可安装、启用、
  禁用或移除员工私有 Skill。
- 受管 Skill 由产品发布；市场 Skill 是数据包，不是可执行 Harness 插件。Skill Market 不能
  安装代码插件。
- MCP 页面支持 Server 配置、连接测试、工具策略和 OAuth。Token、Header 和 stdio 环境变量
  保存在员工 SID 私有 Credential Broker，不经过浏览器或 Portal 数据库。
- Skill 声明必需 MCP 时，只有 MCP 健康且授权就绪后才可完整使用。`needs_auth` 表示重新授权；
  `needs_review` 表示命令、路径或迁移内容需要人工复核；`failed` 表示该项迁移失败。

## 定时任务

- 左侧“定时任务”查看 Automation，支持创建、立即运行、暂停、恢复和查看最近结果。
- 员工 Runtime 不可用、额度不足、凭据失效或必需 MCP 不健康时，任务不会启动，并保留可操作
  的失败原因。
- 恢复后先检查失败原因是否已经消失，再手动运行一次；不要通过重复创建任务绕过限制。

## 额度与迁移

- 设置侧栏的用量卡和“WorkAgent Usage”显示当前用量与剩余额度。超额会在 Agent Turn 启动前
  拒绝，不会通过切换 Engine 绕过。
- “WorkAgent Migration”按 Skill/MCP 项展示 `ready`、`needs_auth`、`needs_review` 或 `failed`。
  单项失败不会阻塞其他资产；按页面给出的恢复动作处理后重新验证该项。
- 迁移报告不包含密码、Token 或私有 Header。如页面出现凭据正文，应立即停止并联系管理员。

## 设置入口

- Agents：Engine 安装、认证与健康状态。
- Models：Provider 与模型访问。
- Capabilities：Skills 与 MCP。
- Appearance：语言、主题及显示偏好。
- System / About：系统偏好、版本与诊断入口。
- WorkAgent Skill Center、Usage、Migration：WorkAgent3 的员工私有能力管理页。

旧桌面端的 Remote WebUI Setup 和桌面宠物不属于 WorkAgent3 Web 第一版，因此不会在设置侧栏
显示。不要使用旧教程中的桌面 IPC、私有数据库路径或 WebUI Setup 命令。

## 常见恢复顺序

1. 查看页面顶部提示和“设置 → Agents”的 Engine 状态。
2. 涉及工具时，到“设置 → Capabilities”执行对应 MCP 连接测试。
3. 涉及旧资产时，到“WorkAgent Migration”查看单项终态和恢复动作。
4. 涉及额度时，查看 WorkAgent Usage。
5. 仍无法恢复时，记录时间、页面、Engine、会话 ID 和不含敏感信息的错误码，交给管理员。

不要在截图、工单或聊天消息中附带密码、模型 Key、OAuth Code、MCP Header、员工 SID 或本地
凭据文件内容。
