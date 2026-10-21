/**
 * SAFETY: snapshot-io — the persistence seam between a hash identity and the snapshot store.
 *
 * WHY: `HashIdentity.hashesFor` caches and persists through `HashSnapshotIO`, a two-method interface
 * WHY: (`get` / `upsert`). That seam belongs to the store: the store owns the rows, the cache key and
 * WHY: the transaction, and identity stays free of store shape. The adapter here is the whole wiring —
 * WHY: a caller names the store it materializes into and gets an IO bound to it.
 *
 * WHY: explicit parameter over an ambient default. ADR-0002's import-time install let a bare
 * WHY: `lineHashes(content, path)` choose whichever store happened to be open in the process, so a
 * WHY: call that never named a store still persisted into one. Callers now pass `snapshotIOFor(store)`
 * WHY: (or `persist: false` when they only derive anchors), and nothing installs a process-wide IO.
 */
import type { HashStore } from "../hash-store.js";
import { cacheKey, getSnapshot, upsertSnapshot } from "./index.js";

export interface HashSnapshotUpsertOptions {
  /**
   * WHY: retirement is conditional on an authoritative materialization (spec §3.1.3.3 / §3.2.4
   * WHY: step 4): it must be `true` only when `content` is the file's committed truth (read-path
   * WHY: materialization, post-write batch commit, undo revert). In-memory working-buffer hashing
   * WHY: that never reaches disk must leave `retired_at` untouched, or a rejected batch would
   * WHY: retire every anchor the session still validly holds and force a re-read.
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
   * The `stat(2)` identity the caller observed for this path when it materialized `content` (ADR-0043):
   * stamped on the snapshot row in the same transaction, so the next read of the unchanged file adopts
   * on stat identity alone. Absent on materializations that never observed the file (working buffers,
   * edit commits, undo restores) — their rows keep a NULL key and never match a stat lookup.
   */
  statKey?: string;
}

/**
 * The two operations an identity needs from the snapshot store: look up the anchors this content
 * already has, and persist the ones it derived. Both are best-effort at the call site (a failed
 * persist loses cache, never correctness), so the seam stays two methods wide.
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
  };
}
