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

## 与 WorkAgent2 的关系

已对照旧项目 `C:\projects\WorkAgent2\internal\portal\chatforward.go`
及 `C:\projects\ChatForward` 的启动器、认证和服务代码：

- 旧版入口同样是 Portal 的 `/chatgpt/`，由 Portal 代理 ChatForward。
- ChatForward 的 Chrome 扩展依赖已登录的源端 ChatGPT 页面。其回环运行时地址
  不是给终端用户直接访问的生产入口；配置外部网页时应填写旧 Portal 的地址。
- 两版委托请求使用相同签名头和签名结构，但旧 ChatForward 认证只接受数字用户 ID，
  并调用旧 Portal 的 `/internal/chatforward/quota/reserve` 和 `settle`。
  WorkAgent3 使用字符串用户标识，目前没有这两个旧版配额回调。因此不能把旧服务
  不加适配地接到新版代理，并宣称只填地址就能运行。
- 已有旧版 Portal 可以直接通过上面的「聊天网页地址」接入；将整个 ChatForward
  服务迁入 WorkAgent3 时，还需适配身份与配额回调、配置源端 Chrome/扩展及签名密钥。

本次恢复入口和可配置的网页地址，不启动旧版 ChatForward 或源端 Chrome。
