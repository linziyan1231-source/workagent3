Record reusable guidance here only you think is necessary.

## Engineering Principles

- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Keep components modular and concerns clearly separated.
- Do not over-defend: defensive code should target failures that can actually happen. Skip guards for practically impossible cases — e.g. nil-checking a value the constructor guarantees, avoid using Hash and SHA256, or error-handling a `json.Marshal` of plain scalar structs. Such branches are dead code and only add noise.

## Test Deployment

- Serialize test-server activation across concurrent tasks. Check the active release immediately before switching; coordinate with other tasks and reuse a verified release that already contains the changes.
- Runtime and UI changes are not complete until they are deployed to the dedicated test server `106.53.187.253` and verified through the existing local SSH tunnel at `http://127.0.0.1:18300`.
- Publish immutable, side-by-side releases under `C:\WorkAgent3Test\releases\<version>`; never overwrite an active release or clear persistent data. Keep the previous Portal wrapper and employee-manager configuration available for rollback.
- A release containing runtime or UI changes must keep Portal, UserHost, Web, and the complete Harness profile on one release version. Update both the Portal wrapper and employee-manager runtime/profile pointers, then restart/reproject both employee runtimes.
- Reproject complete Harness profiles into fresh staging directories and swap them after stopping the employee runtime, as `projectHarnessProfile` does. Do not overlay a flattened release onto an existing pnpm-linked profile: directory/link mismatches can leave the effective packages stale. Verify resolved package files after activation.
- Before swapping profiles, pause Portal ingress and employee-manager so open browser requests cannot restart an old runtime during the swap. Start browser smoke tests only after activation and runtime health checks finish.
- Verification must include `/healthz`, active process command lines pointing at the new release, relevant automated smoke tests, and an authenticated browser smoke of `/?frontend=dsh`. Preserve deployment/test evidence under `C:\WorkAgent3Test\accept-eb91d1d\evidence`.
- Keep server addresses, credentials, release paths, and deployment-only settings out of product code. Never print or commit credentials; read test credentials only from the server-side secrets store when running authorized checks.
- Employee scheduled tasks use password logon through a fixed `userhost-launcher.exe`. Windows credentials are retained in the SYSTEM DPAPI vault; Portal passwords never update these tasks. Release activation must update the SID launch manifests as well as runtime/profile pointers. Ordinary repair reuses the managed credential without resetting the Windows password. Follow `docs/employee-windows-credentials.md` for explicit migration, rotation and recovery backups.
- Task ACLs deny direct administrator starts; reuse `Start-UserhostViaSystem`. Rollback restores profiles, service wrappers and launch manifests without changing task actions or Windows passwords. Finish any pending credential migration journal before software rollback; restoring a release cannot reverse an OS password change.
