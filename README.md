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

Speech input is disabled unless the Portal administrator sets both
`WORKAGENT_SPEECH_URL` and `WORKAGENT_SPEECH_TOKEN`. The URL points to the
private batch/WebSocket transcription adapter; the token is injected only by
the Portal proxy and is never returned to the browser.

The Go wrapper in `scripts/go.ps1` uses `go` from `PATH`, or the checksum-verified portable toolchain installed at `C:\Users\Administrator\.codex\tools\go1.26.5-verified` on this development machine.

Runtime data, secrets, employee profiles, and `DSH_HOME` are never stored in this repository.
