# fix(lease-resolve): spec-exact fast path and the E_STALE_ANCHOR range echo

> **Archived from pre-migration issue #106.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T16:13:51Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

Two spec deviations in `src/hashline/lease-resolve.ts`.

## 1. `E_STALE_ANCHOR` must echo the current range (spec line 637)
Spec section 5.3 table: "Anchor not present in `served_leases` | `resolve.ts` (`valEdit`) | `[MODEL] [E_STALE_ANCHOR]` | **Echoes current range**; model retries". The rejection contract is *reject-and-serve*: the echoed `HASH|content` rows are themselves serves, so the retry needs no `read`.

Today (`src/hashline/lease-resolve.ts` L90-118) the unleased-anchor failure routes through `throwStaleAnchor` / `fmtMismatchWithServes`, which emits `Current context around resolved anchor "<hash>" (line N)` - a narrow context window, not the current range.

**Remedy**: the unleased-anchor rejection emits the full `Current range:` echo contract used by the other `reject-and-serve` rejections, so the model receives the current rows for the range it targeted and can retry immediately.

## 2. Fast-path qualification has non-spec clauses (spec line 632)
Spec line 632 qualifies the `O(1)` fast path **iff**:

```
lease_from.served_snapshot_hash == C  AND  lease_to.served_snapshot_hash == C
AND lease_from.served_snapshot_hash == lease_to.served_snapshot_hash
```

`src/hashline/lease-resolve.ts` L186-190 adds two extra conditions:

```ts
if (fromLine === fromContent && toLine === toContent && isUniformLeaseFastPath(...))
```

`fromLine === fromContent` / `toLine === toContent` are not part of the spec's qualification. They are defensive-only (implied whenever the served snapshot equals the current content and the anchors are unique per file), and they silently route spec-qualifying edits off the fast path.

**Remedy**: qualify strictly on the spec's three equalities. Keep a test proving a uniform-snapshot lease takes the `O(1)` path, and that fail-closed behaviour is untouched.

## Acceptance criteria
- An unleased anchor rejects with `[MODEL] [E_STALE_ANCHOR]` **and** a full `Current range:` echo of the current rows for the targeted range.
- Fast-path qualification is exactly `isUniformLeaseFastPath(...)`; the `=== content` clauses are gone and a uniform-snapshot lease demonstrably resolves through the fast path.
- The three error codes stay correctly attributed: unleased boundary anchor -> `E_STALE_ANCHOR`, never-served interior -> `E_UNSERVED_RANGE`, retired/deleted leased line or torn span -> `E_STALE_RANGE`.
- `E_SERVED_ECHO`, `E_REVERSED_ANCHORS` and `E_BAD_ANCHOR` behaviour unchanged, and all 15 Stage-0 probes stay green - including the four fail-closed probes with byte-identical file assertions and the auto-rebase probes B/C/D.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:21Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
