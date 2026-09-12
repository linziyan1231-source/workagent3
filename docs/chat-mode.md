# 独立聊天模式

侧栏的「聊天模式」打开独立聊天网页。「助手」的配置入口位于设置中。

## 后续配置网页地址

1. 打开 **设置 → 系统与帮助 → 聊天模式**。
2. 在「聊天网页地址」填写已经部署的聊天网页完整地址，例如旧版
   WorkAgent Portal 的 `https://your-portal.example/chatgpt/`。
3. 点击「保存聊天地址」，再点击侧栏的「聊天模式」。

配置仅保存在当前浏览器，刷新后仍然有效；换设备或浏览器时需要重新填写。
清空地址并保存，会恢复本站 `/chatgpt/` 入口。新网页需要自己的登录状态，
WorkAgent3 不会向外部网页传递 Portal 的登录凭据。

## 后续接入本站代理

WorkAgent3 Portal 已支持以下启动环境变量；设置后重启 Portal：

| 环境变量                            | 用途                                               |
| ----------------------------------- | -------------------------------------------------- |
| `WORKAGENT_CHATFORWARD_URL`         | Portal 能访问的 ChatForward 服务 HTTP(S) 地址      |
| `WORKAGENT_CHATFORWARD_SECRET_FILE` | 双方约定的签名密钥文件，普通文件且内容至少 32 字节 |

部署地址和密钥文件由部署环境提供，不写入前端源码。本站尚未接入服务时，
`/chatgpt/` 返回 `503 chatforward_unavailable`；这不影响保存外部聊天网页地址。

## 新版配额协议

已对照旧项目 `C:\projects\WorkAgent2\internal\portal\chatforward.go`
及 `C:\projects\ChatForward` 的启动器、认证和服务代码：

- 旧版入口同样是 Portal 的 `/chatgpt/`，由 Portal 代理 ChatForward。
- ChatForward 的 Chrome 扩展依赖已登录的源端 ChatGPT 页面。其回环运行时地址
  不是给终端用户直接访问的生产入口；配置外部网页时应填写旧 Portal 的地址。
- 新版 WorkAgent3 在独立 `chatforward.db` 中，把员工 SID 映射为稳定的数字委托身份，
  并实现 `/internal/chatforward/quota/` 下的预留、发送与结果回调。回调要求本机连接和正文签名。
- 必须同步发布支持 `quota-v2` 的 ChatForward 服务与 0.17.0 扩展。旧扩展不能用于受管发送。
- 新账本从零开始，默认每周 7 次 Pro；每周一北京时间零点重置，不迁移旧记录或额度。
  请求实际发出后计次，后续失败、取消或降级不会退款。手动重发是新请求；系统回调重试保持原身份。
- 扩展与服务均持久保存待回调记录；发送结果不明时保留占用，由管理员核查，禁止自动重发或退款。
  服务的 `CHATFORWARD_QUOTA_JOURNAL` 必须放在不可变软件目录之外的私有持久目录。

自动化测试不代替真实源端 Chrome 的发送、重启恢复和跨员工隔离验收。
