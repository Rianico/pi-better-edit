# ADR-0016 — Content-addressed line identity supersedes heuristic canon healing

Date: 2026-09-12

## Status

accepted; amended by ADR-0018 (recovery clause); supersedes [ADR-0008](0008-orphaned-serve-healing.md) (orphaned serves: eager heal and content-disambiguated verification) in full, including its `ServedVerification` deepening amendment.

## Context

ADR-0008 kept an unresolvable anchor usable: `patchServed` nulled the stale slot eagerly and `verifyServedRange` enumerated content-matching candidate spans, so an external shift silently relocated the model's anchor to whatever line currently carried the same content. That is exactly the upstream P0: after `f1` was deleted from `small.cpp`, the surviving `f2` guard received the freed three-character anchor, and an edit addressed to the deleted `f1` line was healed onto `f2` — a silent miswrite into code the model never read. Content equality cannot disambiguate two byte-identical lines, and no scan over the current file can tell "the line moved" from "a twin now owns the anchor".

## Decision

Line identity is content-addressed and leased, never guessed. Each materialized snapshot writes `line_lineage(snapshot_id, line_number) -> line_id` inside `BEGIN IMMEDIATE`; every serve path grants a `served_leases` row binding `(session_id, file_path, anchor)` to an immutable `line_id` for the snapshot that was actually served. An edit is resolved strictly read-only: the leased `line_id` is looked up in `line_lineage(C)` and either rebases to its new coordinate or fails closed. `tryHealOrphanedSpan` and `src/hashline/healing/*` are deleted, not adapted; a boundary anchor (`anchor_from`/`anchor_to`) with no lease rejects with `[MODEL] [E_STALE_ANCHOR]`; an unread interior line strictly between the anchors rejects with `[MODEL] [E_UNSERVED_RANGE]` at the `served-verification.ts` seam; and a retired or deleted `line_id`, a torn span or a contested reorder rejects with `[MODEL] [E_STALE_RANGE]`. `serve` remains the only operation that may present an anchor for a coordinate, and it does so through the atomic lease upsert.

## Considered Options

- **Keep ADR-0008 healing behind a strictness flag** — rejected: a flag would leave the P0 reachable by default, and the healing code is the only reason a freed anchor could rebind to a twin.
- **Disambiguate duplicates by nearest coordinate** — rejected: "nearest" is a guess, and the miswrite in Probe `E` is exactly a nearest-coordinate case.
- **Keep content equality as a fallback when the lease is missing** — rejected: it re-opens the same silent rebind; the fail-closed path plus `reject-and-serve` costs one serve turn, not a corruption.

## Consequences

- `CONTEXT.md`: `orphaned serve`, `orphaning re-serve` and `relocated line keeps its hash` describe a state the tool now rejects rather than repairs; coordinate realignment is owned solely by `pairSnapshots` + `line_lineage`.
- `test/hashline/healing.test.ts` and `test/hashline/healing-policy.test.ts` are deleted; `test/core/served-verification.test.ts` asserts the fail-closed `E_UNSERVED_RANGE` result for un-rebased coordinates, and the auto-rebase path is asserted end-to-end in `test/integration/p0-drift-line-identity.test.ts`.
- A retired anchor is recoverable only by a re-read, which is the intended context cost of never miswriting.
