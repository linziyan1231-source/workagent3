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

`databasePath` must be the same Portal database file the Portal serves (the
employee records live in the Portal store), and `auditDatabasePath` and
`quotaDatabasePath` must point at the `audit.db`/`quota.db` beside it — see
`docs/employee-manager.config.example.json`. The Portal additionally needs the
builtin assistant resources: pass `-assistant-resources` pointing at the
release copy of `third_party/aionui/resources/puxin-builtin-assistants`, or it
refuses to serve.

The optional `managedMcpServers` array is the release-owned half of the same
contract. Employee Manager expands `${SID}`, `${DATA_ROOT}`, and
`${WORKSPACE_ROOT}` in transport commands, arguments, and URLs before writing
the private UserHost configuration. UserHost atomically reconciles only
`source: "managed"` entries and never updates or removes user-owned MCP
servers. A DWG definition can therefore invoke the released adapter without a
WorkAgent2 path:

```json
{
  "id": "dwg-quantity-surveyor",
  "name": "DWG Quantity Surveyor",
  "description": "Per-SID DWG, Tianzheng, 3D, and BOQ tools",
  "source": "managed",
  "enabled": true,
  "transport": {
    "kind": "stdio",
    "command": "C:\\Program Files\\AionAgentCliShared\\bin\\python.exe",
    "args": [
      "E:\\WorkAgent3\\release\\managed-mcp\\dwg_launcher.py",
      "--plugin-root",
      "E:\\WorkAgent3\\components\\dwg-quantity-surveyor",
      "--workspace-root",
      "${WORKSPACE_ROOT}"
    ]
  },
  "toolPolicy": "all",
  "allowedTools": [],
  "oauthState": "none",
  "health": "unknown"
}
```

The plugin root is a separately versioned immutable component copied from the
latest WorkAgent2 DWG package; it is not an employee checkout. The adapter sets
`DWG_QUANTITY_ROOT` to the expanded SID workspace before starting the plugin.
For the professional-database MCP, use either its exact managed loopback broker
endpoint or an HTTPS remote endpoint. Its `headerCredentialIds` must reference
an MCP-header credential in that employee's private broker. Never place the
bearer value in this configuration. Changes to managed definitions take effect
through the normal repair/release workflow; the browser MCP CRUD API remains
restricted to user-owned servers.

Before activating a DWG component, run its native dependency and protocol gate
against the immutable candidate package:

```powershell
$env:WORKAGENT_DWG_PLUGIN_ROOT = 'E:\WorkAgent3\components\dwg-quantity-surveyor'
$env:WORKAGENT_PYTHON_COMMAND = 'C:\Program Files\AionAgentCliShared\bin\python.exe'
pnpm dwg:smoke
```

The gate creates a temporary SID-style workspace, verifies LibreDWG and the
interactive Tianzheng converter dependencies, then starts the real MCP over
stdio and requires a valid JSON-RPC initialize result. It removes the temporary
workspace and does not read provider or MCP credentials.

The professional-database gate reads an existing employee grant only from its
protected legacy UserHost configuration. It never prints the bearer value. The
default gate proves authentication, MCP initialization, tool discovery and the
employee source allowlist. Set the explicit live-call switch only when spending
one datasource quota unit is intended:

```powershell
$env:WORKAGENT_LEGACY_USERHOST_CONFIG = 'C:\ProgramData\AionUiPortal\users\<SID>\userhost.json'
pnpm professional-database:smoke

$env:WORKAGENT_PROFESSIONAL_DATABASE_LIVE_CALL = '1'
pnpm professional-database:smoke
```

For one-time migration, stop the SID Runtime and pass both its new private
`userhost.json` and protected WorkAgent2 UserHost configuration to
`skill-migrate` via `--userhost-config` and `--legacy-userhost-config`. The
migrator verifies both SIDs and endpoints, seals the grant directly into that
SID's WorkAgent3 Credential Broker, and writes only the credential ID into the
managed MCP transport. The migration report never contains the token.

Run the semantic Wiki gate with a signed-in native Codex CLI. The gate creates
and later removes a temporary project, uses the released Wiki ingest and query
Skills, and requires provenance, the lease/overlay/snapshot/manifest commit
gates, zero-error/zero-warning deterministic lint, a cited answer, and an
unchanged Wiki hash after the read-only query:

