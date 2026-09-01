# WorkAgent3 administrator operations

This runbook covers the Operations/Release data owner. Run the commands from an
elevated deployment shell whose account alone can read the data and release
roots. Do not put passwords, session tokens, Runtime tokens, OAuth material, or
provider keys in command arguments, manifests, readiness evidence, or tickets.

## Employee lifecycle

Run Employee Manager from an elevated deployment shell. Its configuration and
Portal database must be private to the service account. Passwords are accepted
only on standard input; never put them in command arguments or environment
variables.

```powershell
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action add -username alice
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action disable -username alice
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action enable -username alice
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action reset-password -username alice
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action repair -username alice
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action rename-windows -username alice -new-windows-username alice2
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action set-limits -username alice -memory-bytes 4294967296 -cpu-percent 50 -active-processes 64
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action offboard-retain -username alice
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action offboard-delete -username alice -confirm-delete "DELETE alice"
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action grant-admin -username manager
employee-manager.exe -config E:\WorkAgent3\employee-manager.json -action revoke-admin -username manager
```

`add` and `reset-password` wait for a new Portal password on standard input;
`repair` and `rename-windows` wait for the managed Windows account password on
standard input.
Use the deployment secret-input mechanism so the value is not retained in
PowerShell history. `disable` atomically revokes active browser sessions before
stopping the employee's scheduled UserHost. If the stop fails, the account
remains disabled. `enable` starts the installed UserHost and waits for its
authenticated Runtime lease before reopening the Portal account. A failed
health check leaves the employee disabled.

The Employee Manager configuration must set `managedSkillsRoot` to the
absolute path of the active release's `managed-skills` directory. Provisioning
and repair copy that immutable release location into the SID-private UserHost
configuration; UserHost then synchronizes the catalog under the employee SID.
Do not point it at a developer checkout or an employee-writable directory.

`set-limits` revokes active sessions, stops the Runtime, atomically updates the
SID-private UserHost configuration, starts a new Job Object, waits for a healthy
lease, and only then re-enables the account. Invalid limits are rejected before
the account changes. An update or health failure leaves the employee disabled
for explicit repair.

`offboard-retain` is the non-destructive departure action. It revokes login,
stops the Runtime, unregisters the scheduled task, and records the employee as
offboarded while preserving the Windows SID, private data root, Workspace, and
native Codex/Kimi authentication. Ordinary `enable` cannot reopen an offboarded
employee. Permanent data deletion is a separate high-risk workflow and is not
implied by this command.

`repair` rotates the managed Windows password, verifies that the account still
maps to the original SID, recreates its Profile/private roots, reprojects the
released Harness Profile, rebuilds the scheduled UserHost task, and waits for a
healthy authenticated Runtime lease. Only then does it clear retained-offboard
state and reopen Portal login. Missing retained Runtime registration material
or any SID mismatch fails closed.

`rename-windows` preserves the Portal username and SID. It freezes Portal
access, renames only the managed local Windows account, verifies the new name
resolves to the original SID, rebuilds the SID task with the supplied Windows
credential, and commits the new canonical Windows name only after the Runtime
is healthy. A partial attempt is safe to repeat with the same target name.

`offboard-delete` is irreversible and accepts only an already retained,
disabled, non-administrator employee. The confirmation must exactly equal
`DELETE <username>`. Employee Manager resolves the target to one direct SID
child of the configured data root and rejects traversal, links, files, or any
other target before unregistering the task. It then deletes only that SID data
root, removes the SID from `SeBatchLogonRight`, and deletes its verified
WorkAgent3-managed local account, followed by the Portal
mapping and Runtime registration credential. Never invoke this command as part
of ordinary disable or retained offboarding.

For the formal browser administrator page, run Employee Manager as its own
privileged service on loopback and point Portal at it. The token file must be an
absolute path readable only by the Employee Manager identity and Portal service
identity; the token itself must not be placed in either command arguments or an
environment variable.

```powershell
employee-manager.exe `
  -config E:\WorkAgent3\employee-manager.json `
  -listen 127.0.0.1:8091 `
  -token-file E:\WorkAgent3\secrets\employee-manager.token

$env:WORKAGENT_EMPLOYEE_MANAGER_URL = 'http://127.0.0.1:8091'
$env:WORKAGENT_EMPLOYEE_MANAGER_TOKEN_FILE = 'E:\WorkAgent3\secrets\employee-manager.token'
portal.exe # include the normal Portal arguments
```

Granting or revoking the administrator role invalidates that user's existing
browser sessions. After signing in again, an administrator is routed by the
formal WorkAgent Renderer to `/admin/accounts`; non-administrators receive 403
from every employee-management route even if they call the HTTP API directly.
Portal exposes the same lifecycle boundary at
`POST /api/portal/admin/users/{action}` for `repair`, `rename-windows`,
`set-limits`, `offboard-retain`, and `offboard-delete`. These routes require an
administrator session and same-origin request; Portal forwards them only to the
authenticated loopback Employee Manager. Permanent deletion additionally
requires the JSON confirmation value to exactly equal `DELETE <username>`.

## Three-engine MCP acceptance

Run the deterministic MCP smoke under the target employee SID after native
Codex and Kimi authentication is ready. Point it at that SID's private native
homes; do not copy credentials into the repository or a shared test account.

```powershell
$env:WORKAGENT_CODEX_SMOKE_HOME = 'E:\EmployeeData\S-1-5-21-1000\profile\.codex'
$env:WORKAGENT_KIMI_SMOKE_HOME = 'E:\EmployeeData\S-1-5-21-1000\profile\.kimi'
pnpm mcp:smoke
```

The gate launches the same credential-free managed stdio MCP through the
official Harness MCP client, Codex app-server and Kimi ACP. It verifies the MCP
handshake plus a real Harness `ping` tool call without sending a model prompt or
printing native credentials.

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
