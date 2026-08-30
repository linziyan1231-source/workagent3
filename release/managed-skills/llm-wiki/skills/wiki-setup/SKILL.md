---
name: wiki-setup
description: Initialize, adopt, or migrate a project-local Google OKF v0.2 knowledge bundle and configure its nightly wiki-dream schedule. Creates the wiki-llm concept tree, OKF index and log, WorkAgent3 profile contract, machine state, bounded AGENTS.md pointer, and Automation definition. Use for setup, migration, repair, or scheduling; not ingestion or queries.
---

# Wiki Setup

Install the project knowledge contract without overwriting owner content.

## Resolve roots

1. Resolve `PROJECT_ROOT` from the user's explicit target, otherwise the current
   project root.
2. Resolve `PLUGIN_ROOT` as the directory that owns `scripts/wiki_tool.py` and
   `assets/workspace`. In the plugin source tree, it is two directories above
   this Skill directory.
3. Read [workspace-contract.md](references/workspace-contract.md) completely.
4. Inspect `PROJECT_ROOT/AGENTS.md`, existing `wiki-llm/`, and
   `.agent-state/wiki-llm/` before proposing writes.

## Initialize or adopt

Run the deterministic preview first:

```text
python "<PLUGIN_ROOT>/scripts/wiki_tool.py" init --root "<PROJECT_ROOT>" --json
```

For a new workspace:

1. Review the planned paths.
2. Apply initialization:

   ```text
   python "<PLUGIN_ROOT>/scripts/wiki_tool.py" init --root "<PROJECT_ROOT>" --apply --json
   ```

3. Inspect the project and narrow `wiki-llm/config.json` source roots and
   exclusions. Do not select secret, credential, dependency, build, or machine
   state directories.
4. Keep `dream.model` fixed at `gpt-5.6-luna` and
   `dream.reasoning_effort` fixed at `xhigh`.
5. Set `dream.weekly_deep_day` to the user's requested weekday (`MON` through
   `SUN`); default to `SUN` when the user did not choose one.
6. Extend `wiki-llm/contract.md` only for real project-specific concept types,
   relations, or OKF extension fields. Preserve unknown extension fields. If
   the contract changes, stage its manifest hash/lifecycle record and dated log
   entry with it, snapshot existing targets, and validate the proposed and
   applied states using the wiki-edit commit gates.

The preview returns `workspace_state`. For
`legacy-migration-required`, stop before writes, inventory the existing bundle,
and present a lossless migration proposal. Map legacy `summary`, `lifecycle`,
`check_after`, and `source_ids` into OKF `description`, `status` plus
`knowledge_state`, `stale_after`, and `sources`. Apply migration only after the
user accepts its material choices; never report initialization as migration or
invent provenance.

## Validate the workspace

Run deterministic lint:

```text
python "<PLUGIN_ROOT>/scripts/wiki_tool.py" lint --root "<PROJECT_ROOT>" --json
```

Workspace initialization succeeds only when required JSON parses, exactly one
balanced AGENTS managed block exists, and fresh-workspace lint reports zero
errors and zero warnings.

## Configure scheduled dream

After the workspace passes validation, read
[cron-setup.md](references/cron-setup.md) completely and reconcile the scheduler
job owned by the current setup conversation. Every scheduled execution must
open a fresh conversation; the setup conversation is ownership metadata only.

Treat a request to set up the Wiki as authorization to create the default daily
schedule unless the user explicitly opts out. Use the user's requested run
time when supplied; otherwise default to `0 3 * * *` in the scheduler's local
timezone. The single daily task runs incremental Dream on ordinary days and a
full deep Dream on `dream.weekly_deep_day`.

Use only the WorkAgent3 Automation capability according to the reference. Bind
the definition to the current Workspace and a compatible existing Preset and
Engine. Never call a legacy desktop helper or an operating-system cron
command, and never replace an unrelated task without the user's direction.
Verify the persisted definition by reading it back after create or update.

Return these results separately:

- absolute `index.md` path, OKF profile, and configured source roots;
- scheduler state: `created`, `already-configured`, `updated`, `opted-out`, or
  `blocked`;
- human-readable daily schedule and weekly deep-run day when configured;
- scheduled Workspace, Preset, Engine, and notification policy;
- execution mode: a new independent conversation for every trigger.

## Guardrails

- Modify only `wiki-llm/`, `.agent-state/wiki-llm/`, and the marked AGENTS block.
- Preserve all AGENTS content outside managed markers byte-for-byte.
- Keep machine state outside the Wiki to prevent self-ingestion.
- Do not add MCP, ingest sources, or generate knowledge pages.
- Cron setup may modify only the current setup conversation's single scheduled
  task, whose runs must use `new_conversation` rather than append to setup or
  prior Dream conversations.
- Stop on unbalanced or duplicate managed markers.
