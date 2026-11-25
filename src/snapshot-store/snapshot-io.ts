/**
 * SAFETY: snapshot-io — the persistence seam between a hash identity and the snapshot store.
 *
 * `HashIdentity.hashesFor` caches and persists through `HashSnapshotIO`, a three-method interface
 * (`get` / `upsert` / `latestLineage`). That seam belongs to the store: it owns the rows, the cache key
 * and the transaction, and identity stays free of store shape — a caller names its store, gets an IO.
 *
 * Explicit parameter over an ambient default. docs/.archive_adrs/0002-session-keyed-served-state.md's import-time install let a bare
 * `lineHashes(content, path)` choose whichever store happened to be open in the process, so a
 * call that never named a store still persisted into one. Callers now pass `snapshotIOFor(store)`
 * (or `persist: false` when they only derive anchors); nothing installs a process-wide IO.
 */
import type { HashStore } from "../hash-store.js";
import { cacheKey, getSnapshot, latestLineageFor, upsertSnapshot } from "./index.js";

/** One line of the newest committed lineage, as the checksum-miss alignment consumes it. */
export interface SnapshotLineageLine {
  lineNumber: number;
  anchor: string;
  canonHash: string;
  /**
   * `line_lineage.raw_hash` — xxh32 of the RAW line, the exact spelling this row was written for.
   * Optional because legacy rows predate #344 and carry NULL: a missing digest is NO raw evidence, so a
   * consumer that needs one (the ordinal-carry gate) must fail closed rather than assume a match.
   */
  rawHash?: string | undefined;
}

export interface HashSnapshotUpsertOptions {
  /**
   * Retirement is conditional on an authoritative materialization: it must be `true` only when
   * `content` is the file's committed truth (read-path materialization, post-write batch commit,
   * undo revert). In-memory working-buffer hashing that never reaches disk must leave `retired_at`
   * untouched, or a rejected batch would retire every anchor the session still validly holds and
   * force a re-read.
   */
  retireLeases?: boolean;
  /**
   * The served rows to lease inside the materialization transaction (spec §3.1.2 step 5 /
   * §3.2.4 step 4): granted with `retired_at = NULL` and `served_snapshot_hash` bound to the
   * snapshot this transaction commits, so snapshot + lineage + leases commit or roll back as
   * one `BEGIN IMMEDIATE` unit. Absent on hashing paths that serve nothing (working buffers).
   */
  leases?: {
    sessionKey: string;
    rows: ReadonlyArray<{ position: number; hash: string | null }>;
  };
  /**
   * CAND-3: the served mirror write for the same rows, committed inside the materialization's
   * own `BEGIN IMMEDIATE` (via `recordServedMirrorInTransaction`), so the `served_leases` grant
   * and the mirror rows commit or roll back as one unit — lease-without-mirror and
   * mirror-without-lease become structurally unreachable on the post-write commit. Absent on
   * paths that write the mirror separately (the read path records serves through its own seam).
   */
  servedMirror?: {
    sessionKey: string;
    rows: ReadonlyArray<{ position: number; hash: string | null }>;
    /** Truncated-serve mirror shape: clamp to `lineCount`, clear from `clearFrom`. */
    shape?: { lineCount: number; clearFrom?: number };
    /** Anchors added to the legacy retired set in this transaction (undo's displaced cleanup). */
    retireAnchors?: readonly string[];
  };
  /**
   * The `stat(2)` identity the caller observed for this path when it materialized `content` (docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md):
   * stamped on the snapshot row in the same transaction, so the next read of the unchanged file adopts
   * on stat identity alone. Absent on materializations that never observed the file (working buffers,
   * edit commits, undo restores) — their rows keep a NULL key and never match a stat lookup.
   */
  statKey?: string;
}

/**
 * The three operations an identity needs from the snapshot store: look up the anchors this content
 * already has, persist the ones it derived, and read the latest committed lineage to align a checksum
 * miss against. All are best-effort at the call site (a failed persist or lineage read loses cache,
 * never correctness; a missing lineage falls back to fresh allocation), so the seam stays three methods wide.
 */
export interface HashSnapshotIO {
  get(path: string, content: string, deleteCorrupt: boolean): Promise<string[] | undefined>;
  upsert(
    path: string,
    checksum: string,
    lineCount: number,
    hashes: string[],
    content: string,
    options?: HashSnapshotUpsertOptions,
  ): Promise<void>;
  /**
   * The newest committed lineage for `path`, the evidence a checksum-miss alignment pairs against. Absent
   * when the path holds no committed snapshot, which tells the caller to allocate fresh anchors instead.
   */
  latestLineage(path: string): Promise<SnapshotLineageLine[] | undefined>;
}

/** Binds the snapshot store's read/write entry points to one store, as an identity's persistence seam. */
export function snapshotIOFor(store: HashStore): HashSnapshotIO {
  return {
    async get(path, content, deleteCorrupt) {
      return getSnapshot(store, path, content, deleteCorrupt ? "delete" : "keep");
    },
    async upsert(path, checksum, lineCount, hashes, content, options) {
      upsertSnapshot(
        store,
        { path, snapshotHash: cacheKey(checksum), lineCount, hashes, content },
        options,
      );
    },
    async latestLineage(path) {
      return latestLineageFor(store, path);
    },
  };
}
