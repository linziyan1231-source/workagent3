# Due-driven Dream contract

## Contents

1. Modes
2. Wake gate
3. Work set
4. Consolidation
5. Promotion
6. Retention
7. Completion

## Modes

All semantic work requires `gpt-5.6-luna` with reasoning effort `xhigh`, as
declared by the project Dream config. A known runtime mismatch fails before
source or page content is sent to a model.

Incremental mode is the normal daily path. Weekly deep mode runs when explicitly
requested or when the scheduler-local weekday equals the configured
`dream.weekly_deep_day`.

Scheduled runs use `execution_mode: new_conversation`. Each trigger reconstructs
its work set from durable project state and never relies on prior chat history.

Deep mode inventories every configured source, audits every non-archived page,
and checks the full relation/backlink graph. It is comprehensive inspection,
not a full rewrite: unchanged canonical files remain byte-identical.

## Wake gate

Cron is only a wake-up mechanism. Before any model call, compute:

```text
source delta
OR due stale_after
OR passed valid_until
OR due purge_after
OR structural issue or manifest drift
OR pending candidate
OR incomplete prior run
```

When all are empty in incremental mode, release the lock, report `NO_WORK`, and
exit with zero LLM tokens. A cleanup-only run over reproducible machine state
also needs no LLM.

Deep mode is due because of its schedule, so an empty incremental work set does
not skip its full audit. It may still avoid an LLM call when the Wiki contains
no auditable sources or pages.

## Work set

Bound the run to:

- new, changed, or missing sources;
- due pages;
- pending candidates;
- directly affected pages;
- one-hop relations and backlinks needed to preserve consistency.

Do not scan the entire Wiki during incremental Dream. Deep Dream deliberately
expands to all configured sources, non-archived pages, and the full relation
graph.

## Consolidation

1. Capture and compile source deltas using the ingestion contract.
2. Revalidate due pages against live sources.
3. Detect duplicates, contradictions, supersession, and missing relations in the
   bounded work set.
4. Preserve owner content and existing accepted entries unless evidence supports
   a specific replacement.
5. Stage all proposals before canonical writes.

Reuse the same evidence already loaded for consolidation as semantic lint input.
Do not resend the same pages to the model for a second full pass.

## Promotion

Auto-apply only configured low-risk actions, such as `index.md` rebuilds,
deterministic link repair, freshness transitions, generated archive moves, and
eligible ephemeral cleanup.

Create candidates for semantic merges, contradiction resolution, source
deletion consequences, owner-content rewrites, and meaningful AGENTS changes.

## Retention

- `stale_after` triggers review, not deletion.
- `valid_until` removes current-fact eligibility and usually transitions to
  expired or archive.
- `purge_after` allows physical deletion only when the item is generated,
  reproducible, explicitly purge-eligible, unreferenced, and outside hold.

Never auto-delete raw uploads, project files, primary evidence, decisions, or
owner-authored pages.

Dream preserves OKF v0.2 semantics: every Markdown concept retains `type`,
source provenance is expressed through `sources`, trust is derived from
`generated` and `verified`, and standard `status` is not overloaded with the
profile's operational `knowledge_state`. Preserve unknown extension fields.

## Completion

1. Candidate-lint the complete staged state, including manifest repairs.
2. Recheck base hashes and abort on concurrent drift.
3. Snapshot every target and apply one recoverable operation.
4. Post-lint the actual state.
5. Advance the watermark and recompute `next_due_at` only after success.
6. Preview and apply configured cleanup only to old completed run records,
   recoverable preimages, and lint reports. Never clean pending candidates.
7. Mark the run complete and release the lock in a finally path.

On failure, restore preimages when safe, keep the run visible, preserve old
watermarks, and release or expire the lease.

