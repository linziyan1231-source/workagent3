# WorkAgent3 Automation contract for Wiki Dream

## Scheduler rules

Use only the WorkAgent3 Automation capability. Do not invoke a legacy desktop
helper, a desktop cron bridge, Task Scheduler, or an operating-system cron
command.

Each project owns at most one enabled Automation named
`LLM Wiki Dream - <PROJECT_NAME>`. List existing Automations before creating or
updating. Match ownership by the normalized absolute workspace path embedded in
the input. Never replace an unrelated Automation without explicit user
direction.

Every run creates an independent session from an immutable definition snapshot.
Bind the Automation to the current WorkAgent3 Workspace and an existing Preset
that includes the six Wiki Skills. Use the Preset's authorized Engine and model;
do not hard-code a provider credential or a model that the employee has not
been assigned.

## Schedule

The default schedule uses the formal weekly schedule on every weekday at 03:00
in the employee-selected IANA timezone:

```json
{
  "kind": "weekly",
  "daysOfWeek": [0, 1, 2, 3, 4, 5, 6],
  "hour": 3,
  "minute": 0,
  "timezone": "<IANA_TIMEZONE>"
}
```

Use the user's requested time and timezone when supplied. WorkAgent3 does not
accept Quartz or arbitrary shell cron syntax. The single daily Automation runs
incremental Dream on ordinary days and a deep Dream when the scheduler-local
weekday matches `dream.weekly_deep_day` in `wiki-llm/config.json`.

## Definition

Create or update through the public WorkAgent3 Automation Port with this
semantic payload:

```json
{
  "name": "LLM Wiki Dream - <PROJECT_NAME>",
  "enabled": true,
  "schedule": {
    "kind": "weekly",
    "daysOfWeek": [0, 1, 2, 3, 4, 5, 6],
    "hour": 3,
    "minute": 0,
    "timezone": "<IANA_TIMEZONE>"
  },
  "presetId": "<WIKI_PRESET_ID>",
  "engine": "<PRESET_ENGINE>",
  "workspaceId": "<PROJECT_WORKSPACE_ID>",
  "input": "<SELF_CONTAINED_MESSAGE>",
  "notificationPolicy": "on_failure"
}
```

The self-contained input must include the absolute project workspace path and
instruct `$wiki-dream` to read the configured weekly deep day, run one deep or
incremental cycle as appropriate, skip unchanged work, preserve owner-authored
files, and report updated, archived, expired, or purged knowledge.

If the Automation capability is not available in the current session, return
the complete definition as a draft and mark scheduler state `blocked`. Never
claim that an Automation was persisted without reading it back successfully.

## Completion

Report one of `created`, `already-configured`, `updated`, `opted-out`, or
`blocked`. After a create or update, read the definition again and verify the
schedule, Workspace, Preset, Engine, input, enabled state, and notification
policy. Do not expose runtime tokens, internal SID paths, or credentials.
