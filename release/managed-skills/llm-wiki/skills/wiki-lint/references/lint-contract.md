# OKF v0.2 lint contract

## Contents

1. Read-only boundary
2. Deterministic checks
3. Semantic checks
4. Findings
5. Dream integration

## Read-only boundary

Lint never repairs canonical Wiki files. It may print a report or, only when
explicitly requested, save a derived report under
`.agent-state/wiki-llm/lint/`. Route repairs to wiki-edit or wiki-dream.

## Deterministic checks

Check without an LLM:

- root `index.md` with `okf_version: "0.2"`, dated `log.md`, profile contract,
  and JSON schemas;
- balanced AGENTS managed markers;
- every non-reserved Markdown concept has nonempty `type` plus profile-required
  `title`, `description`, `status`, `knowledge_state`, `generated`,
  `stale_after`, `valid_until`, `purge_after`, and `sources`;
- standard `status` is draft, stable, or deprecated; dates and actors are valid;
- Frontmatter uses the profile's canonical YAML subset; unsupported mappings,
  indentation, containers, block scalars, aliases, tags, or duplicate keys fail
  closed instead of being partially interpreted;
- broken relative or bundle-absolute Markdown links, reported as warnings because
  OKF tolerates incomplete bundles;
- links from Wiki pages into machine state;
- `sources` entries missing `resource`, unresolved source IDs, and manifest
  drift, including missing current-page records, content hashes, and deadline
  cache values that differ from canonical Frontmatter;
- current pages missing from `index.md`;
- duplicate source locators or hashes;
- stale source hashes;
- status, knowledge-state, and deadline mismatches;
- illegal purge deadlines on non-ephemeral evidence;
- archive pages incorrectly marked active.

For `type: Attested Computation`, also validate `runtime`, `parameters`,
`computation`, `executor`, and `attester` when this optional OKF type is used.
Unknown extension fields are valid and must not be stripped. Trust is derived
from `generated` and `verified`, so a stored trust score is informational at
best and must never be treated as authoritative.

## Semantic checks

Run only when requested or when Dream has a bounded affected set:

- likely duplicate concepts;
- material contradictions;
- unsupported or misquoted claims;
- term drift;
- missing high-value relations;
- pages that should split or consolidate.

Semantic checks produce findings, never canonical writes.

## Findings

Every finding has:

```json
{
  "severity": "error|warning|info",
  "code": "STABLE_MACHINE_CODE",
  "path": "wiki-relative/path.md",
  "message": "human-readable explanation",
  "evidence": [],
  "suggested_action": "optional bounded action"
}
```

Errors block ingest/edit/dream commits. Warnings require explicit handling but
do not always block. Information is advisory.

## Dream integration

Dream reuses deterministic lint as three narrow, zero-LLM gates:

- preflight over current structural state;
- candidate lint over touched files and their affected links;
- postflight smoke validation after apply.

These are not three full semantic model passes.


