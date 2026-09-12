# 前端模块归属与验证

模块边界以维护成本为准：**改一个功能时，能否主要在它自己的模块里完成，相关测试能否独立验证。** 模块数量、插件数量、文件行数都不是验收标准。

## 员工工作台

`packages/dsh-client-workagent/src/client.js` 只负责宿主接线和官方插槽注册。`app/` 负责页面导航和侧栏组合；`host/` 隔离 DSH 的兼容选择器、浏览器兼容和宿主导航；`platform/` 只处理 HTTP 和通用资源加载；`ui/` 提供通用控件和展示格式。

业务代码和独立测试位于 `src/features/`：

| 功能             | 目录                               | 主要职责                                               |
| ---------------- | ---------------------------------- | ------------------------------------------------------ |
| 助手和模型       | `agents/`                          | 助手配置、头像、选择器、模型默认值、助手更新通知       |
| 会话             | `conversations/`                   | 首页输入、消息、发送回执、会话缓存、滚动、原生会话接口 |
| 文件             | `files/`                           | 文件树、预览、上传、移动、回收站、文件侧栏             |
| 协作             | `collaboration/`                   | 共享项目、讨论和协作侧栏数据                           |
| 内容展示         | `content/`                         | 富文本、工具结果、补充问题、编辑和输入附属控件         |
| 能力配置         | `capabilities/`                    | MCP、技能、导入和同步                                  |
| 市场             | `marketplace/`                     | 浏览、安装、发布                                       |
| 定时任务         | `automations/`                     | 定时任务页面和编辑器                                   |
| 团队             | `teams/`                           | 团队任务                                               |
| 通知             | `notifications/`                   | 通知列表、已读确认、完成提醒                           |
| 额度、外观、系统 | `quota/`、`appearance/`、`system/` | 各自的设置和展示                                       |

`platform` 和 `ui` 不引用业务目录。会话缓存由 `conversations/resources.js` 显式传给通用资源加载器；助手更新订阅由 `agents/api.js` 拥有。修改缓存或助手刷新规则不需要修改通用 HTTP 层。

源码使用正常 ESM 导入。`build.mjs` 用 esbuild 生成对外的 `client.js`，并包装成 DSH 官方 `factory(require)` 接口；React 和官方 UI primitives 由宿主提供，不打包第二份。公开部署入口与插槽保持兼容。共享文件和上传规则通过 `@workagent/contracts` 的包导出使用，不再读取兄弟包源码、删掉 import/export 后拼接。

宿主兼容处理只修改确定属于 DSH 的控件，不扫描翻译整页文本。用户消息、文件预览、编辑器和其他插件内容不归它所有。宿主效果退出时清理观察器、监听器和自行创建的样式资源。

业务样式也按目录归属。`src/styles.css` 显式控制连续样式模块的顺序，构建仍输出公开的 `tokens.css`。两轮职责迁移均验证拆分前后压缩结果逐字节一致，不改变层叠效果。涉及 DSH 私有结构的首页、输入框、文件面板和设置兼容规则归到 `host/`；`app/shared-responsive.css` 仍保留跨功能的历史布局规则，后续有实际视觉改动时再收敛。

个人协作任务的客户端入口位于 `features/collaboration/personal-tasks.js`，负责稳定操作标识、提交去重和进度查询。完整创建、关联、删除与失败恢复由服务端用例负责，浏览器不再重复实现跨服务补偿规则。此模块可独立验证丢响应、重复点击、并发配置、状态查询和删除入口。

## 管理后台

`apps/web/src/features/admin/AdminPortal.tsx` 负责导航与组合。`accounts/` 拥有账号目录、创建与维护任务；`market/`、`usage/`、`storage/`、`audit/` 分别拥有自己的请求、类型和界面。跨功能传递实际需要的用户名和 SID，不导入完整账号内部模型。通用错误展示和基础控件位于 `shared/`，HTTP 传输位于 `apps/web/src/shared/api/`。

账号任务状态保留在账号模块；切到市场或审计页面不会停止创建任务的状态跟踪。

## 开发时如何验证

初次准备执行 `pnpm --filter @workagent/contracts build`。之后功能测试直接运行源码，不依赖生成插件、注册全部页面或启动生产服务：

```text
pnpm --filter @workagent/dsh-client exec vitest run src/features/files
pnpm --filter @workagent/dsh-client exec vitest run src/features/conversations
pnpm --filter @workagent/dsh-client exec vitest run src/features/agents
pnpm --filter @workagent/dsh-client exec vitest run src/features/notifications
pnpm --filter @workagent/web exec vitest run src/features/admin/accounts
pnpm --filter @workagent/web exec vitest run src/features/admin/market
```

文件模块测试直接加载文件管理器，验证项目路径、内容安全和卸载后停止刷新；会话发送测试直接加载会话页面，验证失败草稿和回执去重；助手测试验证默认值隔离与成功后刷新；通知测试验证确认失败不跳转。管理端各业务 API 也可以单独运行测试。

完整回归使用 `pnpm --filter @workagent/dsh-client test`、`pnpm --filter @workagent/web test`、`pnpm --filter @workagent/web typecheck` 和 `pnpm dsh:check`。`component.test.jsx` 保留官方插槽与完整组装集成测试；`module-boundaries.test.js` 使用真实构建依赖图检查循环、反向引用、包封装、React 外置和未声明变量。

后续新增功能先放到对应业务目录。只有出现真实复用时才提取公共能力；不添加通用插件总线、服务定位器或大而全的依赖对象。`content/workbench.js` 与协作模块仍包含较多同功能逻辑；继续拆分应由具体改动和可独立验证的边界驱动。
