# WorkAgent3

WorkAgent3 is a Web-only, SID-isolated office agent platform. The implementation follows [plan.md](./plan.md): Go owns the Windows platform and Portal, while TypeScript owns the browser client, shared contracts, and DeepSeek Harness plugins.

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

The Portal serves `apps/web/dist` and defaults to secure cookies. For a local
HTTP-only development run, pass `-secure-cookie=false`. A first local user can
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

The external IM Gateway is a separate process:

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
the Portal proxy and is never returned to the browser.

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
