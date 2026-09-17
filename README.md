# WorkAgent3

WorkAgent3 is a self-hosted, browser-accessible multi-user office agent platform. It runs agent execution on the company's own servers, gives each user an isolated workspace, and integrates each model vendor's native agent harness instead of forcing every model into one harness environment.

## Why WorkAgent3

- **Company-owned infrastructure:** agent processes and files stay on the company's servers — important documents never leave company control, employee computers carry no runtime load, and workspaces stay available 24/7 independent of any personal machine.
- **Built for collaboration:** shared projects, shared assistants, and shared company context make team work a first-class use case, and the company can develop custom features on the platform as needs arise.
- **Native harness per vendor:** frontier models are increasingly trained against their own agent harnesses, and those native tool layers keep getting heavier — running a model on a foreign harness measurably degrades its capability. WorkAgent3 therefore integrates each vendor's own harness (the official DeepSeek Harness Web client composition, plus native Codex and Kimi engines) rather than presenting one harness to every agent.

## WorkAgent3 vs WorkAgent2

WorkAgent3 succeeds [WorkAgent2](https://github.com/linziyan1231-source/workagent2) with the same hosted, per-user-isolated platform model, rebuilt on a new architecture:

- **Architecture:** WorkAgent2 carried its own runtime layer with reviewable patches over agent runtimes. WorkAgent3 composes the official DeepSeek Harness (dsh) Web client directly: Go owns the Windows platform and Portal, TypeScript owns the dsh client composition and WorkAgent slot plugins. The composition is lighter, easier to maintain, and new capabilities ship as slot plugins instead of core changes.
- **New capabilities:** multi-harness model access (managed Harness provider models and native Codex/Kimi engines), IM channel connectivity (WeChat, WeCom, Feishu/Lark, DingTalk, QQ, Telegram), task-completion reminders pushed to IM chats, scheduled tasks, shared projects and collaboration assistants, one-click web publishing, and an admin portal with quotas, audit, and publishing management.

## Platform

Go owns the Windows platform and Portal, while TypeScript owns the official DeepSeek Harness Web client composition, WorkAgent slot plugins, and shared contracts.

## User guide

中文操作说明见 [WorkAgent3 使用指南](docs/user-guide.md)，覆盖首次使用、对话与文件、助手与技能、定时任务、共享协作、消息渠道和管理员操作。

## Prerequisites

- Node.js 24 or newer
- pnpm 11
- Go 1.26 or newer
- Windows for SID, ACL, Task Scheduler, and UserHost integration tests

## Development

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm profile:dump
```

Build the browser client and Portal:

```powershell
pnpm build
& scripts/go.ps1 @('build', '-o', 'bin/portal.exe', './cmd/portal')
```

After authentication, Portal serves the SID-private official dsh Web client and
keeps `apps/web/dist` for login, administration, OAuth, and the temporary
`?frontend=legacy` rollback landing page. Portal defaults to secure cookies. For
a local HTTP-only development run, pass `-secure-cookie=false`. The managed Harness
provider model must be declared with `-harness-model` (or
`WORKAGENT_HARNESS_MODEL`) set to the configured Codex model — the same value
as `modelGateway.codexModel` in the employee-manager configuration (see
`docs/employee-manager.config.example.json`); Portal refuses to start without
it. A first local user can
be created once with `WORKAGENT_BOOTSTRAP_USERNAME`,
`WORKAGENT_BOOTSTRAP_PASSWORD`, and `WORKAGENT_BOOTSTRAP_SID`; do not place
those values in source control. `WORKAGENT_RUNTIME_URL`,
`WORKAGENT_RUNTIME_TOKEN`, and `WORKAGENT_RUNTIME_SID` register a loopback
development runtime. Production runtime registration is owned by UserHost.

To mount the separately deployed ChatForward service at `/chatgpt/`, set
`WORKAGENT_CHATFORWARD_URL` and `WORKAGENT_CHATFORWARD_SECRET_FILE`. The secret
file must be a non-symlink regular file containing at least 32 bytes and must
also be configured in ChatForward for delegated-request verification. Portal
removes browser credentials and sends only a short-lived signed user ID.

The DSH Web **Settings → 消息渠道** page uses the pinned community plugin
`@michengai/dsh-im-connect@0.1.30` for WeChat, WeCom, Feishu/Lark, DingTalk,
QQ, and Telegram. Add an account in that page and complete its QR login or bot
credential setup. The Chinese account settings select Harness provider models
or native Codex/Kimi models. Native conversations use the existing WorkAgent
runtime, including model/permission selection, quota admission, persisted
history, and restart recovery. The complete
WorkAgent profile includes the plugin and its native account-management UI;
no separate IM Gateway process is needed for this page.

Each employee owns their channel state under their SID-private `DSH_HOME`.
An isolated Cordis credentials realm gives the channel plugin the official
durable local credential provider, while managed model credentials continue
to use the memory-only Broker projection. The plugin's credentials therefore
survive runtime restarts without persisting managed model keys. Private-chat
access defaults to approved users. Run `node scripts/smoke-dsh-channel-profile.mjs`
after `pnpm profile:dump` to verify persistence and credential isolation, and
`node scripts/smoke-dsh-channels.mjs` with the usual smoke credentials for the
authenticated settings checks.
`scripts/smoke-dsh-channel-routing.mjs` checks the four adapter routes,
authorization, deduplication, engine switching and persisted channel mappings.
`scripts/smoke-dsh-channel-models.mjs` verifies the advertised Codex/Kimi models
with real authenticated browser turns, without messaging external contacts.

**Settings → 消息提醒** enables optional task-completion pushes. Choose a
connected account's existing chat and the externally reachable WorkAgent
origin, then save. Reminders default to off and are stored per employee on the
server. Successful webpage conversations and scheduled tasks send their final
reply, links to current registered artifacts or workspace files linked in the
reply, and a conversation link. Downloads require the same employee login;
input attachments and files outside the workspace are not added as artifacts.
IM-originated conversations retain their own replies without duplicate pushes.
The durable delivery log shows failures and supports retrying unsent parts.
WeCom uses its SDK's proactive message method; DingTalk uses the existing card
client so reminders do not depend on a recent incoming-message webhook.
Run `scripts/smoke-dsh-completion-notifications.mjs` for authenticated settings
checks with reminders disabled; tests never message real external recipients.

The older external IM Gateway remains a separate optional process for its
existing `/api/channels/` integration:

```powershell
$env:WORKAGENT_IM_DELIVERY_TOKEN = '<shared machine token, at least 32 bytes>'
$env:WORKAGENT_IM_ADMIN_TOKEN = '<Gateway admin token, at least 32 bytes>'
go run ./cmd/im-gateway -portal-url http://127.0.0.1:8080
```

Portal needs the same `WORKAGENT_IM_DELIVERY_TOKEN`, plus
`WORKAGENT_IM_GATEWAY_URL` and the matching `WORKAGENT_IM_ADMIN_TOKEN` for its
authenticated, SID-injecting ChannelPort proxy. Browser sessions never receive
that token. Connector credentials are
regular, non-symlink files under the Gateway `-credential-root`; the Gateway
database stores only their opaque filenames. The version-pinned Weixin
connector uses the iLink `getupdates` and `sendmessage` protocols. Its public
configuration, QR login, enable state, running instance, pairing list, and
authorized users are isolated by owner SID. The Gateway stores the QR login
token directly in its private credential directory and returns no token in the
SSE stream. Pairing approval can only target the Portal-authenticated owner SID
before any message can reach that employee's Runtime.

Speech input is disabled unless the Portal administrator sets both
`WORKAGENT_SPEECH_URL` and `WORKAGENT_SPEECH_TOKEN`. The URL points to the
private batch/WebSocket transcription adapter; the token is injected only by
the Portal proxy and is never returned to the browser. Enabling the adapter
also requires the employee to be authorized for the stable
`speech-transcription` resource and to have a Quota budget for it. Portal
reserves the configured maximum stream seconds before opening either adapter
route and settles elapsed whole seconds when it closes; admission fails closed
before audio reaches the adapter when authorization, budget, or Quota is
unavailable.

Notifications are owned by the separate `notifications.db` module store and
are scoped by employee SID, with global announcements represented by `*`.
Portal exposes authenticated list/read/acknowledge and SSE endpoints and uses
the formal WorkAgent2 notification modal. Administrators can publish a bounded
announcement without accessing Portal/Auth tables:

```powershell
go run ./cmd/notification-publish -db data/notifications.db -kind maintenance -title "Maintenance" -message "The service will restart in 10 minutes." -expires-in 2h
```

Portal generates a new correlation ID for every request, returns it as
`X-WorkAgent-Correlation-ID`, propagates it to downstream services, and records
write/security outcomes in the append-only `audit.db` module without request
bodies, query strings, passwords, tokens, prompts, or file contents. Privileged
operators can export bounded audit results locally:

```powershell
go run ./cmd/audit-export -db data/audit.db -correlation-id '<id>' -limit 100
```

The formal WorkAgent2 System and About pages use Portal's authenticated system
port. `GET /api/system/status` reports build metadata and component health,
`POST /api/system/runtime/restart` asks the current SID's UserHost to exit for
Task Scheduler recovery, and `GET /api/system/diagnostics` downloads a
permission-restricted ZIP containing only redacted build/component metadata and
the request correlation ID. Runtime URLs, tokens, SIDs, request bodies, prompts,
and file contents are excluded. Release builds can inject version metadata with
Go linker flags for `workagent3/internal/buildinfo.Version`, `Commit`, and
`BuildTime`; development builds report `dev` and `unknown` values.

The Go wrapper in `scripts/go.ps1` uses `go` from `PATH`, or the checksum-verified portable toolchain installed at `C:\Users\Administrator\.codex\tools\go1.26.5-verified` on this development machine.

Runtime data, secrets, employee profiles, and `DSH_HOME` are never stored in this repository.

Release activation, rollback, restricted owner backups, and isolated restore
drills are documented in [docs/operations.md](docs/operations.md). The release
gate requires a 60-second upgrade notice plus successful real Harness, Codex,
Kimi, and managed Provider readiness evidence.
