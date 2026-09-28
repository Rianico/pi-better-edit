# fix(batch): retire legacy tombstones after writeAtomic, not mid-batch

> **Archived from pre-migration issue #117.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-15T02:38:47Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78. Review 5, spec finding (b): mid-batch legacy tombstone mutation.

## Finding (verified on `39f1076`)

`src/mutation-engine/pipeline.ts:838-841`, inside the per-item loop of `runMutations`:

```ts
if (!isPreview) {
  try {
    const handle = createSessionHandle(sessionKey, absolutePath, hashStore);
    await handle.retire(outcome.removedHashes);
  } catch {}
}
```

Two defects:

1. **A store write mid-batch, before `writeAtomic`.** The hashes removed by item *k* are tombstoned while later items are still unapplied, so a batch that fails on item *k+1* leaves those hashes retired with no corresponding file change. Spec §3.2.4 step 4 (line 182): *"`served_leases` is NOT mutated mid-batch. Upon batch completion, the in-memory working buffer commits to disk, and $S_{final}$'s persistence executes inside a SQLite transaction"*.
2. **An empty `catch {}`** — a documented-standards violation in its own right (every catch must propagate, return a typed error, or log with context).

**Provenance — not scope creep:** `git log -S'handle.retire(outcome.removedHashes)'` points at `6cbf5da` (*feat: consolidate architecture deepening — 6 deep modules (#64)*), i.e. this predates the MVCC work. The review's "unasked behaviour" label is inaccurate, but the defects are real.

**Scope note:** `retireAnchorsInner` → `addRetiredAnchors` writes the **legacy v6 `served.retired` mirror** (`UPDATE served SET retired = …`), *not* `served_leases`. The authoritative retirement already happens in the $S_{final}$ transaction (`pipeline.ts:1049-1070`, `{ retireLeases: true }`). ADR-0017: *"ADR-0013's `served.snapshotId` / `served.retired` columns survive only as v6 compatibility shells."*

## Remedy

- Accumulate the removed hashes across the batch and apply the legacy retire **once, after `writeAtomic` succeeds** (batch completion, alongside the $S_{final}$ materialization), so a failed batch tombstone nothing.
- Delete the empty `catch {}`. A failure in the legacy mirror write must be reported with context (consistent with the existing best-effort store diagnostics, e.g. via `console.error` plus `DEFERRED_STORE_SYNC_WARNING`), never silently swallowed.
- Do not disturb the authoritative path: retirement of `served_leases` stays in the $S_{final}$ transaction, and §3.6.2 post-write semantics stay as they are.

**Investigation duty (report, don't guess):** confirm whether anything reads the legacy `served.retired` set *between* items of one batch (the `loadServed` / tombstone consumers in `src/served-session/`). If a test or code path depends on mid-batch tombstoning to resolve later items correctly, **stop and return BLOCKED with that evidence** — never weaken a test to make the move pass.

## Acceptance criteria

- No store mutation occurs before `writeAtomic` anywhere in the batch loop; the legacy retire is applied once, after the bytes are on disk.
- A batch that fails mid-way leaves the legacy tombstone set exactly as it was (test).
- A successful batch still applies the legacy retire (test) — behaviour preserved for v6-compat consumers.
- No empty `catch {}` remains in the changed region (`rg -n 'catch\s*\{\s*\}' src/` clean).
- The existing batch tests (`test/integration/batch-wal-commit.test.ts`, `batch-error-propagation.test.ts`) and all 15 Stage-0 probes stay green with their assertions unweakened; the four fail-closed probes keep byte-identical file assertions.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:58Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
