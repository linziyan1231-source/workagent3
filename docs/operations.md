# WorkAgent3 administrator operations

This runbook covers the Operations/Release data owner. Run the commands from an
elevated deployment shell whose account alone can read the data and release
roots. Do not put passwords, session tokens, Runtime tokens, OAuth material, or
provider keys in command arguments, manifests, readiness evidence, or tickets.

## Component release and rollback

The release controller accepts only these independently activatable components:

- `web`
- `portal`
- `employee-manager`
- `userhost`
- `harness-profile`
- `harness-plugin`
- `chatforward`
- `im-connector`

Prepare one immutable archive or binary per included component under a new
candidate directory. Build and install its manifest:

```powershell
go run ./cmd/release-manager `
  -action manifest `
  -version 3.0.0-rc.1 `
  -source E:\WorkAgent3\candidate-3.0.0-rc.1 `
  -component web=components/web.zip `
  -component portal=components/portal.zip

go run ./cmd/release-manager `
  -action install `
  -manifest E:\WorkAgent3\candidate-3.0.0-rc.1\workagent-release.json `
  -source E:\WorkAgent3\candidate-3.0.0-rc.1
```

Installation copies verified artifacts into the private release root and never
changes active component pointers. Reusing a version with different bytes is
rejected.

Publish the upgrade notice before readiness and activation:

```powershell
go run ./cmd/release-manager -action notify -version 3.0.0-rc.1
```

Releases containing `userhost`, `harness-profile`, or `harness-plugin` publish
the task-interruption warning. Other known components publish the page-refresh
warning. Unknown component names are rejected. Activation is impossible until
the notice is at least 60 seconds old.

Exercise a real request through each candidate engine/provider boundary. Record
only redacted request or test-run identifiers, never URLs or credentials:

```powershell
go run ./cmd/release-manager `
  -action readiness `
  -version 3.0.0-rc.1 `
  -harness-evidence harness-run-20260831-01 `
  -codex-evidence codex-run-20260831-01 `
  -kimi-evidence kimi-run-20260831-01 `
  -provider-evidence provider-run-20260831-01

go run ./cmd/release-manager -action activate -version 3.0.0-rc.1
go run ./cmd/release-manager -action status
```

The activation result includes its journal ID. Roll back that exact activation
if post-activation checks fail:

```powershell
go run ./cmd/release-manager -action rollback -activation-id 42
```

Rollback refuses an already rolled-back journal or a component that has moved
to another release since the journal was committed.

## Restricted metadata backup

Create snapshots by authoritative data owner. Global owners are `portal-auth`,
`collaboration`, `quota`, `skill-market`, `notifications`, `audit`, `settings`,
and `model-access`. SID-scoped metadata owners are `preset`, `automation`,
`skill`, and `mcp`, expressed as `owner@SID`.

```powershell
go run ./cmd/backup-manager `
  -action create `
  -version 3.0.0-rc.1 `
  -backup-root E:\WorkAgent3\restricted-backups `
  -source portal-auth=E:\WorkAgent3\data\portal.db `
  -source collaboration=E:\WorkAgent3\data\collaboration.db `
  -source notifications=E:\WorkAgent3\data\notifications.db `
  -source audit=E:\WorkAgent3\data\audit.db `
  -source 'preset@S-1-5-21-1000=E:\EmployeeData\S-1-5-21-1000\preset.db'
```

Each owner receives its own consistent SQLite snapshot and a size/hash manifest.
The Portal/Auth exporter retains users and password hashes but drops active
session tokens and Runtime registration credentials. The default backup format
also excludes plaintext credentials, native Codex/Kimi authentication,
conversation/prompt bodies, and Workspace files. Credential Broker stores are
not valid sources.

Workspace/shared files and native authentication require a separately approved,
encrypted backup target and must never be added to this metadata command.

## Isolated restore drill

Restore only into a new isolated job root. Explicitly allow every SID present in
SID-scoped entries:

```powershell
go run ./cmd/backup-manager `
  -action restore `
  -version 3.0.0-rc.1 `
  -backup E:\WorkAgent3\restricted-backups\backup-20260831T030000Z-0123456789abcdef `
  -restore-root E:\WorkAgent3\restore-drills `
  -allow-sid S-1-5-21-1000
```

The restore validates the exact application version, SID allow-list, artifact
type, size, and digest before copying. It creates a durable
`restore-journal.json`; failed jobs remain isolated with a non-secret failure
code and cannot be reused or mixed with a later attempt.

For a complete recovery rehearsal, compose a test instance from the restored
owner snapshots, restore any separately authorized encrypted Workspace set,
then retain evidence for all of these gates:

1. A restored user can log in.
2. The user's SID Runtime starts and completes a real Harness request.
3. An allowed Workspace can be read.
4. A second SID cannot read the first SID's data or Workspace.
5. Codex, Kimi, and managed Provider readiness requests succeed.
6. No production listener, scheduled task, or data directory was used.

## Troubleshooting

- `upgrade notification must be published`: publish the notice and wait the full
  60 seconds; do not alter timestamps.
- `fresh post-notification readiness evidence is required`: rerun all four real
  requests after the notice and record new redacted evidence IDs.
- `failed integrity verification`: discard the candidate and rebuild under a new
  version. Never edit an installed release directory.
- `component changed after activation`: a later activation owns that component;
  inspect `status` and roll back the newer journal first if appropriate.
- `sid_not_allowed`: start a new isolated restore job with an explicitly reviewed
  SID allow-list.
- `integrity_mismatch` or `size_mismatch`: quarantine the backup and create a new
  snapshot from authoritative owners; do not retry with modified manifest data.
