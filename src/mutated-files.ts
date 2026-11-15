/**
 * Mutated-file observer seam — the domain-neutral notification of which file this tool just
 * changed and which of its lines moved: 1-indexed changed ranges fanned out to observers.
 * WHY a seam: the mutated set is known deep in the mutation paths while the consumer is an
 * optional outer integration that may be absent (the mutation bridge), so inverting the dependency
 * keeps every producer free of integration imports and no observer means unchanged behavior.
 * Invariant: an empty `ranges` list means the WHOLE file changed (whole-file authorship, an undo
 * that re-serves, a producer that knows no line detail) — never "nothing happened", so every
 * notification is delivered. `src/served-spans.ts` picks the opposite: empty `spans` means nothing
 * was served, and is dropped. Invariant: no path handling lives here (`filePath` is the absolute
 * normalized path the caller holds); ranges are 1-indexed, expected ascending, non-overlapping, non-adjacent.
 */
import type { ServedSpan } from "./served-spans.js";

/** One file this tool changed, and the lines it changed. */
export interface MutatedFileNotification {
  /** Absolute normalized path supplied by the caller; never resolved or rewritten here. */
  filePath: string;
  /** `edit` is a partial change carrying `ranges`; `write` is whole-file authorship. */
  kind: "edit" | "write";
  /** 1-indexed changed ranges; EMPTY means the whole file changed. */
  ranges: ServedSpan[];
  /** Which tool produced the mutation, for consumers that attribute the write. */
  sourceTool: "edit" | "undo_last_edit" | "write";
}

export type MutatedFileObserver = (notification: MutatedFileNotification) => void;

let observers: MutatedFileObserver[] = [];

/**
 * Register an observer. The returned unsubscribe is idempotent and removes exactly this
 * registration, so registering the same function twice yields two independent subscriptions.
 */
export function addMutatedFileObserver(observer: MutatedFileObserver): () => void {
  observers.push(observer);
  return () => {
    const index = observers.indexOf(observer);
    if (index >= 0) observers.splice(index, 1);
  };
}

/**
 * Fan out to a snapshot of the observers, in registration order.
 *
 * WHY the two deliberate choices: every notification is delivered — including one whose `ranges`
 * are empty, because empty means whole-file rather than nothing — and one throwing observer must
 * not starve the others. That failure belongs to the observer, never to the tool call whose write
 * already landed.
 */
export function notifyMutatedFile(notification: MutatedFileNotification): void {
  // WHY: a snapshot keeps this pass stable — an observer that subscribes or unsubscribes during
  // WHY: fan-out must not change the recipient set mid-iteration.
  const snapshot = observers.slice();
  for (const observer of snapshot) {
    try {
      observer(notification);
    } catch {
      // WHY: observer isolation — a broken integration sink must never fail the edit or write
      // WHY: that already landed, nor silence the remaining observers.
    }
  }
}

/** Test helper: drop every registration so observer state cannot leak between tests. */
export function clearMutatedFileObserversForTests(): void {
  observers = [];
}
