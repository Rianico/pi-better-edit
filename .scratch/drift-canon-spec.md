# Drift canon fix (single-session false positives)

## Status

Proposed — from grill consensus (session 2026-09-04). Not yet implemented.

## Problem

Sequential `edit` calls to the same file in one session report each other's
own lines as `[USER] drift` with zero exterior writes. Evidence: session
`01a06bd2`, `L720(edit Sce:+30)` → `L724` bad-payload reject (no write) →
`L726` partial `read 1..18` → `L728(edit cmi:+2)` → `L729 drift: 20 lines`
listing the `L720` block itself (`Sce/Tdf/3EN/4FO…`).

Root causes (verified against code):

1. **Hash-equality drift on duplicates.** `mapStableHashes`
   (`src/hashline/hash-identity.ts`) re-probes identical `canon` lines
   (`});`, `it`, `expect`) under a monotonically grown `tombstone`
   (cleared only on full `read`; `L726` was partial). The recomputed
   survivor hashes at `L728` differ from the dense `recordDiff` hashes
   stored at `L720`. Set-based `collectDrifted*` (`src/drift.ts`) fires
   though content is byte-identical.
2. **Reject/partial bookkeeping.** Failed-edit `recordEcho(error.servedRows,
   live)` and partial-read `recordEpoch(merge)` + `snapshotId` advance
   mutate the mirror without a file change, widening the next drift window.
3. **`write` never serves.** `src/write-hook.ts` blocks echo only; `write`
   results are never dense-served, so a later `edit` to the same path sees
   true-content lines as drift. `bash` similarly bypasses serve (by design).

## Shared understanding (settled)

- `single session` = same `sessionKey` + canonical `absolutePath`.
  `bash`/`write` still count as drift sources unless they record serves.
- `edit` sees only its own increments; `write`/`bash`/post-load disk are
  invisible to `scanDrift` (frozen `served` vs in-memory `result`).
- Keep both mechanisms: verification gate blocks (model-facing `content`),
  drift notice informs (user-facing `details`, collapsed). Fix wolf-cries,
  don't delete the signal.

## Solution

1. **Canon-based drift.** `collectDrifted` / `collectDriftedIntervals`
   (`src/drift.ts`) fire only when the `canon` is gone from the result,
   not when the hash is gone. Keep hash rows for display/serve. Identical
   lines re-probed to fresh hashes are not drift.
2. **Reject records nothing.** Parse/verify rejects (`E_BAD_PAYLOAD`,
   `AnchorMismatchError`, `ServedRejectionError`) do not `recordEcho`.
   Partial `recordEpoch` merges hashes but leaves `snapshotId`,
   `tombstone`, and `reported` to full reads only. Dense `recordDiff`
   after a successful write clears displaced `tombstone` entries.
3. **Dense-serve `write`.** After a successful `write`, record dense serves
   for the new content (mirror of `pipeline.ts:apply`). `bash` stays
   drift-correct and documented (sniffing is unreliable).

Non-goals: `E_BOUNDARY_DUP` mode, `≥2` heuristics, `bash` output sniffing,
tag/release.

## Seams under test (tdd — confirmed)

- `computeDrift` / `scanDrift` (`src/drift.ts`) — behavior seam: drift
  fires on canon-gone, silent on hash-rotated identical lines.
- Session serve recording (`src/served-session/session.ts`) — reject
  records nothing; partial merge preserves epoch/tombstone/reported.
- `write` success path — dense serve recorded for later `edit` reads clean.

## Testing

- Repro: duplicate-heavy file, `edit(+30 at Sce)` → failed edit →
  partial `read 1..18` → `edit(+2 at cmi)`; expect zero drift (red first).
- `write`-then-`edit` same path: expect zero drift.
- True exterior change (disk write between load and edit, outside `I`):
  drift still fires with `canon`-gone rows.
- `npm run typecheck && npm run lint && npm test` green; `git diff --check` clean.

## Docs

- `CONTEXT.md:drift/drift notice` → canon wording inline.
- One ADR: blocking-vs-informative split (hard-to-reverse + surprising +
  real tradeoff).

## References

- `CONTEXT.md` — `drift`, `drift notice`, `tombstone`, `served state`.
- `src/drift.ts`, `src/served-session/session.ts`,
  `src/hashline/hash-identity.ts`, `src/mutation-engine/pipeline.ts`,
  `src/write-hook.ts`, `src/edit-response.ts` (`finalizeResult` excludes
  drift from model `content` by design).
