# Employee Windows credentials and runtime upgrades

Employee Windows identities remain separate standard accounts with stable SIDs.
Portal login passwords never register scheduled tasks or change Windows passwords.
The SYSTEM Employee Manager owns Windows credentials; employees and the browser
do not receive them.

## Configuration and storage

Configure `credentialRoot`, `launcherExecutable`, and `launchManifestRoot` in the
Employee Manager configuration. All three paths must be absolute and outside
employee-writable directories. Install `userhost-launcher.exe` at its stable
bootstrap path, with SYSTEM/Administrators write access and Users read/execute.
Build the bootstrap from `./cmd/userhost-launcher` (for example,
`go build -o bin/userhost-launcher.exe ./cmd/userhost-launcher`) and install it
before starting the manager or provisioning an employee. Keep it outside the
versioned application directory selected by the launch manifest.

The credential root has a protected SYSTEM/Administrators DACL. Each record is
encrypted with SYSTEM's current-user DPAPI. A new account's generated password is
persisted before account creation, then bound to its SID. An interrupted creation
can replay without replacing the Windows password. Missing legacy credentials
fail with a migration requirement; ordinary repair never silently resets them.

Each employee task runs the fixed launcher with an administrator-owned manifest.
The manifest binds an executable, UserHost configuration and employee SID. The
launcher checks its actual SID and launches the selected release's UserHost. The
task uses password logon and an at-startup trigger. Changing releases changes the
manifest, not the Windows password or scheduled-task action. The bootstrap is a
separately maintained component and must never be writable by employee accounts.

## Operations

The Portal's **restart** action closes ingress for the employee, stops and starts
the existing task, and reopens the account only after runtime registration.
**Repair** checks the stored credential before stopping service, reprojects the
software references and reinstalls configuration/task using that same credential. Neither
operation changes the Windows password. Supplied Windows passwords are rejected.
Windows-account rename also uses the SID-bound managed credential.

Releases must still be complete and immutable: stage Portal, Web, UserHost and
the full Harness profile together. Serialize activation, pause ingress and the
manager, stop employees, switch public software references while retaining private profile configuration, update manager/runtime
configuration and launch manifests, and restart. Rollback restores these files
and software references; it does not re-register tasks. See `shared-software-storage.md` for audited legacy migration and retention. Verify the actual UserHost process
path and resolved profile files rather than checking only the launcher path.

## Password maintenance and legacy adoption

These actions run locally as SYSTEM with ingress and the ordinary manager paused;
they are deliberately not exposed as browser password forms. Use the same manager
configuration and employee Portal username as the normal service.

- `--action adopt-windows-credential --source-process-id <employee-pid>` adopts a
  legacy account whose Windows password is missing. The source must belong to the
  exact employee SID and still have a usable loaded profile.
- `--action rotate-windows-credential` changes a managed password using the
  retained old password and synchronizes the scheduled-task credential.
- `--action backup-windows-credential --recovery-file <new-absolute-path>` exports
  an independently encrypted recovery envelope. Read the recovery passphrase
  (at least 24 bytes) from protected stdin; never put it in command arguments.
- `--action restore-windows-credential --recovery-file <absolute-path>` imports a
  missing vault record using that passphrase. The original Windows account SID
  and profile must already have been restored; this is not account recreation.

Adoption checks for Windows credential/private-key files, browser credential
stores and EFS-encrypted files before resetting anything. Detected external
material requires a separate recovery procedure; the application broker snapshot
does not cover every possible third-party use of DPAPI.
The EFS walk excludes rebuildable Harness release projections under
`dsh-home/profiles`; persistent employee data and the Windows profile are scanned.

Portal restart, repair and rename return a background job immediately. Maintenance
jobs are persisted in `employee-jobs.db` next to the manager database. Refreshing
the browser resumes polling the saved job. A manager restart marks unfinished
jobs interrupted rather than replaying operating-system mutations automatically;
inspect the account state and retry the same maintenance action.

The migration reads all nonempty broker records under the existing employee token,
including expired credentials, and seals their recovery snapshot under SYSTEM.
It saves the pending new password and phase before modifying Windows. After the
change it logs on with the new password, loads the employee profile, re-protects
broker records under that identity, verifies decryption, and registers the fixed
launcher. The same SID, profile, workspace and conversation data are retained.

If interrupted, rerun the same maintenance action. It first tests whether the
pending password already works, so a crash after the OS mutation does not require
the old password. Ordinary repair refuses an unfinished migration. The journal
retains the encrypted broker snapshot for recovery. A password reset is not
reversed by restoring a previous release directory: recovery must finish with the
pending credential. Keep rollback software capable of using the fixed launcher.

A legacy UserHost may exit when Portal is paused. Check that the source PID still
exists immediately before adoption; an exited source fails before a password
change. For another legacy account after that failure, restore its old runtime
and obtain a fresh source PID. Do not repeat adoption for an already completed
account. A saved pending journal resumes without the old PID.

## Recovery backup

DPAPI-sealed vault files alone are machine-bound. Recovery envelopes use scrypt
and AES-GCM and can be imported under a restored service identity. Keep their
passphrases separately, and include the Windows account/profile, application
databases and employee data in the host backup. Restoring only an account name
creates a different SID and is not sufficient.

Copy recovery envelopes and the corresponding host/data backups into the
operator's established off-host backup system. A copy on the test server is
useful for local recovery but is not protection against loss of that server.

## Acceptance

The opt-in `TestManagedCredentialsLiveRecovery` runs only for a disposable
`wa3cred-*` employee on the dedicated test host. It deliberately removes the
managed record, seeds a DPAPI credential, interrupts adoption after the Windows
password changes, resumes with a new platform instance, checks exact broker
contents after fresh logon, performs normal password rotation, and starts the
fixed launcher. Normal unit tests cover recovery-envelope authentication,
cross-SID rejection, persisted pending credentials and manifest validation.

Production acceptance also requires authenticated Portal restart/repair, actual
model calls, complete release activation and rollback, fresh-profile credential
checks, and denial of employee access to the vault/launch configuration.
