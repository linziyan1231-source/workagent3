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

The Go wrapper in `scripts/go.ps1` uses `go` from `PATH`, or the checksum-verified portable toolchain installed at `C:\Users\Administrator\.codex\tools\go1.26.5-verified` on this development machine.

Runtime data, secrets, employee profiles, and `DSH_HOME` are never stored in this repository.
