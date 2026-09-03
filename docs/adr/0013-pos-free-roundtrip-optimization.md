# ADR-0013 — Pos-free round-trip optimization with concurrency fallback

Date: 2026-09-01

## Status

accepted

## Context

Issue is freed `3-char` anchors re-bind to identical-content lines and pass `verifyServedRange` silently. Root cause is two-layer: `HashIdentity.mapStableHashes` re-allocates a freed hash via `removedByContent` queue + `baseIdx=xxh32(canon)%SPACE` free-bit, and `ServedVerification.verifyOrThrow` is position-blind (`served[candFrom+k]==fileHashes[startLine-1+k]` only).

Production evidence from downstream `dsh-better-edit` (1050 edits / 145 sessions) shows whole-span variant (`S@3 reborn @3` after `other|cards` swap) where strict `from==pos` also fails when same pos+same canon but different span.

Project contract (`CONTEXT.md:anchor philosophy`) is `position-independent` — exterior `insert @0` before `served 1..5` must not abort `edit 10..12`. Strict `pos` breaks it. Whitespace-insensitive (`ADR-0005`), orphan healing (`ADR-0008`) already rely on content-matching candidates, not pos.

See `CONTEXT.md` glossary (`serve`, `served state`, `position-independent`, `reject-and-serve`, `orphaned serve`) for terminology.

## Decision

Keep **`position-free` for single-thread** (serial `read->edit*` per `sessionKey`), fallback to **`pos-restricted + tombstone + canon`** for concurrency. Model is `OCC` with read-set=`served range`, not file — exterior drift is `drift notice` (ADR-0010), not abort.

### 1. Epoch not pos

At `read` full (`src/file-reader.ts:readNormFile` without `offset/limit` and not truncated): store `epoch={snapshotId:ino|mtime|size|checksum via fileSnap, servedHashes, servedCanons}` per `(session,path)` in `src/served-session/session.ts:served`. `partial read` merges via `patchServed` without clearing epoch.

At `edit` (`src/mutation-engine/pipeline.ts:applyOneEdit` -> `src/hashline/served-verification.ts:verifyOrThrow`):

- `curId=fileSnap(path)` vs `epoch.snapshotId`: if `==` skip pos.
- else candidates `{ [cFrom,cTo] | len==currentLen && ∀k servedHashes[cFrom+k]==fileHashes[startLine-1+k] }` (existing lazy disambiguation, ADR-0008), filtered by `tombstone`, then `∀k servedCanons[from+k]==canon(fileLines[startLine-1+k])` else `E_STALE_RANGE`. No `from==pos`.

### 2. Tombstone (allocation invariant)

`src/hashline/hash-identity.ts:mapStableHashes` drops `removedByContent` queue. `used=bitset(oldHashes)∪bitset(tombstone)` where `tombstone:Set<string>` per `(session,path)` since last full `read`, persisted in `served.retired TEXT` (`JSON string[]`). New lines probe over it. Lifecycle:

- `edit success: tombstone∪=removedHashes` (`src/mutation-engine/pipeline.ts:collectRemovedHashes` + `session.handle.retireAnchors`)
- `undo: tombstone=(tombstone-restored)∪(cur-restored)`
- `read full: tombstone=∅` ; `partial: keep` ; `pruneServedOlderThan` clears with `served`.

Prevents `S@3` reborn `@3` whole-span case where `pos`+`canon` both pass.

### 3. Concurrency fallback (automatic, no config)

No `supportConcurrency` flag — fallback is automatic via `epoch`:

```
curId = fileSnap(path) // ino|mtime|size|checksum at edit
if curId == epoch.snapshotId
  -> single-thread, no concurrent write: resist (pos-free)
     candidates hash== && tombstone∉ && canon==
else
  changed = diff(epochHashes, curHashes) // indices where hash!= 
  if changed ∩ [L,R] == ∅ && changed ∩ servedRanges == ∅
    -> resist (exterior drift, e.g. insert @0 before served 1..5) -> pass
  else
    -> strict: from==startLine-1 && to==endLine-1 && tombstone∉ && canon== else E_STALE_RANGE
```

Makes `shift==rebind` loud only when `changed` overlaps target, not when exterior. Cost is one `edit` retry via `reject-and-serve` (no `read`), rare.

Implementation simplification: `strictPos = epochSnapshotId !== undefined && curSnapshotId !== undefined && epochSnapshotId !== curSnapshotId`. When true, require `from==startLine-1`; otherwise pos-free.

### 4. Non-overlapping forever is pos-free

`A:10..12 +1 line` shifts `B:20..30->21..31`. `B`'s `served 20..30 == file 21..31` still `candidates==1` -> pass. Non-overlapping spans never abort in `resist`.

## Single vs Multi-session

|  | Single-session (serial `read->edit*` per `sessionKey`) | Multi-session (concurrent `A`+`B`) |
|---|---|---|
| Read-set | `epoch==curId` → no concurrent writer | `epoch!=curId` → concurrent `changed` detected |
| Non-overlapping `A:10..12+1` shifts `B:20..30→21..31` | `pass` — candidates `hash==` still `1`, `tombstone∉` | `changed ∩ [L,R]==∅` → `resist` → `pass` (drift notice, not abort) |
| Overlapping `S@3 reborn @3` whole-span | `tombstone` blocks allocation → `E_STALE_ANCHOR` | `changed ∩ [L,R]!=∅` → `strict from==pos` → `E_STALE_RANGE` |
| Cost | `pos-free` — zero extra round trips | May incur one `edit` retry via `reject-and-serve` (`E.servedRows` already re-serves, no `read` needed) |

We keep `pos-free` by default because line non-overlap ≈ semantic non-overlap for hash-anchored edits; strict would make every exterior `insert @0` abort `B`'s unrelated range, violating `CONTEXT.md:anchor philosophy` and `ADR-0008` healing. Concurrency fallback is automatic, no flag — exterior drift stays `resist`, only overlapping concurrent goes `strict`.

## Considered Options

- **Strict pos always** — would make every exterior insert abort `edit 10..12` after `insert @0`, forcing re-read tax, violating `position-independent` and ADR-0008.
- **Tombstone+canon without pos** — fixes same-session dense whole-span, but cross-session isolated `S@2->7` shift stays silent (desired for single thread, undesired for strict concurrency).
- **Global file tombstone** — would block reuse for all sessions until any `read`, prematurely cleared by another agent's `read`. Per-session epoch is correct; file `snapshots` stays global last-writer-wins.

## Consequences

- `src/served-session/session.ts:served` adds `canons TEXT` parallel to `hashes` and `retired TEXT` (tombstone) + `snapshotId TEXT`; helpers `getTombstone/put/canons/epoch`.
- `src/hashline/hash-identity.ts` removes `removedByContent`, adds `tombstone` param to `mapStableHashes`/`hashesFor`.
- `src/hashline/served-verification.ts:verifyOrThrow` keeps candidate enumeration, adds `tombstone` filter and `servedCanons` check, `strict` pos via automatic `epoch != cur`.
- Tests: `hashline-stable-mapping` "reuses first removed hash" flips to `fresh hash`; new cases for tombstone+canon+epoch.

- Round trips: single-thread exterior drift no longer aborts; concurrency strict aborts only on `read-set stale`, retry uses `E.servedRows` without `read`.
