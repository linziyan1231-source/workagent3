# Employee runtime and storage policy

Employee Manager reads `runtimePolicy.maxRunningRuntimes` and
`runtimePolicy.idleMinutes`. Omitted settings default to 20 resident employee
runtimes and 30 idle minutes. Zero disables the respective limit. Startup counts
running employee scheduled tasks and serializes starts through the manager's
Windows platform. The fixed launcher and task ACLs remain unchanged.

Portal access wakes an enabled employee on demand. A 30-second manager sweep
reclaims only registered runtimes with no open proxy requests, recent access,
native turns, queued input, inbox/team work, notification deliveries or enabled IM
channel pollers. The controller checks activity again after closing admission.
Unknown/unreachable activity leaves the runtime resident. Open browser WebSockets
keep the runtime resident. Polling IM connectors remain online to receive messages.

The controller persists the next scheduled automation time in
`runtime-wakeups.json` beside the manager database before stopping the runtime.
It attempts startup 30 seconds before that time; capacity or startup failures
retain the wake entry for retry. A machine restart or saturated capacity may delay
execution. Portal and Harness admission gates expire after two minutes if the
manager crashes during reclamation.

`storageLimits.personalBytes` and `sharedBytes` optionally initialize Windows FSRM
hard quotas on each employee's private data root and owned shared-project root.
Install the File Server Resource Manager Windows role before enabling these
settings. Values must be 1 MiB–100 TiB. Existing per-employee quotas are preserved
on normal startup; administrators change them through the employee disk-space
panel. The employee settings page shows current usage and whether a hard quota
is enabled. Quotas cover native tools and all file APIs, not just browser uploads.
Software rollback preserves quota settings and persistent data.
