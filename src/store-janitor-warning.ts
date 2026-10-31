/**
 * #197 — the STORE JANITOR's user-visible warning: a pure rendering of one `JanitorOutcome`.
 *
 * WHY the trigger lives in the formatter rather than in a caller: "did anything observable happen"
 * is a property of the outcome, and a caller that re-derived it would be a second owner of the same
 * rule (three counts, the compaction, the deep check, the rebuild). Returning `null` here makes the
 * quiet case unrepresentable downstream, so #198's wiring has one decision — render what it is given
 * — and a run that removed nothing can never become a warning by accident.
 *
 * WHY two levels and not three (#199): the operator's question is "does this need my attention".
 * A routine cleanup and a DEFERRED compaction both answer no (`info`); damage and a compaction that
 * FAILED answer yes (`warn`). The outcome already carries that answer, so the wiring never decides a
 * severity and every surface publishes the same level for the same run.
 *
 * WHY nothing here performs I/O: the only dependency is the log's PATH (`diagnosticsLogPath`, a
 * computation over the state root), never the file. A formatter that opened the log would fail on the
 * failure path it exists to describe, and a test could no longer assert the text without a store.
 *
 * WHY one em-dash clause and no emoji: this text is rendered inside Pi's differential renderer, where
 * width changes are expensive and emoji width is not stable. The bracket prefix is the greppable
 * handle (`grep -F '[pi-better-edit store-janitor]'`), so every line carries it — including the
 * multi-line damaged-store shape, whose lines are read out of order in a log.
 */
import { diagnosticsLogPath } from "./diagnostics.js";
import type { JanitorOutcome } from "./store-janitor.js";

/** Stable, greppable handle on every line this module emits. Never localize, never shorten. */
export const JANITOR_WARNING_PREFIX = "[pi-better-edit store-janitor]";

/**
 * One rendered warning. `info` is a single cleanup sentence; `warn` is a degraded-store shape (damage,
 * or a compaction that failed), whose lines are separate because a reader must be able to quote "your
 * files were not touched" alone.
 */
export interface JanitorWarning {
  readonly level: "info" | "warn";
  readonly lines: readonly string[];
}

/** Injection seam for the log pointer, so a test never has to resolve a real state root. */
export interface JanitorWarningOptions {
  readonly logPath?: string;
}

const WHY = "keeps the local undo/history store small and fast";

/**
 * The one entry point: `null` when no warning is warranted (the mode or the throttle skipped the run,
 * or the run observed nothing), an `info` cleanup sentence, or the `warn` degraded-store shape.
 */
export function formatJanitorWarning(
  outcome: JanitorOutcome,
  options: JanitorWarningOptions = {},
): JanitorWarning | null {
  if (!outcome.ran) return null;
  if (outcome.deepCheckFailed || outcome.rebuilt) {
    // WHY: damage wins over a failed compaction — a rebuild REPLACED the store, so pointing the
    // WHY: operator at the old file's failed VACUUM would name the wrong event.
    return {
      level: "warn",
      lines: damageLines(outcome.rebuilt, options.logPath ?? diagnosticsLogPath()),
    };
  }
  if (outcome.compacted.reason === "failed") {
    return {
      level: "warn",
      lines: compactionFailureLines(options.logPath ?? diagnosticsLogPath()),
    };
  }
  const sentence = cleanupSentence(outcome);
  return sentence === undefined
    ? null
    : { level: "info", lines: [`${JANITOR_WARNING_PREFIX} ${sentence}`] };
}

/**
 * One sentence: the non-zero families, the reclaimed space, then the why-clause. A deferral replaces
 * the why-clause because it has nothing to reclaim yet and one thing to promise instead (the retry).
 */
