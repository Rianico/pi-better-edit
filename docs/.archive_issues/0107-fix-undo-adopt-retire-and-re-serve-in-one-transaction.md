# fix(undo): adopt, retire and re-serve in one transaction

> **Archived from pre-migration issue #107.** The fork-to-standalone migration (repo delete + recreate, 2026-09-28) permanently destroyed GitHub issues; this file preserves the record from the pre-deletion export.
> Original: filed by @Rianico on 2026-09-13T16:13:54Z · state CLOSED · labels: ready-for-agent

## Body

Part of #78 (Content-Addressed Line-Identity MVCC, Revision 22).

## Spec
Line 123: the restore transaction executes `SELECT snapshot_id FROM file_snapshots WHERE path = :path AND snapshot_hash = :hash AND committed = 1` **inside `BEGIN IMMEDIATE`** to adopt the canonical `snapshot_id` and `line_lineage` directly, executes the authoritative retirement update (§3.1.3.3) on the lines removed by the revert, and re-serves the restored lines into `served_leases` with `retired_at = NULL` and `served_snapshot_hash = :hash`.

## Finding
`src/edit-undo.ts` L224-266 splits one logical restore across three disjoint transactions:

1. `writeAtomic` writes the restored bytes;
2. `adoptPinnedSnapshotFor` runs in its own transaction to adopt the pinned snapshot;
3. `recordLeases` runs in a third transaction to re-serve the restored lines.

No single atomic block adopts the canonical snapshot, retires the removed lines and re-serves the restored ones, so a failure between (2) and (3) leaves the store with adopted lineage but no leases for content that is already on disk.

## Remedy
After `writeAtomic` (the disk bytes are authoritative, per spec §3.6.2), execute adoption, the authoritative retirement update, and the restored-line lease upsert inside **one** `BEGIN IMMEDIATE` transaction (with the existing busy-retry wrapper). Merge the `adoptPinnedSnapshotFor` and `recordLeases` work into that single transaction; the pinned-snapshot cache lookup stays inside it.

`writeAtomic` must still run **first**, and a store failure after it must keep the documented §3.6.2 semantics (the tool reports success for the written bytes with a deferred-synchronization warning) - it must not roll back the file.

## Acceptance criteria
- Adopt + retire + re-serve execute in exactly one store transaction; no third transaction remains on the undo-revert path.
- `writeAtomic` still precedes the store transaction, and the §3.6.2 post-write failure semantics are preserved (tool reports success plus the deferred-sync warning).
- A test induces a failure inside the transaction and asserts no partial state is left (no adopted lineage without leases, no lease rows without the retirement update).
- Probe §7.2.9 (undo usability: an `edit` immediately after `undo_last_edit`, with no intermediate `read`) still passes, and all 15 Stage-0 probes stay green.
- `pnpm run lint && pnpm run format && pnpm run typecheck && pnpm run test:coverage` green.


## Comments

### @Rianico — 2026-09-15T07:40:24Z

Delivered.

Merged into `dev/mvcc-line-identity` across the review-3, review-4 and review-5 rounds, then consolidated — `main` @ `bd3a8f2` and the local integration tip `78e270d` both contain this work (verified: spec published at `docs/spec/content-addressed-line-identity-mvcc.md` with `.scratch/` removed; `ReServeGrant`/`reServe` alias gone; zero `catch {}` left in `src/`; read/edit/undo all grant leases inside the materialization transaction; the legacy tombstone retire runs after `writeAtomic`; the changelog Unreleased section is byte-for-byte the generator's output).

Last local gate on the integrated state: lint/format/typecheck clean, 1334 tests passing (1 skipped), coverage 90.71 / 84.28 / 90.86 / 91.85.

Closing.
