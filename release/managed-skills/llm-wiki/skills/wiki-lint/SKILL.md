---
name: wiki-lint
description: Run a read-only audit of an OKF v0.2 llm-wiki bundle for conformance, profile fields, links, map/log, manifest, provenance, trust actors, freshness, status, retention, and bounded semantic issues. Use for lint, health checks, broken links, stale knowledge, or change validation. Reports findings and never repairs canonical files.
---

# Wiki Lint

Diagnose; do not repair.

## Deterministic audit

1. Resolve `PROJECT_ROOT` from the explicit target, otherwise the current
   project root. Resolve `SKILL_DIR` as this Skill's directory; use it as
   `PLUGIN_ROOT` when it contains `scripts/wiki_tool.py`, otherwise walk upward
   to the nearest directory containing that script.
2. Read [lint-contract.md](references/lint-contract.md) completely.
3. Run:

   ```text
   python "<PLUGIN_ROOT>/scripts/wiki_tool.py" lint --root "<PROJECT_ROOT>" --json
   ```

4. For an ingest, edit, or Dream candidate gate, pass the bounded touched paths
   and `--overlay-dir <STAGED_ROOT>` so validation sees the proposed files and
   manifest before canonical writes.
5. Treat a nonzero lint exit as findings, not as permission to repair.

Report findings by severity, stable code, path, evidence, and bounded suggested
action.

## Optional semantic audit

Run semantic checks only when the user requests them or a bounded Dream work set
requires them:

1. Start from deterministic findings and `index.md` descriptions.
2. Select only likely duplicate, contested, stale, or weakly linked pages.
3. Read their exact sources.
4. Report possible duplication, contradiction, unsupported claims, term drift,
   or missing relations.

Do not scan the entire Wiki with an LLM during routine lint. Do not write
candidates unless the caller is wiki-dream or the user explicitly asks to save
the report.

## Hard rules

- Do not change canonical files, AGENTS, manifest, status, links, or indexes.
- A saved report may go only under `.agent-state/wiki-llm/lint/`.
- Route user-approved repairs to wiki-edit.
- Dream may consume findings, but lint must never invoke Dream.


