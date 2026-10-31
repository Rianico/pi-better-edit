/**
 * The read-expansion audit sink — the trajectory record for applied and refused widening.
 *
 * WHY its own file beside `diagnostics.log`: expansion outcomes are expected events, not failures,
 * and a queryable "what widened, and what did not, and why" belongs in its own JSONL stream. The
 * placement and rotation policy are deliberately the diagnostics one: `<stateRoot>/expansion-audit.log`
 * with one rotated generation, so an operator can attach the pair whole.
 *
 * WHY failure-paths-only writes: a plain read with no expansion never records anything. Only an
 * expansion attempt — applied or refused — appends a record, so the file stays proportional to the
 * feature's use instead of every tool call.
 *
 * WHY nothing here may throw: an audit write is best effort. A sink failure must never turn a read
 * that already served its rows into a failed call.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "../config-dir.js";

/** Fixed file name inside `stateRoot()`; exported so tests and status readers agree on it. */
export const EXPANSION_AUDIT_LOG_NAME = "expansion-audit.log";

/** One rotated generation, matching the diagnostics sink's ceiling. */
const EXPANSION_AUDIT_LOG_MAX_BYTES = 1024 * 1024;

interface ExpansionAuditRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** One expansion attempt: applied, or refused with the reason the caller must be able to audit. */
export interface ExpansionAuditEntry {
  readonly file: string;
  readonly mode: "served" | "verbatim";
  readonly outcome: "applied" | "refused";
  /** Every requested range folded into this attempt. */
  readonly asked: readonly ExpansionAuditRange[];
  readonly served?: ExpansionAuditRange;
  /** The provider's full structural extent, when known (the Markdown section for a clamp). */
  readonly section?: ExpansionAuditRange;
  readonly label?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly source?: string;
  readonly clamped?: boolean;
  readonly reason?: string;
}

/** `<stateRoot>/expansion-audit.log` — a sibling of `diagnostics.log`. */
export function expansionAuditLogPath(): string {
  // SAFETY: join of trusted stateRoot with a fixed file name — constant suffix, no traversal.
  return join(stateRoot(), EXPANSION_AUDIT_LOG_NAME);
}

/** Append one attempt. Never throws: a lost audit record must not fail the read. */
export function recordExpansionAudit(entry: ExpansionAuditEntry): void {
  try {
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...entry,
    })}\n`;
    const path = expansionAuditLogPath();
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
  if (current + incomingBytes <= EXPANSION_AUDIT_LOG_MAX_BYTES) return;
  renameSync(path, `${path}.1`);
}
