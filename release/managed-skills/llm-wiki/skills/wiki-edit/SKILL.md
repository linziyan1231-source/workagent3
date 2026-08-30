---
name: wiki-edit
description: "Apply an explicit user-authorized, recoverable mutation to an existing OKF v0.2 llm-wiki bundle: save, correct, merge, split, rename, archive, restore, or decide candidates. Use only for requested persistent knowledge changes; not queries, ingestion, unattended cleanup, or project-code edits."
---

# Wiki Edit

Make one explicit, recoverable knowledge mutation.

## Establish authority

1. Resolve `PROJECT_ROOT` from the explicit target, otherwise the current
   project root. Resolve `SKILL_DIR` as this Skill's directory; use it as
   `PLUGIN_ROOT` when it contains `scripts/wiki_tool.py`, otherwise walk upward
   to the nearest directory containing that script.
2. Require an existing workspace.
3. Read [mutation-contract.md](references/mutation-contract.md) completely.
4. Translate the user's request into exact Wiki targets and operation type.
5. If the request is only exploratory or advisory, use wiki-query instead.

This Skill may modify `wiki-llm/`, its machine state, and the bounded AGENTS
managed block. It must not modify project source files.

## Plan

Read exact targets, `index.md`, backlinks, source records, and affected manifest
entries. Record:

- current SHA-256 or `null` for every target;
- evidence and owner assertions;
- link, OKF status, knowledge-state, provenance, and freshness effects;
- proposed writes, moves, archive actions, and manifest changes.

For destructive, ambiguous, or broad changes, show a concise preview and obtain
confirmation. A direct unambiguous user instruction already authorizes the
bounded non-destructive edit.

## Apply

Create a run ID, acquire the project lease, and release it in a `finally` path:

```text
python "<PLUGIN_ROOT>/scripts/wiki_tool.py" lock acquire --root "<PROJECT_ROOT>" --run-id "<RUN_ID>" --json
```

While holding the lease:

1. Record expected hashes and run scoped pre-lint to identify relevant existing
   findings. Unrelated errors block the mutation; findings repaired by this
   operation are evaluated against the staged result.
2. Stage the complete project-relative result, including concepts, reciprocal
   links, `index.md`, `log.md`, and manifest. Run scoped overlay lint before any
   canonical write:

   ```text
   python "<PLUGIN_ROOT>/scripts/wiki_tool.py" lint --root "<PROJECT_ROOT>" --overlay-dir "<STAGED_ROOT>" --paths <TOUCHED_PATHS...> --json
   ```

3. Recheck every expected hash and abort on drift.
4. Snapshot existing and absent targets:

   ```text
   python "<PLUGIN_ROOT>/scripts/wiki_tool.py" snapshot --root "<PROJECT_ROOT>" --run-id "<RUN_ID>" --paths <TARGETS...> --json
   ```

5. Apply the staged set as one recoverable mutation.
6. Preserve superseded evidence and use archive/tombstones instead of silent
   deletion.
7. Run scoped post-lint:

   ```text
   python "<PLUGIN_ROOT>/scripts/wiki_tool.py" lint --root "<PROJECT_ROOT>" --paths <TOUCHED_PATHS...> --json
   ```

8. Mark the run complete and remove the temporary overlay only after post-lint
   succeeds. Restore preimages on failure when safe and leave an incomplete run
   record.

Always release the matching lease:

```text
python "<PLUGIN_ROOT>/scripts/wiki_tool.py" lock release --root "<PROJECT_ROOT>" --run-id "<RUN_ID>" --json
```

## Save results

When saving an accepted assistant result, label whether each durable statement
is source-backed, an explicit owner assertion, or synthesis. Do not fabricate a
source. Place unresolved assertions in a candidate or contested page.

## Guardrails

- Never treat a question as write authorization.
- Never modify immutable source packets.
- Never physically delete unique evidence or owner-authored content without
  explicit scope.
- Preserve unknown OKF extension fields. On a material rewrite, refresh
  `generated.at` and remove or supersede verification records no longer valid.
- Never leave index, log, backlinks, or manifest knowingly inconsistent.