function cleanupSentence(outcome: JanitorOutcome): string | undefined {
  const removed = removedClause(outcome.deleted);
  const reclaimed = reclaimedClause(outcome.compacted);
  if (removed === undefined) {
    if (reclaimed === undefined) return deferredClause(outcome.compacted);
    const joined = outcome.compacted.reclaimedBytes > 0 ? `and ${reclaimed}` : `but ${reclaimed}`;
    return `Compacted the store ${joined} — ${WHY}.`;
  }
  if (reclaimed !== undefined) return `${removed}, ${reclaimed} — ${WHY}.`;
  const deferred = deferredClause(outcome.compacted);
  return deferred === undefined ? `${removed} — ${WHY}.` : `${removed}. ${deferred}`;
}

/** "Removed 2 snapshots and 1 lineage row" — zero families are absent, never rendered as 0. */
function removedClause(deleted: JanitorOutcome["deleted"]): string | undefined {
  const phrases = [
    countPhrase(deleted.expiredLeases, "expired session lease"),
    countPhrase(deleted.leases, "stale lease"),
    countPhrase(deleted.snapshots, "snapshot"),
    countPhrase(deleted.lineage, "lineage row"),
  ].filter((phrase) => phrase !== undefined);
  if (phrases.length === 0) return undefined;
  const last = phrases[phrases.length - 1];
  const head = phrases.slice(0, -1).join(", ");
  return `Removed ${head === "" ? last : `${head} and ${last}`}`;
}

function countPhrase(count: number, noun: string): string | undefined {
  return count > 0 ? `${count} ${count === 1 ? noun : `${noun}s`}` : undefined;
}

/** "reclaimed 1.5 MB" only when the VACUUM actually ran; a deferred one says nothing. */
function reclaimedClause(compacted: JanitorOutcome["compacted"]): string | undefined {
  if (!compacted.ran) return undefined;
  return compacted.reclaimedBytes > 0
    ? `reclaimed ${humanizeBytes(compacted.reclaimedBytes)}`
    : "reclaimed no space";
}

/**
 * "Compaction deferred: the store was busy — it retries at the next maintenance pass." WHY a whole
 * sentence and not a clause: it reads correctly both alone and after a removal, and it names its own
 * retry because the deferral is a fact about the NEXT pass, not about this one.
 */
function deferredClause(compacted: JanitorOutcome["compacted"]): string | undefined {
  return !compacted.ran && compacted.reason === "busy"
    ? "Compaction deferred: the store was busy — it retries at the next maintenance pass."
    : undefined;
}

/**
 * The FAILED-compaction shape. WHY it is a warning and carries the log pointer: the reclaim did not
 * happen, so the store keeps those pages until a later pass wins, and the exception that explains it
 * lives in the log. WHY "your files were not touched" still leads: it is the same first question the
 * damaged-store shape answers, and a failed VACUUM has never written to a user's file.
 */
function compactionFailureLines(logPath: string): readonly string[] {
  return [
    "The local undo/history store could not be compacted; your files were not touched. " +
      "The next maintenance pass retries.",
    `Details: ${logPath}`,
  ].map((line) => `${JANITOR_WARNING_PREFIX} ${line}`);
}

/** KB below a megabyte, MB above it, one decimal in both: the operator reads a magnitude, not bytes. */
function humanizeBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * The damaged/rebuilt shape. WHY separate lines and separate wording: the operator's first question is
 * "did it touch my files", so that answer leads; the second is "is my history gone", which is
 * "may be incomplete", never "lost"; the third is where the evidence is, which is the log.
 */
function damageLines(rebuilt: boolean, logPath: string): readonly string[] {
  const lines = rebuilt
    ? [
        "The local undo/history store was damaged and has been rebuilt; your files were not touched.",
        "Undo/history recorded before the rebuild may be incomplete.",
        `Details: ${logPath}`,
      ]
    : [
        "The local undo/history store looks damaged; your files were not touched.",
        "Undo/history may be incomplete until the store is rebuilt.",
        `Details: ${logPath}`,
      ];
  return lines.map((line) => `${JANITOR_WARNING_PREFIX} ${line}`);
}
