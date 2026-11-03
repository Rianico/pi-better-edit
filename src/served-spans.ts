/**
 * Served-span observer seam — the domain-neutral notification of which lines this tool just
 * served. Producers (read, reject-and-serve, auto-read, diff) hand over 0-based rows; this
 * module run-length encodes them into 1-indexed maximal contiguous spans and fans them out to
 * registered observers.
 *
 * WHY a seam: the served set is known deep in the read and reject-and-serve paths, while the
 * consumer is an optional outer integration that may be absent entirely. Inverting the
 * dependency here keeps every producer free of integration imports, and with no observer
 * registered the behavior of the tool is unchanged.
 *
 * Invariant: no path handling lives here — `filePath` is the absolute normalized path the caller
 * already holds. Spans are 1-indexed because served rows are 0-indexed internally while every
 * consumer-facing surface counts lines from 1.
 */
import type { ServedRow } from "./domain-errors.js";

/** One maximal contiguous run of served lines. */
export interface ServedSpan {
  /** 1-indexed first line of the run. */
  startLine: number;
  /** Consecutive served lines in the run; always >= 1. */
  lineCount: number;
}

/** The served lines of one file, plus why they were served. */
export interface ServedSpanNotification {
  /** Absolute normalized path supplied by the caller; never resolved or rewritten here. */
  filePath: string;
  /** Ascending, non-overlapping, non-adjacent runs; empty means nothing was served. */
  spans: ServedSpan[];
  /** Which producer served these rows. */
  source: "read" | "reject-and-serve" | "auto-read" | "diff";
  /**
   * Verbatim raw text of the file at serve time, without anchor prefixes.
   * Producers that hold the bytes (read, auto-read) attach it so an observer can
   * hash caller evidence in memory; producers with no text at hand (diff
   * previews, reject-and-serve) omit it and the observer falls back to disk
   * evidence. Never the anchored preview: hashes are computed over verbatim lines.
   */
  content?: string;
}

export type ServedSpanObserver = (notification: ServedSpanNotification) => void;

/** SAFETY: a serviceable row is one whose 0-based position is a non-negative integer; NaN,
 * fractional and negative positions name no line and are dropped rather than coerced. */
function isServablePosition(position: number): boolean {
  return Number.isInteger(position) && position >= 0;
}

/**
 * Run-length encode 0-based served positions into 1-indexed maximal contiguous spans.
 * Pure: dedupes and sorts a copy, never mutates `rows`. Empty input yields `[]`.
 */
export function servedRowsToSpans(rows: readonly ServedRow[]): ServedSpan[] {
  const positions = new Set<number>();
  for (const row of rows) {
    if (isServablePosition(row.position)) positions.add(row.position);
  }

  const spans: ServedSpan[] = [];
  let runStart: number | undefined;
  let runCount = 0;
  for (const position of [...positions].sort((left, right) => left - right)) {
    // SAFETY: an open run covers the half-open range [runStart, runStart + runCount - 1]; the
    // SAFETY: next contiguous position in that run is therefore exactly runStart + runCount.
    if (runStart !== undefined && position === runStart + runCount) {
      runCount += 1;
      continue;
    }
    if (runStart !== undefined) spans.push({ startLine: runStart + 1, lineCount: runCount });
    runStart = position;
    runCount = 1;
  }
  if (runStart !== undefined) spans.push({ startLine: runStart + 1, lineCount: runCount });
  return spans;
}

let observers: ServedSpanObserver[] = [];

/**
 * Register an observer. The returned unsubscribe is idempotent and removes exactly this
 * registration, so registering the same function twice yields two independent subscriptions.
 */
export function addServedSpanObserver(observer: ServedSpanObserver): () => void {
  observers.push(observer);
  return () => {
    const index = observers.indexOf(observer);
    if (index >= 0) observers.splice(index, 1);
  };
}

/**
 * Fan out to a snapshot of the observers, in registration order.
 *
 * WHY the two deliberate choices: an empty `spans` list is not a notification at all (nothing
 * was served, so there is nothing to mirror), and one throwing observer must not starve the
 * others — that failure belongs to the observer, never to the tool call that served the rows.
 */
export function notifyServedSpans(notification: ServedSpanNotification): void {
  if (notification.spans.length === 0) return;
  // WHY: a snapshot keeps this pass stable — an observer that subscribes or unsubscribes during
  // WHY: fan-out must not change the recipient set mid-iteration.
  const snapshot = observers.slice();
  for (const observer of snapshot) {
    try {
      observer(notification);
    } catch {
      // SAFETY: observer isolation — a broken integration sink must never fail the read or edit
      // SAFETY: that already served its rows, nor silence the remaining observers.
    }
  }
}

/** Test helper: drop every registration so observer state cannot leak between tests. */
export function clearServedSpanObserversForTests(): void {
  observers = [];
}
