/**
 * ServedSession types — typed boundary for the deep session seam.
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
 * SessionHandle — deep interface for one (session, path) pair.
 *
 * All storage concerns (sessionKey threading, HashStore, SQLite batching,
 * patchServed healing, truncation, reported-set, TTL) stay inside.
 * External seam is 3 conceptual ops: load / record / checkDrift,
 * expanded to 7 typed methods for current call sites without widening to 25.
 */
export interface SessionHandle {
  /** Canonical absolute path this handle owns. */
  readonly path: string;
  /** Session id this handle is scoped to. */
  readonly sessionKey: string;

  /** Load served hashes for this (session,path). */
  load(): Promise<(string | null)[]>;
  /** Load canons parallel to hashes. */
  loadCanons(): Promise<(string | null)[]>;
  /** Load epoch snapshotId. */
  loadEpochId(): Promise<string | undefined>;
  /** Load tombstone (retired hashes) for this epoch. */
  loadTombstone(): Promise<Set<string>>;
  /** Retire hashes (add to tombstone). */
  retire(hashes: Iterable<string>): Promise<void>;
  /** Record arbitrary served rows (position → hash). */
  record(rows: ServedEntry[]): Promise<void>;
  /** Record with truncation (lineCount + optional clearFrom). */
  recordTruncated(rows: ServedEntry[], lineCount: number, clearFrom?: number): Promise<void>;
  /** High-level diff recording: planServeRecording inside, no caller-side plan. */
  recordDiff(servedRows: ServedRow[], opts?: { resultLineCount?: number; firstChangedLine?: number }): Promise<void>;
  /** Echo recording — preview is no-op per policy (keel: recovery stays inside). */
  recordEcho(rows: ServedRow[], policy: ServeRecordPolicy, lineCount?: number): Promise<void>;
  /** Low-level full epoch record (used by read path for atomically persisting hashes+canons+snapshotId+tombstone). */
  recordEpoch(input: { rows: ServedEntry[]; lineCount?: number; fullReadHashes?: readonly string[]; fullReadCanons?: readonly (string | null)[]; snapshotId?: string }): Promise<void>;
  /** Drift: clear reported set (e.g. after a fresh read). */
  clearDrift(): Promise<void>;
  /** Drift: load already-reported hashes. */
  driftReported(): Promise<Set<string>>;
  /** Drift: mark hashes as reported. */
  markDriftReported(hashes: string[]): Promise<void>;
}
