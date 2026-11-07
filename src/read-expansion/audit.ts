/**
 * The note's failure sink — the trajectory record for provider lookups that failed.
 *
 * WHY its own file beside `diagnostics.log`: a failed span lookup is an expected event, not a
 * diagnostic failure, and a queryable "which lookup failed, on what, and why" belongs in its own
 * JSONL stream. The placement and rotation policy are deliberately the diagnostics one:
 * `<stateRoot>/selection-range.log` with one rotated generation, so an operator can attach the pair
 * whole.
 *
 * WHY the retired name is ADOPTED rather than left behind: this sink was `read-expansion.log` before
 * the read-expansion retirement, and the log that explains a bug an operator is reporting is exactly
 * the file a rename must not orphan. The first write moves the old pair onto the new names, each
 * generation only while its new path is absent — the rule `MOVED_ARTIFACTS` applies to a state-root
 * move, and for the same reason: a log already written under the new name is this install's own
 * record and wins over the history beside it.
 *
 * WHY failures only: an ordinary read — note-free, gated out, or served with a note — writes no row,
 * so the file stays proportional to the defects worth fixing instead of every tool call.
 *
 * WHY the first record of a session carries `rung`: recording the resolved ladder source once per
 * session makes the effective policy visible without repeating it on every line. Later records omit
 * it. The rung is required, so a new caller cannot silently stamp the wrong value.
 *
 * The refusal vocabulary lives in `docs/agents/selection-note-replay.md#refusal-vocabulary`.
 *
 * WHY nothing here may throw: an audit write is best effort. A sink failure must never turn a read
 * that already served its rows into a failed call.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "../config-dir.js";
import type { ConfigRung } from "../json-config.js";
import type { SpanSource } from "./provider-contract.js";

/** Fixed file name inside `stateRoot()`; exported so tests and status readers agree on it. */
const SELECTION_RANGE_LOG_NAME = "selection-range.log";

/** The name this sink carried before the read-expansion retirement; read once, for adoption. */
const RETIRED_LOG_NAME = "read-expansion.log";

/** One rotated generation, matching the diagnostics sink's ceiling. */
const SELECTION_RANGE_LOG_MAX_BYTES = 1024 * 1024;

interface LoggedWindow {
  readonly startLine: number;
  readonly endLine: number;
}

/** One failed provider lookup: the file, the source, and the reason it could not answer. */
export interface ProviderFailureLogEntry {
  readonly file: string;
  readonly mode: "served" | "verbatim" | "outline";
  readonly source: SpanSource;
  readonly reason: string;
  /** The window the lookup was asked about, when one is known. */
  readonly requested?: readonly LoggedWindow[];
}

/** `<stateRoot>/selection-range.log` — a sibling of `diagnostics.log`. */
export function selectionRangeLogPath(): string {
  // SAFETY: join of trusted stateRoot with a fixed file name — constant suffix, no traversal.
  return join(stateRoot(), SELECTION_RANGE_LOG_NAME);
}

/**
 * Move a pre-rename log pair onto the new names, each generation only while its new path is absent.
 *
 * WHY here and not in `state-migration.ts`: that pass adopts artifacts that followed a STATE-ROOT
 * move, and its marker makes it a once-per-root event. This is a rename INSIDE the root, so it has
 * to be in place before the very next write rather than at the next migration.
 */
function adoptRetiredLogName(): void {
  for (const generation of ["", ".1"] as const) {
    const from = join(stateRoot(), `${RETIRED_LOG_NAME}${generation}`);
    const to = join(stateRoot(), `${SELECTION_RANGE_LOG_NAME}${generation}`);
    if (existsSync(to) || !existsSync(from)) continue;
    try {
      renameSync(from, to);
    } catch {
      // SAFETY: best effort — the append this precedes still succeeds, and the old pair stays
      // SAFETY: readable under its retired name, which is a worse report than a moved one.
    }
  }
}

/** Test helper: forget which sessions already recorded their rung. */
export function resetSelectionRangeLogStateForTests(): void {
  rungRecordedSessions.clear();
}

let rungRecordedSessions = new Set<string>();

/**
 * Append one failed lookup. Never throws: a lost audit record must not fail the read.
 *
 * `sessionKey` scopes the first-record rung marker; `rung` is the resolved ladder source.
 */
export function recordProviderFailure(
  entry: ProviderFailureLogEntry,
  sessionKey: string,
  rung: ConfigRung,
): void {
  const includeRung = !rungRecordedSessions.has(sessionKey);
  if (includeRung) rungRecordedSessions.add(sessionKey);
  appendRecord({ ...(includeRung ? { rung } : {}), ...entry });
}

/** Append one JSONL record. Never throws: a lost audit line must not fail the read. */
function appendRecord(fields: Record<string, unknown>): void {
  try {
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...fields,
    })}\n`;
    const path = selectionRangeLogPath();
    // SAFETY: mkdir of a path derived from the operator-owned state root with a constant suffix.
    mkdirSync(dirname(path), { recursive: true });
    adoptRetiredLogName();
    rotateIfOversize(path, Buffer.byteLength(line, "utf-8"));
    appendFileSync(path, line, "utf-8");
  } catch {
    // SAFETY: best effort — the read already served its rows (see the module WHY).
  }
}

/** Rotate BEFORE the append so one oversized record still lands in a fresh file. */
function rotateIfOversize(path: string, incomingBytes: number): void {
  let current = 0;
  try {
    current = statSync(path).size;
  } catch {
    // SAFETY: an absent log is the first-run state, not a fault.
    return;
  }
  if (current + incomingBytes <= SELECTION_RANGE_LOG_MAX_BYTES) return;
  renameSync(path, `${path}.1`);
}
