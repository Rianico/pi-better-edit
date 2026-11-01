/**
 * The read-expansion audit sink — the trajectory record for applied and refused widening.
 *
 * WHY its own file beside `diagnostics.log`: expansion outcomes are expected events, not failures,
 * and a queryable "what widened, and what did not, and why" belongs in its own JSONL stream. The
 * placement and rotation policy are deliberately the diagnostics one: `<stateRoot>/read-expansion.log`
 * with one rotated generation, so an operator can attach the pair whole.
 *
 * WHY failure-paths-only writes: a plain read with no expansion never records anything. Only an
 * expansion attempt — applied or refused — appends a record, so the file stays proportional to the
 * feature's use instead of every tool call.
 *
 * WHY the first record of a session carries `rung`: recording the resolved ladder source once per
 * session makes the effective policy visible without repeating it on every line. Later records omit
 * it. The rung is required, so a new caller cannot silently stamp the wrong value.
 *
 * The refusal vocabulary lives in `docs/agents/read-expansion-replay.md#refusal-vocabulary`.
 *
 * WHY nothing here may throw: an audit write is best effort. A sink failure must never turn a read
 * that already served its rows into a failed call.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "../config-dir.js";
import type { ConfigRung } from "../json-config.js";

/** Fixed file name inside `stateRoot()`; exported so tests and status readers agree on it. */
export const READ_EXPANSION_LOG_NAME = "read-expansion.log";

/** One rotated generation, matching the diagnostics sink's ceiling. */
export const READ_EXPANSION_LOG_MAX_BYTES = 1024 * 1024;

interface ReadExpansionWindow {
  readonly startLine: number;
  readonly endLine: number;
}

/** One expansion attempt: applied, or refused with the reason the caller must be able to audit. */
export interface ReadExpansionLogEntry {
  readonly file: string;
  readonly mode: "served" | "verbatim";
  readonly outcome: "applied" | "refused";
  /** Every requested window folded into this attempt. */
  readonly requested: readonly ReadExpansionWindow[];
  readonly served?: ReadExpansionWindow;
  /** The provider's full structural extent, when known (the Markdown section for a clamp). */
  readonly section?: ReadExpansionWindow;
  readonly label?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly source?: string;
  readonly clamped?: boolean;
  /** Grammar language, when the refusal is about one. */
  readonly language?: string;
  /** Full block size for an over-cap refusal. */
  readonly blockSize?: number;
  readonly reason?: string;
}

/** `<stateRoot>/read-expansion.log` — a sibling of `diagnostics.log`. */
export function readExpansionLogPath(): string {
  // SAFETY: join of trusted stateRoot with a fixed file name — constant suffix, no traversal.
  return join(stateRoot(), READ_EXPANSION_LOG_NAME);
}

/** Test helper: forget which sessions already recorded their rung, absence or toggle. */
export function resetReadExpansionLogStateForTests(): void {
  rungRecordedSessions.clear();
  runtimeAbsentSessions.clear();
  toggleOffSessions.clear();
}

let rungRecordedSessions = new Set<string>();
let runtimeAbsentSessions = new Set<string>();
let toggleOffSessions = new Set<string>();
/**
 * Append one attempt. Never throws: a lost audit record must not fail the read.
 *
 * `sessionKey` scopes the first-record rung marker; `rung` is the resolved ladder source.
 */
export function recordReadExpansion(
  entry: ReadExpansionLogEntry,
  sessionKey: string,
  rung: ConfigRung,
): void {
  const includeRung = !rungRecordedSessions.has(sessionKey);
  if (includeRung) rungRecordedSessions.add(sessionKey);
  appendRecord({ ...(includeRung ? { rung } : {}), ...entry });
}

/**
 * Record the optional wasm runtime's absence once per session. Later reads stay silent, so a
 * missing module is visible without one line per grammar-backed read.
 */
export function recordReadExpansionRuntimeAbsent(
  entry: ReadExpansionLogEntry,
  sessionKey: string,
  rung: ConfigRung,
): void {
  if (runtimeAbsentSessions.has(sessionKey)) return;
  runtimeAbsentSessions.add(sessionKey);
  recordReadExpansion(entry, sessionKey, rung);
}

/** Record one `toggle_off` refusal per session; off reads stay cheap and do not flood. */
export function recordReadExpansionToggleOff(
  entry: ReadExpansionLogEntry,
  sessionKey: string,
  rung: ConfigRung,
): void {
  if (toggleOffSessions.has(sessionKey)) return;
  toggleOffSessions.add(sessionKey);
  recordReadExpansion(entry, sessionKey, rung);
}

/** Append one JSONL record. Never throws: a lost audit line must not fail the read. */
function appendRecord(fields: Record<string, unknown>): void {
  try {
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...fields,
    })}\n`;
    const path = readExpansionLogPath();
    // SAFETY: mkdir of a path derived from the operator-owned state root with a constant suffix.
    mkdirSync(dirname(path), { recursive: true });
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
  if (current + incomingBytes <= READ_EXPANSION_LOG_MAX_BYTES) return;
  renameSync(path, `${path}.1`);
}