```powershell
$env:WORKAGENT_CODEX_COMMAND = 'C:\Program Files\AionAgentCliShared\bin\codex.exe'
$env:WORKAGENT_PYTHON_COMMAND = 'C:\Program Files\AionAgentCliShared\bin\python.exe'
pnpm wiki:semantic-smoke
```

Failed semantic runs retain their temporary evidence path for diagnosis; only
successful runs are automatically removed.

Run the Harness restart-recovery gate after changing its Profile, persistence,
Workspace, attachment, or Artifact components:

```powershell
pnpm profile:recovery-smoke
```

The gate builds and installs the formal Profile into a fresh SID-style temporary
DSH Home, creates a Workspace and Harness Session with an attachment and an
Artifact, terminates that Harness process, starts a new Harness against the same
private Home, and requires the Session and both assets to be readable. It then
removes only its validated temporary root.

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

Portal refuses to start without the managed Harness model: pass
`-harness-model` or set `WORKAGENT_HARNESS_MODEL` to the configured Codex
model, the same value as `modelGateway.codexModel` in the Employee Manager
configuration.

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

## Managed Provider credential and health

Employees enter the DeepSeek Harness credential through the formal Web 78
Model Settings editor. The browser sends it once to that employee's Runtime;
the Runtime seals it in the SID Credential Broker with DPAPI and returns only
credential metadata. UserHost projects the value over the authenticated
loopback Harness Port after every start and on rotation or revocation.

The WorkAgent Profile disables DSH's file-backed credential provider. The
replacement implements the official `ctx.credentials` contract but retains
projected values only in process memory, so a Provider edit must not create
`$DSH_HOME/.credentials.yaml`. Do not copy an old WorkAgent2 ChatGPT/Kimi proxy
key into the DeepSeek reference: those are separate native Engine credentials,
not `DEEPSEEK_API_KEY`.

The original Model Settings health action makes a bounded one-token request
through the official `deepseek-official` adapter. It returns only stable health,
diagnostic code, and elapsed time. Before using its redacted run ID as release
readiness evidence, verify the UI reports `provider_request_succeeded` with the
employee's real credential.

Run the credential-free protocol gate after Profile or credential changes:

```powershell
pnpm provider:projection-smoke
```

This isolated gate starts the formal Profile and a local DeepSeek-compatible
fixture, proves the private credential projection and official adapter stream,
checks that status never includes the key or writes a DSH credential file, and
then revokes the projection. It proves the boundary and protocol only; release
readiness still requires a successful request to the configured managed
Provider.

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

## Managed tools (OfficeCLI)

OfficeCLI ships as the release-owned `managed-tools` component; the Office
Skills rely on it and employees never install it themselves. The pinned record
`release/managed-tools/officecli/manifest.json` fixes the version, SHA-256,
upstream source, and license (Apache-2.0). Install or update from an elevated
deployment shell:

```powershell
scripts\install-officecli.ps1
```

The script downloads the pinned release asset (BITS, falling back to
`Invoke-WebRequest` when BITS is unavailable), verifies its SHA-256 against
the pinned record, proves the staged binary reports the pinned version, then
atomically swaps it into `release\managed-tools\officecli\officecli.exe`. Any
failure rolls back to the previous binary.

