---
type: Knowledge Contract
title: LLM Wiki Contract
description: Project-local rules for this OKF v0.2 knowledge bundle.
status: stable
knowledge_state: active
generated:
  by: process:wiki-setup
  at: "{{GENERATED_AT}}T00:00:00Z"
verified: []
stale_after: null
valid_until: null
purge_after: null
sources: []
tags:
  - okf
  - contract
---

# Scope

This directory is an Open Knowledge Format (OKF) v0.2 bundle. Owner-authored
additions may tighten this contract. Skills must preserve them.

# Layout

- `index.md` is the progressive-disclosure map.
- `log.md` records chronological bundle updates, newest first.
- `references/sources/` holds immutable source concepts and attachments.
- `topics/`, `decisions/`, `entities/`, `procedures/`, and `syntheses/` hold
  durable concepts.
- `archive/` preserves inactive generated concepts.
- Machine state lives outside the bundle under `.agent-state/wiki-llm/`.

# Concept frontmatter

Every non-reserved Markdown document is one concept and must include:

```yaml
---
type: Decision
title: Example
description: One sentence suitable for index.md.
status: stable
knowledge_state: active
generated:
  by: wiki-ingest/gpt-5.6-luna
  at: "2026-08-10T00:00:00Z"
verified: []
stale_after: 2027-02-06
valid_until: null
purge_after: null
sources:
  - id: SRC-20260810-example
    resource: /references/sources/SRC-20260810-example/source.md
relations:
  - type: depends_on
    target: /decisions/example.md
---
```

`type` is the only field required by base OKF. This managed profile also
requires `title`, `description`, `status`, `knowledge_state`, `generated`,
`stale_after`, `valid_until`, `purge_after`, and `sources` so unattended Dream
maintenance remains deterministic. Preserve unknown producer extensions.

This profile intentionally uses a small canonical YAML subset so every runtime
parses it identically without a YAML dependency: root keys have no indentation;
mapping and list children use exactly two spaces; fields in a list item mapping
use exactly four spaces; empty values are written as `null` or `[]`. Do not use
flow mappings, block scalars, anchors, aliases, tags, tabs, or nested containers.
Put multiline prose in the Markdown body. Unsupported YAML fails lint instead
of being guessed.

# Trust and provenance

- Use `sources` for provenance; each entry requires `resource` and should use a
  stable `id` when body claims cite it with a matching Markdown footnote.
- Use `generated` for the producer and last meaningful content change.
- Use `verified` only after checking content against its sources or resource.
- Derive trust as unverified, machine-confirmed, or human-reviewed; never store
  a subjective trust score.
- Use actor IDs `<producer>/<version>`, `human:<id>`, or `process:<id>`.

# Lifecycle and retention

- OKF `status` is `draft`, `stable`, or `deprecated`.
- `knowledge_state` is `active`, `review_due`, `contested`, `expired`,
  `superseded`, or `archived`.
- `stale_after` is the soft review deadline.
- `valid_until` is the hard semantic deadline; after it, exclude the concept
  from current-fact answers until revalidated.
- `purge_after` is allowed only for generated, reproducible, explicitly
  purge-eligible material.

Raw uploads, project files, primary evidence, decisions, and owner-authored
concepts must never receive an automatic purge deadline.

# Links and relations

Use standard Markdown links. Prefer bundle-absolute links such as
`/decisions/example.md`; ordinary relative links are also valid. Surrounding
prose carries relationship meaning. The `relations` extension may additionally
use `depends_on`, `supports`, `implements`, `derived_from`, `related_to`,
`contradicts`, `supersedes`, or `superseded_by`.

Broken links are warnings, not OKF conformance failures. Preserve unknown types,
fields, and relation kinds when round-tripping.

# Writes

- One logical operation produces one recoverable mutation.
- Record expected SHA-256 values before applying writes.
- Snapshot changed canonical files under `.agent-state/wiki-llm/preimages/`.
- Update `index.md`, `log.md`, backlinks, and manifest together.
- Advance a Dream watermark only after post-write validation succeeds.

