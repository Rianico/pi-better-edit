/**
 * SAFETY: ServedSession types — typed boundary for the deep session seam.
 *
 * Vocabulary: served state, session, drift, drift notice, anchor — see CONTEXT.md.
 * Keeps fact authority (what this session saw) inside the module.
 */

import type { ServedRow } from "../hashline/served.js";

export type ServedEntry = { position: number; hash: string | null };

export type ServeRecordPolicy = "live" | "preview";

export type ServeRecordingPlan =
  | { mode: "plain" }
  | { mode: "truncated"; lineCount: number; clearFrom: number };

/**
 * SAFETY: SessionHandle — deep interface for one (session, path) pair.
 *
 * All storage concerns (sessionKey threading, HashStore, SQLite batching,
 * patchServed healing, truncation, reported-set, TTL) stay inside.
 * External seam is 3 conceptual ops: load / record / checkDrift,
 * expanded to 7 typed methods for current call sites without widening to 25.
 */
export interface SessionHandle {
  /** SAFETY: Canonical absolute path this handle owns. */
  readonly path: string;
  /** SAFETY: Session id this handle is scoped to. */
  readonly sessionKey: string;

  /** SAFETY: Load served hashes for this (session,path). */
  load(): Promise<(string | null)[]>;
  /** SAFETY: Load canons parallel to hashes. */
  loadCanons(): Promise<(string | null)[]>;
  /** SAFETY: Load epoch snapshotId. */
  loadEpochId(): Promise<string | undefined>;
  /** SAFETY: Load tombstone (retired hashes) for this epoch. */
  loadTombstone(): Promise<Set<string>>;
  /** SAFETY: Retire hashes (add to tombstone). */
  retire(hashes: Iterable<string>): Promise<void>;
  /** SAFETY: Record arbitrary served rows (position → hash). */
  record(rows: ServedEntry[]): Promise<void>;
  /** SAFETY: Grant `served_leases` identities for already-materialized rows (undo re-serve). */
  recordLeases(rows: ServedEntry[], contentHash: string): Promise<void>;
  /** SAFETY: Record with truncation (lineCount + optional clearFrom + served content hash). */
  recordTruncated(
    rows: ServedEntry[],
    lineCount: number,
    clearFrom?: number,
    contentHash?: string,
  ): Promise<void>;
  /** SAFETY: High-level diff recording: planServeRecording inside, no caller-side plan. */
  recordDiff(
    servedRows: ServedRow[],
    opts: {
      /**
       * Committed `file_snapshots.snapshot_hash` of the content served; binds the leases granted.
       * Absent when the materialization transaction already granted them (spec §3.1.2 step 5) —
       * the record is then mirror-only.
       */
      contentHash?: string;
      resultLineCount?: number;
      firstChangedLine?: number;
    },
  ): Promise<void>;
  /** SAFETY: Serve-feedback recording — preview is no-op per policy (keel: recovery stays inside). */
  recordServeFeedback(
    rows: ServedRow[],
    policy: ServeRecordPolicy,
    lineCount?: number,
    contentHash?: string,
  ): Promise<void>;
  /** SAFETY: Low-level full epoch record (used by read path for atomically persisting hashes+canons+snapshotId+tombstone). */
  recordEpoch(input: {
    rows: ServedEntry[];
    lineCount?: number;
    fullReadHashes?: readonly string[];
    fullReadCanons?: readonly (string | null)[];
    snapshotId?: string;
    /** Committed `file_snapshots.snapshot_hash` of the content served; binds the leases granted. */
    contentHash?: string;
    isFullRead?: boolean;
  }): Promise<void>;
  /** SAFETY: Drift: clear reported set (e.g. after a fresh read). */
  clearDrift(): Promise<void>;
  /** SAFETY: Drift: load already-reported hashes. */
  driftReported(): Promise<Set<string>>;
  /** SAFETY: Drift: mark hashes as reported. */
  markDriftReported(hashes: string[]): Promise<void>;
}