The same script also installs the managed PDF exporter plugin used by
`officecli view <file> pdf` (Office→PDF preview). Upstream publishes no
official exporter plugin — the plugin registry is unreachable and
[iOfficeAI/OfficeCLI#171](https://github.com/iOfficeAI/OfficeCLI/issues/171)
is unanswered — so the release builds the internal
`cmd/officecli-exporter-pdf` (plugin protocol v1, kind `exporter`) from
source and installs it to the bundled plugin path
`release\managed-tools\officecli\plugins\exporter\pdf\plugin.exe`, where
`officecli.exe` discovers it automatically (`officecli plugins list` shows
it). The plugin renders text-fidelity PDFs: it extracts document text through
the managed `officecli view <file> text` and paginates it onto A4 pages with
a non-embedded standard CJK font, so previews show full document text but not
the original layout. The build is reproducible with the pinned go1.26.5
toolchain and fixed flags; the manifest `plugins[]` entry pins the plugin
version, SHA-256, and license, and the script verifies the staged plugin's
hash and `--info` identity before the same transactional swap with rollback.
If Go is not on PATH, pass `-GoCommand` (the deployment host carries the
pinned toolchain under the codex tools directory).

When `managedToolsRoot` is configured, Employee Manager refuses to start
unless `officecli.exe` and every manifest-recorded plugin exist there and
match their pinned hashes. Include the component in release manifests so the
immutable release root carries the verified binary and plugin — repeat
`-component` once per artifact file of the component:

```powershell
-component managed-tools=managed-tools/officecli/officecli.exe `
-component managed-tools=managed-tools/officecli/plugins/exporter/pdf/plugin.exe
```

## CLIProxyAPI model gateway

Install CLIProxyAPI from its pinned release and configure it from
`docs/cliproxy.config.example.yaml`. That template pairs with
`docs/employee-manager.config.example.json`: the listener host/port must match
`modelGateway.managementUrl` and `modelGateway.baseUrl`,
`remote-management.secret-key` must equal the key file referenced by
`modelGateway.managementKeyFile`, and `usage-statistics-enabled: true` is
mandatory because the quota drain reads `/v0/management/usage-queue`. Employee
downstream keys are provisioned only through the cpa-key-policy management
plugin, never through static `api-keys`.

Create the management key file with a restricted ACL — only Administrators,
SYSTEM, and the Employee Manager service account may hold access:

```powershell
$keyFile = 'E:\WorkAgent3\cliproxy\management.key'
icacls $keyFile /inheritance:r /grant:r "Administrators:F" "SYSTEM:F" "<service-account>:R"
```

Employee Manager verifies this ACL at startup and refuses to start when any
other principal holds access.

### Usage drain and authoritative quota

Employee Manager (service mode) is the single consumer of
`GET /v0/management/usage-queue`: the endpoint pops records on read, so the
drain persists every record into the quota database before popping the next
batch and retries a failed batch from memory before fetching more. Gateway
records identify the caller by the managed key ID (for example
`aionui-…-chatgpt`), never by key material; the drain maps that ID to the
owning SID through the key index populated at every key provision or repair.
Records are deduplicated by `request_id`.

`quotaDatabasePath` must point at the same `quota.db` the Portal serves: the
Portal reads the drained detail for settlement matching (a settling run
prefers real tokens from matched gateway records over the conservative
estimate, and marks unmatched settlements `estimated`) and for the
authoritative daily/weekly usage shown on the usage page
(`GET /api/quota/gateway-usage`). Never run a second drain consumer against
the same gateway.

Release readiness executes real probes against the installed gateway: an
authenticated management API round trip
(`GET http://127.0.0.1:8317/v0/management/plugins/cpa-key-policy/aliases`)
plus one real model turn per engine boundary (Codex, Kimi, and the Harness
shared-key projection) through temporary, immediately revoked probe keys. Each
probe produces structured redacted evidence (engine, version, run id, time,
result); the release controller records only that structure, never free text,
keys, or URLs with credentials. Readiness records are append-only — the
evidence an activation relied on is never overwritten.

## Component release and rollback

Before operating a real release root, run the local production-CLI lifecycle
gate:

```powershell
pnpm release:smoke
```

It uses real temporary artifacts and SQLite stores, runs the real readiness
probes (which fail by design when no deployed CLIProxyAPI with real engine
credentials is reachable; set `WORKAGENT_RELEASE_SMOKE_GATEWAY_CONFIG` to a
real Employee Manager configuration for the full pass), waits through the same
mandatory 60-second notification window, verifies activated component pointers
and immutable bytes, rolls the activation journal back, and removes its
temporary release root.

The release controller accepts only these independently activatable components:

- `web`
- `portal`
- `employee-manager`
- `userhost`
- `harness-profile`
- `harness-plugin`
- `chatforward`
- `im-connector`
- `managed-tools`

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

Run the real readiness probes against the deployed CLIProxyAPI, then activate.
The probes need the same Employee Manager configuration the deployment uses
(the `modelGateway` section with its management key file); without a deployed
gateway and real upstream engine credentials the readiness action fails and
nothing is recorded:

```powershell
go run ./cmd/release-manager `
  -action readiness `
  -version 3.0.0-rc.1 `
  -gateway-config E:\WorkAgent3\employee-manager\config.json

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

## Managed speech admission and accounting

Speech remains disabled unless both `WORKAGENT_SPEECH_URL` and the private
`WORKAGENT_SPEECH_TOKEN` are configured. The employee must also have Model
Access authorization and a Quota budget for the stable
`speech-transcription` resource. The formal WorkAgent2 SendBox discovers only
the redacted same-origin capability; it never receives the adapter URL or
token.

For both `POST /api/stt` and `GET /api/stt/stream`, Portal reserves the
adapter's maximum stream seconds through `SpeechQuotaPort` before forwarding
audio. It then settles elapsed whole seconds when the batch request or upgraded
connection closes. Authorization, missing budget, exhausted budget and Quota
failure are rejected before the private adapter is called. If settlement is
temporarily unavailable, the reservation remains open and conservatively
blocks unaccounted use.

The Portal and Speech tests use controlled batch and WebSocket adapters to
verify same-origin authentication, private SID/token projection, browser
credential stripping, reserve/settle, and pre-adapter quota rejection:

```powershell
go test ./internal/portal ./internal/quota ./internal/speech
```

## Audit retention and export

Portal prunes audit events older than `-audit-retention-days` (default 180;
`0` disables retention cleanup) once at startup and then daily. Pruned events
are unrecoverable, so export before the window closes when evidence must be
retained longer.

Privileged operators can export bounded, redacted results locally; the
database path must be a regular non-symlink file and `-limit` is 1-1000:

```powershell
go run ./cmd/audit-export `
  -db E:\WorkAgent3\data\audit.db `
  -actor alice -action quota.settle -from 2026-09-01T00:00:00Z -limit 100
```

Administrators can run the same query from the formal admin page or through
`GET /api/portal/admin/audit` and `GET /api/portal/admin/audit/export`; the
export variant downloads the same indented redacted JSON array as
`cmd/audit-export`. Both routes require an administrator session and never
return request bodies, passwords, tokens, prompts, or file contents.

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
  -audit-db E:\WorkAgent3\data\audit.db `
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
  -audit-db E:\WorkAgent3\data\audit.db `
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
- `fresh post-notification readiness evidence is required`: rerun every
  readiness check (engines, provider, and the CLIProxyAPI health gate) after
  the notice and record new redacted evidence IDs.
- `failed integrity verification`: discard the candidate and rebuild under a new
  version. Never edit an installed release directory.
- `component changed after activation`: a later activation owns that component;
  inspect `status` and roll back the newer journal first if appropriate.
- `sid_not_allowed`: start a new isolated restore job with an explicitly reviewed
  SID allow-list.
- `integrity_mismatch` or `size_mismatch`: quarantine the backup and create a new
  snapshot from authoritative owners; do not retry with modified manifest data.

## Deployment notes

Lessons from the first real-server acceptance run:

- Build the Harness profile in place on the target host (`pnpm install` inside
  the release's profile directory). Copying a profile with directory junctions
  expanded breaks Node module resolution
  (`Cannot find package '@deepseek-ai/dsh-app-boot'`).
- In the CLIProxyAPI `config.yaml`, write Windows paths with forward slashes
  inside double-quoted YAML scalars.
- Pipe secrets to Employee Manager as UTF-8 **without** BOM
  (`[Text.UTF8Encoding]::new($false)`). PowerShell 5.1's default UTF-8 encoding
  prepends a BOM, which corrupts the password hash and surfaces later as login
  401s.
- Password-logon scheduled tasks can only be started by SYSTEM. Run
  Employee Manager lifecycle actions (`enable`, `repair`, `set-limits`)
  through its loopback service (which runs as SYSTEM) or from a SYSTEM shell;
  an interactive Administrator CLI call fails at `Start-ScheduledTask` with
  0x80070005.
- On hosts with a global HTTP proxy environment, loopback calls from scripts
  must bypass the proxy (Python's urllib honours `http_proxy` even for
  127.0.0.1); conversely `pnpm` needs the proxy explicitly for registry
  access.
- Disabling, password-resetting, or changing the admin role of an employee
  revokes all of that user's browser sessions by design; sign in again after
  each lifecycle action during drills.
