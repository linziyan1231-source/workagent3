# OKF v0.2 workspace setup contract

## Contents

1. Scope and ownership
2. Initialization
3. Adoption
4. AGENTS integration
5. Configuration
6. Completion gates

## Scope and ownership

Create a project-local Google Open Knowledge Format (OKF) v0.2 bundle in
`wiki-llm/` and a separate
`.agent-state/wiki-llm/` machine-state directory. Never place locks, run
reports, candidates, or preimages inside the readable Wiki.

Resolve every target relative to the selected project root. Reject absolute,
parent-traversing, cross-profile, and reparse-point escape targets.

## Initialization

Use the plugin's workspace assets as defaults. The root `index.md` declares
`okf_version: "0.2"`; `log.md` records dated bundle changes; `contract.md` is
itself an OKF concept describing the WorkAgent profile. Customize `config.json`
source roots and contract owner rules only after inspecting the project. Create only
the category directories the project can plausibly use; the standard set is
small enough for an initial project.

Initialize manifest state as a rebuildable cache. Seed `contract.md` with its
actual content hash and canonical lifecycle fields so a fresh workspace has no
manifest or map warning:

```json
{
  "schema": "llm-wiki.manifest.v1",
  "generated_at": "<ISO-UTC>",
  "next_due_at": null,
  "sources": {},
  "pages": {
    "contract.md": {
      "sha256": "<SHA-256>",
      "type": "Knowledge Contract",
      "status": "stable",
      "knowledge_state": "active",
      "stale_after": null,
      "valid_until": null,
      "purge_after": null,
      "purge_eligible": false
    }
  },
  "pending": []
}
```

## Adoption

Setup first classifies the workspace as `new`, `current-okf`, or
`legacy-migration-required`. If unrecognized Wiki content, legacy config, prior
machine state, or a managed AGENTS block exists without the current config,
preview and apply must both return migration-required without writing. Then:

1. Inventory existing Markdown and source material.
2. Preserve every owner-authored file.
3. Add missing profile fields through an explicit migration plan.
4. Build a manifest from evidence; do not invent original source hashes.
5. Insert the AGENTS managed block only when its markers are absent.

For a legacy workspace, propose these lossless mappings: `INDEX.md` to
`index.md`; `SCHEMA.md` to `contract.md`; `summary` to `description`;
`check_after` to `stale_after`; `source_ids` to OKF `sources` entries; and
`lifecycle` to the standard `status` plus the extension `knowledge_state`.
Preserve timestamps and unknown fields as extensions. Never overwrite an
existing map, contract, config, or manifest during adoption.

## AGENTS integration

Insert one bounded managed block that points to `wiki-llm/index.md`. Do not copy
the complete file map into AGENTS. Preserve all text outside the markers
byte-for-byte.

Treat zero, one, and multiple marker pairs distinctly:

- zero: propose one insertion;
- one balanced pair: preserve or update only its interior;
- multiple or unbalanced markers: stop and report corruption.

## Configuration

Choose narrow source roots. Do not default to scanning the whole repository when
documentation roots are available. Exclude the Wiki, machine state, dependencies,
build output, secrets, credentials, and version-control internals.

Store the weekly comprehensive maintenance day in
`dream.weekly_deep_day` using `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, or
`SUN`. Default new workspaces to `SUN`. The daily cron message reads this field;
do not create a second weekly task.

Keep the Dream execution contract fixed at:

```json
{
  "model": "gpt-5.6-luna",
  "reasoning_effort": "xhigh"
}
```

These fields belong under `dream`. Treat a different or missing value as an
invalid setup, not as permission to silently fall back to another model.

Every non-reserved Markdown file represents one concept. It must have YAML
frontmatter with `type`; this profile additionally requires `title`,
`description`, `status`, `knowledge_state`, `generated`, `stale_after`,
`valid_until`, `purge_after`, and `sources`. Use standard `status` values
`draft`, `stable`, or `deprecated`. Never store a derived trust score: derive
trust from `generated` and `verified` actors.

Use the canonical YAML subset defined in `contract.md`: root keys at column
zero, exactly two spaces for list or mapping children, exactly four spaces for
fields within list-item mappings, and explicit `null` or `[]` empties. Flow
mappings, block scalars, anchors, aliases, tags, tabs, and deeper nesting are
unsupported and must fail closed rather than be guessed.

Configure positive machine-state retention windows under `state_retention`.
They apply only to completed run records, recoverable preimages, and lint
reports; never to pending candidates or knowledge/source content.

Use bundle-absolute Markdown links such as `/topics/auth.md` for stable internal
navigation. Relative links remain valid. Broken links are lint warnings under
OKF, not conformance errors.

The retention profile is a default, not authority to delete. Only explicit
ephemeral generated artifacts may have `purge_after`.

## Completion gates

Setup is complete only when:

- required directories and files exist;
- JSON config and manifest parse;
- exactly one balanced AGENTS managed block exists;
- deterministic lint reports no error;
- a newly initialized workspace has no lint warning;
- the user receives the project-relative `index.md` path and OKF version.

