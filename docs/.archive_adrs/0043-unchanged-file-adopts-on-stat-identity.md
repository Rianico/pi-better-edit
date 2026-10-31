# ADR-0043 — An unchanged file is adopted on its stat identity

Date: 2026-10-21

## Status

accepted — extends the file-version identity [ADR-0013](0013-epoch-id-format.md)
already derives (`fileSnap`) into an adoption decision. Complements
[ADR-0042](0042-retention-runs-only-on-fresh-snapshot-commits.md): adoption still
runs no retention sweep.

## Context

A served read of an unchanged large file did all of the following, every time,
to prove that the snapshot it already had still described the file:

- `contentChecksum` over the whole normalized text (cheap, ~1.4 ms / 3.5 MB);
- one `line_lineage` read of **every** anchor of the snapshot, plus a JavaScript
  `Map` keyed by anchor (~38 ms + ~36 ms on a 100k-line fixture);
- `splitLines` of the whole file inside the materialization (~2 ms);
- the lease grant repeated the full-lineage read and `Map` (~74 ms);
- `retireAbsentLeases` evaluated `line_id NOT IN (SELECT line_id FROM
  line_lineage WHERE snapshot_id = ?)`, which built a 100k-row temp b-tree on
  every cache-hit read (~12 ms).

Measured through the real read tool (100,000 lines, 6.09 MB, page-sized window),
before this change: **194 ms** to adopt an unchanged file. The work was
proportional to the file, while the read served at most one page. Over the same
fixture the first (cold) materialization cost **592 ms**; the adoption was
paying a large part of it again.

The store already knows the exact file version every read-path snapshot came
from: `fileSnap` builds the per-session epoch from `ino|mtimeMs|ctimeMs|size`
and the content checksum. Nothing recorded that identity on the snapshot row, so
the next read had no way to name the snapshot it wanted without re-reading the
whole lineage.

## Decision

1. **A snapshot row carries the file version a read observed.**
   `file_snapshots.stat_key TEXT` (nullable) holds `ino:size:mtimeMs:ctimeMs`,
   with `idx_snapshots_path_stat(path, stat_key)`. `HASH_STORE_VERSION` is
   bumped so an existing store gains the column and index on its next open.
   NULL is meaningful: a row no read stamped (edit/undo materializations,
   pre-v11 stores) never matches a stat lookup, so it is not a stale identity —
   it is no identity. The key is a string, not four columns: SQLite compares it
   exactly, and `String(number)` round-trips doubles, so no float equality
   decides whether a file is unchanged.

2. **Only an authoritative read stamps the key.** The read path passes the
   `stat(2)` identity it observed into the materialization transaction, on both
   the fresh-insert and the content-verified-adoption branches. Edit and undo
   materializations have no observed identity and stamp nothing.

3. **A stat match selects a snapshot; it does not prove it.** On a served read,
   the snapshot is looked up by `(path, stat_key)` (newest row first). If found,
   the preview resolves only the **kept page's** lineage rows, by primary-key
   range (`snapshot_id, line_number`), and verifies each line before serving its
   anchor:
   - the snapshot's committed line count must equal the count this read walked;
   - each kept line's `canonDigest` must equal the `canon_hash` the snapshot
     committed for that line.

   Any disagreement throws `StatIdentityMismatchError` and the read falls
   through to the content-hash path, which is authoritative. A stat identity that
   lies therefore costs a fallback, never a stale anchor.

4. **Adoption is its own transaction.** `adoptStatSnapshotFor` re-reads the row
   by `(path, stat_key)` inside `BEGIN IMMEDIATE` (a vacuum or re-stamp may have
   won the race), stamps no content, retires absent leases, grants the served
   rows, records the mirror, and commits. It returns `false` on a lost race so
   the caller can fold the file back into the content-hash batch. A `true`
   adoption cannot grow the store, so it runs no retention sweep (ADR-0042).

5. **The grant and the retirement are page-priced.**
   - `grantLeasesInTransaction` resolves the served line numbers with
     `line_number IN (...)` (PK seeks, 400 per statement) up to `GRANT_PAGE_MAX =
     4096` served rows; a whole-file serve keeps one lineage scan.
   - `leaseRetireAbsent` rewrites `NOT IN (subquery)` as `line_id IS NOT NULL AND
     NOT EXISTS (...)`: identical semantics for a NULL `line_id` (which retired
     nothing before) and an index probe per active lease.

6. **Fallback is unchanged and remains the correctness owner.** A stat miss, a
   changed line count, a short lineage range, or a canon mismatch all run the
   existing content checksum + `hashesFor` path, which re-derives identity from
   the bytes and re-stamps the observed identity for the next read. Same-size,
   same-mtime rewrites are detected because userspace cannot set `ctime`:
   `utimes` and every write bump it, so the stat key changes and the content
   path decides. On a filesystem with coarse timestamps (or a lying server-side
   attribute cache) the key can match a changed file; the per-line canon check
   then catches it on the served page, and an untouched line elsewhere can at
   worst shift a later anchor through a hash collision — an edit on that anchor
   fails closed against `line_lineage`, it does not corrupt the file.

## Consequences

Measured with the same tool, fixture and window (`node scripts/bench-adopt.mjs`
at base `0aac271` and at this change):

| scenario | before | after |
| --- | ---: | ---: |
| first read (cold materialization) | 592.2 ms | 426.0 ms |
| unchanged adoption, page | 194.1 ms | **39.0 ms** (43.3 ms on a second run) |
| unchanged adoption, whole file | 236.3 ms | 174.0 ms |
| touch, then adopt (fallback) | 188.6 ms | 78.9 ms |
| atomic replace, then adopt (fallback) | 184.5 ms | 78.8 ms |
| one-line content change | 952.9 ms | 891.3 ms (0.89-1.26 s across runs) |

- Adopting an unchanged file now costs its page: load, decode, one page walk, one
  PK range read, per-line canon verification, and a small transaction. The
  remaining 39 ms is dominated by reading the 6 MB file, not by identity work.
- A whole-file read still resolves every line it retains before truncating, so it
  stays proportional to the file; the fast path removes the split, the
  anchor-keyed `Map`, and the extra lineage pass, not the page itself.
- First reads are not slower (they got faster: the grant and retirement fixes
  apply to every materialization).
- A one-line content change is dominated by re-hashing and re-materializing
  every line; it is unchanged by this ADR and its measurement varies with store
  growth across the benchmark's samples.
- The store gains one nullable column and one index; existing rows keep working
  through the content-hash fallback and are stamped on their next read.
- The residual trust is per-page and fails closed: an anchor is only served for
  a line whose canon the snapshot still matches, and edit resolution still
  checks lineage before touching disk.
