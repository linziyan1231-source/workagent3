# Shared software and private runtime data

Every published version has one administrator-owned software tree: Portal,
UserHost, Web, the complete Harness dependency graph, native CLIs, common tools,
skills and plugins. Node/Python may live in a separately versioned common tools
tree. Employees receive read/execute access only, including all descendants.
Never run package installation, compilation or dependency repair in a published
tree. Build once in an administrator staging directory, validate dependency
resolution, then publish and select the immutable version.

Employee storage contains configuration and data. The private
`dsh-home/profiles/workagent` keeps `package.json`, `cordis.patch.yml` and the
generated `cordis.yml`; its `node_modules` is a directory reference to the
selected public packages. DSH writes its root configuration on every boot, so
the whole profile must never be linked into the public tree. DSH's adjacent
`profiles/node_modules` fallback contains package references, not copied packages.
The actual Harness entrypoint is in the release. Node follows package references
to their real paths for dependency resolution; hard links are not used.

Personal skills, MCP registrations and imported capabilities keep their existing
private stores. Personal plugin source and dependencies belong under
`dsh-home/plugins/<plugin>` (install packages with that directory as cwd), then
register an absolute plugin path in the employee patch. Do not run `pnpm install`
against the managed profile: its common dependency graph is read-only. A legacy
customized manifest is preserved and blocks automatic migration until reconciled.
The upstream `dsh plugin --profile workagent ...` command forwards to pnpm in
that managed profile, so it is not the personal-plugin installation route.
Install personal packages inside their own plugin directory and register their
absolute paths in the private patch instead.

| Location | Owner / purpose | Storage accounting |
| --- | --- | --- |
| Public releases, common Node/Python | Administrator; employees RX | Outside personal/shared quota roots |
| Deployment staging, software rollback archives | SYSTEM/administrator only | Outside quota roots |
| Employee `dsh-home`, `native`, `runtime` | That SID's configuration, credentials, sessions, personal capabilities | Personal |
| Employee `workspace` | That SID's working files | Personal |
| Employee `cache`, `tmp`, `logs` | Disposable cache, temporary files, runtime logs | Personal |
| Existing `shared/<owner SID>/...` | Existing project membership ACLs | Existing owner's shared quota |
| Company reference/template collection | Designated maintainers write, authorized readers read | Separate administrator-managed collection |

No project, invitation, membership, shared conversation, file ownership or quota
record changes in this migration. Shared tasks/files still use the project
owner's runtime. Independent project runtimes, read-only member roles and file
history remain follow-up work. Company collections must not be substituted for
the writable project-sharing tree or granted all-employee write access.

Harness and UserHost logs rotate at 16 MiB with three retained files (64 MiB per
log stream). At startup, only regular cache files older than 14 days and temporary
files older than 7 days are removed, without following links. npm, pip, uv and
Python bytecode caches explicitly use the employee cache, including UserHost's
MCP children. Credentials, sessions, uploads and personal plugins are never aged
out by this policy. Other application data/log stores retain their own policies.

## Deployment and migration

`publish-shared-release.ps1` seals an assembled staging tree with read/execute
employee ACLs and moves it into a new version. `activate-shared-release.ps1` reads
deployment-specific settings from an external administrator JSON file and performs
the coordinated switch, credential-journal check, rollback and health checks.
It leaves browser acceptance and subsequent cleanup explicitly pending.

Use `profile-reference.exe` (built from `cmd/profile-reference`) for provisioning
and subsequent reference switches. Run it only while the employee is stopped.
The manager uses the same implementation. It refuses normal legacy dependency
directories rather than deleting them. It preserves employee patches and refuses
unexpected manifest changes.

For a legacy profile, use `scripts/migrate-shared-profile.ps1` in PowerShell 7.
Supply explicit previous/public profiles, private destination, a protected archive
on the same volume but outside all quotas, and the new reference utility. `Inspect` compares file bytes
and inventories unknown content. `Migrate` moves only the old dependencies into
the protected archive and creates references, leaving all other data in place.
`Clean -Verified` provides a conservative byte-comparison path after
runtime/browser acceptance; unknown content is retained for review. It is not
a requirement to recompare every known software tree on every cleanup.
`Rollback` uses the saved journal/configuration and either the archived tree or
the previous public version after duplicate cleanup. It never changes credentials.

For mixed archives, `clean-verified-software.ps1` additionally matches pnpm stored
package files against the same packages in public versions. Its dry run lists all
unmatched files; `-Apply -Verified` removes only byte-identical files and empty
directories. Partial cleanup updates the journal before deletion so rollback uses
the previous public reference and retains unmatched content in the archive.

Classify cleanup by evidence before choosing that conservative path:

1. Administrator deployment trees with established provenance and confirmed
   software-only contents can be removed as whole directories after checking
   effective references and preserving the current and two necessary rollback
   versions. A further byte-for-byte pass is unnecessary.
2. Reuse complete content-verification records when evidence establishes that
   the verified tree has not subsequently changed. Record how non-change was
   established; directory names, extensions and size equality alone do not prove it.
3. Leave uncertain employee-writable, modified or mixed trees in place and list
   them for follow-up. They do not block completion of known-software cleanup.

An explicit authorization declaring particular historical test archives
disposable supersedes content-preservation checks for those archives. After
checking live references and retaining system dependencies and rollback versions,
they may be deleted as directories. A slow historical deletion can be paused at
a directory checkpoint with a remaining-path list; it is not a deployment gate.
Such authorization never implicitly extends to subsequent production data.

Before retiring comparison versions, stop pending verification and preserve its
completed records, partial logs and deferred-directory list. Do not retain all
historical sources indefinitely for deferred unknown content. Confirm that the
current release and two necessary rollback releases remain usable, then remove
eligible old software directories natively. Reuse existing measurements and
acceptance; do not add performance experiments or rerun full functional suites
for cleanup. One final health, retained-version integrity and permission check
is sufficient unless it finds a concrete failure. Maintenance pause should drain archive checkpoints and
save partial state without stopping business services. Do not disable protection
or quotas, change credentials, or increase cloud costs to accelerate cleanup.

Serialize preparation, activation and retention with one exclusive activation
lock. Re-read the current manager pointer immediately before switching. Pause
Portal ingress and manager before stopping employees. Save service wrappers,
manager/runtime configuration and SID launch manifests outside employee quotas;
switch them together. Restore them together on failure. Keep the fixed launcher,
SID, password-logon tasks and Windows DPAPI vault unchanged, and finish any pending
credential maintenance journal first. Verify health, actual process paths,
resolved packages, employee write-denial on public software, private-data isolation,
authenticated DSH access and shared-project behavior before cleanup.

`retain-software-releases.ps1` holds the activation lock, reads the supplied live
reference files, scheduled task actions, all process command lines and employee directory references, and
retains every referenced version plus two unreferenced rollback versions. Staging
expires after seven days. Only explicitly inventoried `software-release.json`
trees are eligible; unidentified content is retained. Run a dry run first and
persist its output. Use `-Apply` after checking the report. Supply all service,
manager and launch pointer files; dangling/unreadable references fail the run.
The administrator publication manifest contains `kind: immutable-software`,
`version`, `state: published|staging`, and the complete top-level `entries` list.
Existing unmarked releases require inventory before adoption; directory names
alone never authorize removal. Supply an external `-InventoryRoot` catalog for
legacy releases so inventory does not modify their immutable contents. Run
retention after successful release acceptance.
