/**
 * The note's failure sink — the trajectory record for provider lookups that failed.
 * WHY its own file beside `diagnostics.log`: placement and rotation are that sink's policy —
 * `<stateRoot>/selection-range.log`, one rotated generation — because a failed lookup is an expected
 * event, not a diagnostic failure, and it deserves its own queryable JSONL stream.
 * WHY the retired `read-expansion.log` name is ADOPTED: a rename must not orphan the log that explains
 * a reported bug, so each generation moves only while its new path is absent (`MOVED_ARTIFACTS`).
 * WHY failures only: an ordinary read writes no row, so the file tracks defects, not every call.
 * WHY `rung` on a session's first record only: it is required, so no caller can stamp it wrong.
 * The refusal vocabulary: `docs/agents/selection-note-replay.md#refusal-vocabulary`.
 * WHY nothing here may throw: a sink failure must never turn a served read into a failed call.
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
  // WHY: join of trusted stateRoot with a fixed file name — constant suffix, no traversal.
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
      // WHY: best effort — the append this precedes still succeeds, and the old pair stays readable under its retired name.
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
    mkdirSync(dirname(path), { recursive: true });
    adoptRetiredLogName();
    rotateIfOversize(path, Buffer.byteLength(line, "utf-8"));
    appendFileSync(path, line, "utf-8");
  } catch {
    // WHY: best effort — the read already served its rows (see the module WHY).
  }
}

/** Rotate BEFORE the append so one oversized record still lands in a fresh file. */
function rotateIfOversize(path: string, incomingBytes: number): void {
  let current = 0;
  try {
    current = statSync(path).size;
  } catch {
    // WHY: an absent log is the first-run state, not a fault.
    return;
  }
  if (current + incomingBytes <= SELECTION_RANGE_LOG_MAX_BYTES) return;
  renameSync(path, `${path}.1`);
}
