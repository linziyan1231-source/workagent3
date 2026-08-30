# Explicit OKF mutation contract

## Contents

1. Authority
2. Operation plan
3. Mutation types
4. Deletion and archive
5. Commit gates

## Authority

Edit only after an explicit user request to save, correct, merge, split, rename,
archive, restore, approve, reject, or otherwise modify Wiki knowledge. A
question, suggestion, or speculative statement is not write authority.

Confine canonical writes to `wiki-llm/` and the bounded AGENTS managed block.
Never edit project source files through this Skill.

## Operation plan

Build one logical plan containing:

- operation ID and type;
- current target hashes or `null` for creates;
- affected backlinks, `index.md`, and `log.md` entries;
- source evidence;
- proposed writes, moves, archive actions, and manifest changes;
- destructive or ambiguous decisions requiring confirmation.

Snapshot every existing canonical target before apply.

## Mutation types

- Save an accepted conversation result as a sourced synthesis or owner assertion.
- Correct a claim while preserving the old evidence and reason.
- Merge duplicates while retargeting links and keeping an archive tombstone.
- Split an overloaded page and update inbound links.
- Rename a page with link repair and redirect/tombstone when useful.
- Approve or reject a staged candidate.
- Restore archived knowledge without silently making it current.

## Deletion and archive

Prefer `status: deprecated` or a `knowledge_state` transition and archive over physical deletion. Never delete raw
uploads, unique evidence, owner-authored pages, or project files automatically.
Physical deletion requires explicit user scope and a preimage.

## Commit gates

1. Acquire the project lease and record expected target hashes.
2. Stage the entire proposed state, including `index.md`, `log.md`, backlinks,
   and manifest, then run scoped overlay lint.
3. Recheck expected hashes and abort on concurrent drift.
4. Snapshot every target, including absent targets for creates.
5. Apply one recoverable operation and run scoped post-lint.
6. Mark the run complete only after validation; on failure, restore safely and
   leave the operation visibly incomplete.
7. Release the lease in a finally path.

Preserve fields not owned by this profile. Material content changes must update
`generated.at`; retain `generated.by` only if it remains truthful. Remove or
supersede stale `verified` entries unless the edit is reverified by that actor.
Never fabricate `sources`, verification, or attestation.

