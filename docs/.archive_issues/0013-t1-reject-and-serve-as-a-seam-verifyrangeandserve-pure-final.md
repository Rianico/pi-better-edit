# T1 — Reject-and-serve as a seam: verifyRangeAndServe + pure finalizeToolResult + typed details + range geometry

> **Archived from pre-migration issue #13.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-08-12T09:29:00Z · state CLOSED · labels: ready-for-agent

## Body

## Parent

#12 — Architecture: reject-and-serve as a seam + per-domain store modules (spec)

## What to build

The "rejection feedback rows count as serves" rule becomes structural: one `verifyRangeAndServe` seam verifies the range and, on rejection, records the echo serves — with the record policy passed in (live edit records, preview does not; two real adapters). The post-edit diff serve-recording becomes a pure `finalizeToolResult(details)` returning `{ content, servedRows }`; the `tool_result` handler becomes a thin adapter and imports the typed `details` contract instead of re-declaring it with casts. `applyEdit`'s resolved range becomes one geometry value consumed by verification and drift. Observable behavior is byte-identical.

## Acceptance criteria

- [ ] `verifyRangeAndServe` exists: verifies the span; on rejection records the echo serves when the policy says so (live) and not when it does not (preview); returns `{ rejected, echoRows }`. No caller can forget to record the echoes.
- [ ] Live edit and preview are two explicit adapters over the seam (the `noPersist` policy is one parameter, not scattered `if` checks).
- [ ] `finalizeToolResult(details)` is pure and returns `{ content, servedRows }`; the `tool_result` handler calls it and records the served rows — no inline re-declaration of the details shape via casts.
- [ ] The `details` contract is defined once and imported by the handler; the undo tool builds its details through the same contract.
- [ ] The resolved range (start/end line, boundary hashes, delta) is one value from `applyEdit`, consumed by verification and drift; the ~10-field drift input shrinks accordingly.
- [ ] Full suite green (922 passed + 1 skipped) and `npm run eval:compare` reproduces local 19/19 / 2.4.1 14/19 / 2.5.0 18/19 — no observable-behavior change.
- [ ] Unit tests at the new seams (prior art: served-state / drift / edit-response tests).

## Blocked by

None — can start immediately.

## Comments

### @Rianico — 2026-08-12T10:01:12Z

Verified: typecheck + lint clean; full suite 929 passed + 1 skipped; eval:compare local 19/19 / 2.4.1 14/19 / 2.5.0 18/19 (identical char counts). Commit 582f173 on main. Note: the worker's initial post-apply verification order was corrected — the seam runs inside applyEdit (after autocorrection, before the would-empty check), preserving the E_RANGE_STALE-before-E_WOULD_EMPTY priority; a regression test covers it.
