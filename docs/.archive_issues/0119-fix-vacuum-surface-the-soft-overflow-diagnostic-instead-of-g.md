# fix(vacuum): surface the soft-overflow diagnostic instead of growing silently

> **Archived from pre-migration issue #119.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T02:38:51Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78. Review 5, spec finding (a) — the second half: the soft-overflow state is computed but never surfaced.

## Finding (verified on `39f1076`)

`src/snapshot-store/vacuum.ts:183` computes

```ts
overSoftOverflow: deferredBytes > VACUUM_SOFT_OVERFLOW_BYTES - VACUUM_GLOBAL_BUDGET_BYTES,
```

and the module comment at `:13` explains the design: a soft overflow is permitted because it *"in practice lapses with the 7-day lease TTL"*. But the flag is consumed **only by tests** (`test/core/snapshot-vacuum.test.ts:327,345,358`) — nothing in production reads it, so a store that cannot converge grows without saying anything.

That contradicts the recorded decision. ADR-0017, Consequences:

> *"Eviction is observable: `VacuumResult` reports `totalBytes`, `pinnedBytes`, `deferredBytes` and `overSoftOverflow`, so a store that cannot converge (all pins) says so instead of silently growing."*

and ADR-0017, Decision:

> *"When every remaining candidate is pinned the vacuum defers and the store soft-overflows instead; that deferred state is reported (and is expected to lapse as leases expire) rather than resolved by evicting a pin."*

## Remedy

Make the deferred state observable at the vacuum pass's invocation boundary (the store module that owns the call — `src/snapshot-store/index.ts`), by emitting one operator-visible diagnostic line when a pass reports `overSoftOverflow` (or equivalently `deferredBytes > 0`), carrying the useful numbers (`totalBytes`, `pinnedBytes`, `deferredBytes`).

Constraints:
- **Never fail the caller.** ADR-0017: the pass's failure is caught so *"retention can never fail a read or edit that already committed"*. The diagnostic must not throw, change a tool result, or alter control flow.
- **No spam.** A pass runs after every authoritative materialization, so a naive log fires on every read and edit. Throttle it — at most once per store instance, or only on the transition into the over-soft-overflow state — and document the chosen rule in the code comment.
- **No forced eviction.** Pinned snapshots stay pinned (spec L318; ADR-0017 rejects a hard cap that evicts pins). This ticket changes observability only.

## Acceptance criteria

- When `overSoftOverflow` holds, an operator-visible warning is emitted with the byte counts; when it does not hold, nothing is emitted (test both).
- Repeated over-soft-overflow passes emit the diagnostic **once** under the chosen throttle (test) — not once per pass.
- Tool behaviour is unchanged: no thrown error, no altered result, no forced eviction; the existing vacuum tests keep their assertions (`overSoftOverflow` true/false cases included) and all 15 Stage-0 probes stay green.
- The pinning invariants are untouched: a pinned snapshot is never evicted in any path.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:41:06Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
