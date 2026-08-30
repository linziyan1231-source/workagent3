---
name: wiki-dream
description: "Run one explicit or cron-triggered GPT-5.6 Luna xhigh maintenance cycle for an OKF v0.2 llm-wiki bundle: incremental source/staleness work daily or a configured weekly deep audit. Revalidates provenance, concepts, links, conflicts, expiry, and maps; incremental mode uses no LLM when nothing is due and deep mode never rewrites unchanged content."
---

# Wiki Dream

Dream is incremental by default, with one deliberately configured weekly deep
run. Neither mode is authority for indiscriminate rewriting or deletion.
For cron invocations, each run starts in a newly created conversation with no
prior chat history; reconstruct all required state from the project Wiki,
manifest, config, and source records.

## Load contracts

1. Resolve `PROJECT_ROOT` from the explicit target, otherwise the current
   project root. Resolve `SKILL_DIR` as this Skill's directory. If it contains
   `scripts/wiki_tool.py`, set `PLUGIN_ROOT=SKILL_DIR` and
   `SKILLS_ROOT=SKILL_DIR.parent`; otherwise walk upward to the nearest plugin
   directory containing that script and set `SKILLS_ROOT=PLUGIN_ROOT/skills`.
2. Read [dream-contract.md](references/dream-contract.md) completely.
3. Read exactly
   `SKILLS_ROOT/wiki-ingest/references/ingestion-contract.md` and
   `SKILLS_ROOT/wiki-lint/references/lint-contract.md` before source or lint
   work. Stop if either sibling contract is unavailable.
4. Require an initialized workspace.

## Resolve mode

Read the `dream` object in `wiki-llm/config.json`. Require:

- `model`: `gpt-5.6-luna`
- `reasoning_effort`: `xhigh`

When runtime identity is exposed, verify both values before semantic work. Stop
with `MODEL_MISMATCH` on a known mismatch. When runtime identity is not exposed,
proceed only for a scheduled conversation whose setup confirmed this binding;
otherwise stop rather than silently use another model.

Read `dream.weekly_deep_day`. Use `SUN` as a compatibility fallback when the
field is absent and report that setup should persist it.

- Use `incremental` unless the invocation explicitly requests deep mode or the
  scheduler-local weekday matches the configured weekly day.
- Accept only `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, or `SUN`.
- Report the selected mode in the run result.

## Acquire and gate

Create a run ID and acquire a lease:

```text
python "<PLUGIN_ROOT>/scripts/wiki_tool.py" lock acquire --root "<PROJECT_ROOT>" --run-id "<RUN_ID>" --json
```

Then compute the zero-Token work set:

```text
python "<PLUGIN_ROOT>/scripts/wiki_tool.py" status --root "<PROJECT_ROOT>" --json
```

In incremental mode, if there are no new, changed, or missing sources; no due
`stale_after`, `valid_until`, or `purge_after`; no structural or manifest drift;
no candidates; and no incomplete run, report `NO_WORK` and release the lease
without an LLM call.

In deep mode, do not use an empty incremental status as the exit gate. Build a
full audit work set from every configured source record, every non-archived
knowledge page, and their relation/backlink graph. If all of those sets are
empty, finish without an LLM call.

If the only work is manifest-cache repair, safe formatting repair, eligible
machine-state cleanup, or reproducible ephemeral cleanup, perform it
deterministically without an LLM.

## Maintain

For a nonempty incremental work set:

1. Inspect deterministic status and lint findings. Repair manifest/hash/deadline
   cache drift in the staged result before treating those same findings as a
   blocker; unrelated structural errors still block writes.
2. Ingest only source deltas.
3. Revalidate only due pages against live sources.
4. Expand to directly affected pages and required one-hop relations.
5. Reuse loaded evidence to detect duplicates, contradictions, supersession, and
   missing high-value relations.
6. Record expected hashes and stage one complete bounded operation, including
   index, log, and manifest. Auto-apply only actions allowed by project config;
   write candidates for semantic or destructive decisions.
7. Validate staged pages with a scoped overlay lint:

   ```text
   python "<PLUGIN_ROOT>/scripts/wiki_tool.py" lint --root "<PROJECT_ROOT>" --overlay-dir "<STAGED_ROOT>" --paths <TOUCHED_PATHS...> --json
   ```

8. Recheck expected hashes, snapshot all targets, and apply the staged set.
9. Run scoped post-lint against actual files. On failure, restore safely and
   preserve an incomplete run.
10. Advance watermark and recompute `next_due_at` only after success.
11. Preview and then perform final eligible machine-state cleanup:

   ```text
   python "<PLUGIN_ROOT>/scripts/wiki_tool.py" cleanup-state --root "<PROJECT_ROOT>" --json
   python "<PLUGIN_ROOT>/scripts/wiki_tool.py" cleanup-state --root "<PROJECT_ROOT>" --apply --json
   ```

Update `wiki-llm/index.md` and append `log.md` whenever the bundle materially
changes. Modify AGENTS only
inside its managed block and only for a stable map/contract change; ordinary
knowledge changes belong in the OKF bundle map.

## Weekly deep maintenance

For a deep run:

1. Re-inventory every configured source and verify its current hash, presence,
   provenance record, and page coverage.
2. Review every non-archived compiled page for evidence support, OKF provenance,
   status, knowledge state, freshness, duplication,
   contradiction, and supersession.
3. Traverse the complete relation and backlink graph to find missing,
   dangling, asymmetric, or obsolete relationships.
4. Rebuild derived navigation and run a full deterministic lint.
5. Reuse the loaded evidence for semantic consolidation; do not make a second
   full-model lint pass over the same corpus.
6. Stage and apply only actual deltas under the same candidate, snapshot,
   base-hash, retention, and post-lint rules as incremental mode.

Do not update page timestamps, descriptions, or prose merely because a deep run
occurred. A clean weekly audit may complete with zero canonical writes.

## Always release

Release the matching lease in a finally path:

```text
python "<PLUGIN_ROOT>/scripts/wiki_tool.py" lock release --root "<PROJECT_ROOT>" --run-id "<RUN_ID>" --json
```

On failure, preserve preimages, candidates, the old watermark, and an incomplete
run record.

## Guardrails

- Do not run a full semantic scan outside deep mode.
- Do not depend on setup-chat or previous-run conversation history.
- Do not perform semantic Dream work with a known runtime other than
  `gpt-5.6-luna` at `xhigh` reasoning.
- Do not send the same work set through separate full Dream and semantic-lint
  model calls.
- Never auto-delete raw uploads, project files, primary evidence, decisions, or
  owner-authored pages.
- Treat `stale_after` as review, `valid_until` as current-fact exclusion, and
  `purge_after` as narrowly scoped physical-retention authority.

