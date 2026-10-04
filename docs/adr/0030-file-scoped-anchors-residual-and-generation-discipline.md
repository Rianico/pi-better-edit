# ADR-0030 — File-scoped anchors: accepted residual, generation discipline

Date: 2026-10-04

## Status

accepted. Supplements [ADR-0029](0029-widen-anchors-to-4-characters-for-tokenizer-stable-references.md) (width/reservation record). No earlier ADR is touched.

## Context

Anchors derive from `(canonical path, line content)`: `fileBaseIndex(canon, xxh32(path))` over the 62^4 space minus the reserved all-digit subcube (usable `S = 14,766,336`). The adversarial review of the file-scope change probed three properties and one migration gap. This record states what is accepted, what was wrong in the design notes, and how pre-v3 persisted state is handled.

## Decision

1. **Accepted residual: same-spelling anchors across files.** For two files of `n` lines, `P(a given anchor exists in the sibling) = n/S` and `E[shared spellings] = n²/S` (0.27 at `n = 2000`); a seeded sweep measured 88/400 path pairs sharing ≥1 spelling (~22 %). A shared spelling resolves only against the lease set of the file it was served for — submitting it against the sibling is refused as foreign (`E_FOREIGN_ANCHOR`), never written. The residual is therefore a refusal-rate curiosity, not a wrong-write vector, and it is accepted: no resolve-time refusal of ambiguous spellings is added, because such a refusal would be dead code punishing the legitimate holder whenever the invariant holds.
2. **Case-only siblings fork correctly.** Lease span components and the derivation seed are case-sensitive byte strings, so `A.txt` and `a.txt` derive disjoint sets (modulo the §1 residual) on a case-sensitive filesystem, and a cross submission is refused. On a case-insensitive filesystem the two names are one file and agree. The observed fork-then-refusal is the design working, not a defect.
3. **Symlinked aliases agree (design-note correction).** The T6 design note claimed symlink aliases derive different anchors under lexical-only seeding. That is wrong on this branch: the read path resolves symlinks (`resolveTarget`) before seeding, so aliases of one file share one anchor set. Seeding is lexical *after* symlink resolution, never on the raw request spelling.
4. **Pre-v3 persisted state is refused, not migrated.** `file_undo` gains `canon_version INTEGER NOT NULL DEFAULT 0` (existing rows keep 0, i.e. never current); every `upsertUndo` stamps the current `CANON_VERSION`. Both undo restore fallbacks adopt stored hashes only when the row's generation matches, otherwise re-deriving file-scoped anchors for the same path. `anchorsForSnapshotHash` resolves only current-generation keys (prefix check, miss otherwise); `adoptPinnedSnapshotFor` throws a programmer error on a foreign-generation descriptor instead of writing its anchors. No store sweep and no migration precondition: the column migration runs at every store open (additive idiom, tables never dropped), legacy rows default to a refused generation, old lineage keys miss on prefix, and a resumed session's old leases cannot verify against current rows — every stale path ends in refusal, never in a silent write.

## Consequences

- Tests pin the §1 residual as a bounded inequality plus a deterministic same-position guard and a deliberately colliding fixture pair, each citing this ADR — never a lucky zero.
- `HASH_STORE_VERSION` advances 7 → 8 as the record-only schema marker.
- Undo restores after upgrade serve current-generation anchors; the bytes restored are unchanged, only the anchor set is re-derived.
- The served admission budget (`SERVED_MAX_LINES`, T7) is independent of the anchor space: neither is derived from the other, so a width change moves the ceiling but never the memory budget.
