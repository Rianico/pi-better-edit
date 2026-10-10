/**
 * SAFETY: MutationEngine types — typed boundary for the deep mutation seam.
 *
 * Vocabulary: range, span, served span, drift, drift notice, payload contract
 * — see CONTEXT.md.
 */

import type { LineEnding } from "../edit-diff.js";
import type { ResolvedRange } from "../hashline/served.js";
import type { HashStore } from "../hash-store.js";
import type { BatchSection, EditDetails, RMetrics } from "../edit-response.js";
import type { NormalizedEditRequest } from "../payload-contract.js";
import type { DomainErrorCode, RangeCause } from "../domain-errors.js";
import type { ServedRow } from "../domain-errors.js";

// WHY: Re-export pipeline-facing options — validated once at admission (edit.ts),
// WHY: trusted inside the engine. No `any`.
export interface PipelineOptions {
  accessMode?: number;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
  sessionKey?: string;
  /**
   * TEST-ONLY fault-injection seam (ticket-04b §3): invoked inside a foreign-source cut transaction
   * AFTER the target insert is durably committed and BEFORE the source retirement rename. A
   * throw here lands inside the two-rename window, which is exactly the half-applied state the
   * intent record and next-run repair must resolve.
   */
  onCutBetweenWrites?: (committedAbsolutePath: string) => void | Promise<void>;
  /**
   * TEST-ONLY observation seam (ticket-04b remediation-2 R2): invoked inside a foreign-source cut
   * transaction BEFORE the first rename, while no byte of the transaction has landed. The rule
   * under test is write-AHEAD: the intent record must already be durable at the moment of the
   * first mutation — an existence check taken inside the window cannot show that.
   */
  onBeforeFirstCutWrite?: () => void | Promise<void>;
}

/**
 * (ticket-04b) One foreign `mode: "cut"` item as seen by the pre-pass: the submitted span anchors
 * in the named file. The target call materializes the span bytes to a literal; the matching
 * retirement runs as a first-class edit against THIS file (its own load, lease verification,
 * batch gate, undo, and store commit) inside the same transaction.
 */
export interface ForeignCutRecord {
  refFile: string;
  absolutePath: string;
  spanFrom: string;
  spanTo: string;
}

// WHY: Internal: the engine's view of one file's mutation outcome.
// WHY: Mirrors `ProcessedEditFile` from the old pipeline — kept here as the engine's owned fact.
export interface ProcessedEditFile {
  path: string;
  absolutePath: string;
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: LineEnding;
  warnings: string[];
  originalHashes: string[];
  resultHashes: string[];
  /**
   * The working buffer's line identity for `result`, indexed by line (entry `i` is line `i + 1`),
   * `null` for a line this batch created. The post-write commit persists it verbatim (spec §3.2.4
   * step 1) so surviving lines keep their exact `line_id` without re-pairing against S_latest.
   */
  resultLineIds: (number | null)[];
  /**
   * Legacy v6 blocked-hashes payload for this batch: the union of every applied item's removed
   * hashes. Applied once, after `writeAtomic` succeeds (spec §3.2.4 step 4), so a batch that
   * writes nothing retires nothing. In-memory only until the post-write commit persists it.
   */
  removedHashes: ReadonlySet<string>;
  appliedCount: number;
  noopCount: number;
  totalAddedLines: number;
  totalRemovedLines: number;
  driftNotice: string | undefined;
  /**
   * Union of the call's edited intervals. A lone insertion publishes the zero-width inverted
   * form (`startLine = point + 1 > endLine = point`, the ticket-01 drift contract): do NOT
   * normalize it to a width-1 range — an insertion mutates no line, and fabricating a width
   * would claim a target line that survives byte-identical, which the identity bookkeeping
   * and the drift `deltaBefore` arithmetic both rely on.
   */
  range: ResolvedRange;
  editedIntervals: ResolvedRange[];
  literalDeclarations: number;
  /**
   * (ticket-04b) The foreign `mode: "cut"` items this call materialized, in submission order.
   * Empty unless the request carried a foreign-source cut. `apply()` turns a non-empty set into a
   * correlated two-file transaction; the in-memory buffer itself never touches these files.
   */
  foreignCuts: ForeignCutRecord[];
}

// WHY: Discriminated success/failure for the deep seam.
// WHY: Callers use exhaustive switch on `ok` — no `isError` flag checks,
// WHY: no `any` threading.
export interface MutationSuccess {
  ok: true;
  /** SAFETY: Normalized result content (LF). */
  result: string;
  /** SAFETY: Unified diff (hash-anchored) for model consumption. */
  diff: string;
  /** SAFETY: User-facing drift notice, if any (details only, not model content). */
  drift: string | undefined;
  /** SAFETY: Metrics for telemetry. */
  metrics: RMetrics;
  raw: ProcessedEditFile;
  /** SAFETY: Full tool result (content + details) for pi's tool_result hook. */
  toolResult: {
    content: Array<{ type: "text"; text: string }>;
    details: EditDetails;
  };
}

export interface MutationFailure {
  ok: false;
  /**
   * SAFETY: Machine code — a registry member (`DomainErrorCode`). `toFailure` validates every
   * caught code through the envelope reader (`src/error-envelope.ts`): non-registry strings
   * (errno pass-through included) route to `E_UNKNOWN`, so the union is honest.
   */
  code: DomainErrorCode;
  /** SAFETY: Human message — model-facing signal when applicable. */
  message: string;
  /** SAFETY: Fresh served block for retry when available (reject-and-serve). */
  servedBlock?: string;
  servedRows?: ServedRow[];
  /**
   * SAFETY: the RAW `E_BAD_PAYLOAD` message behind a rendered refusal, when the route is one, so
   * SAFETY: the tool seam can name the invoking tool instead of falling back to the neutral
   * SAFETY: wording. Present only for `code: "E_BAD_PAYLOAD"`.
   */
  payloadMessage?: string;
  /** SAFETY: User-facing diagnosis, never a model remedy — a CONTEXT.md glossary term. */
  cause?: RangeCause;
  details?: { code: DomainErrorCode; cause: RangeCause };
}

export type MutationResult = MutationSuccess | MutationFailure;

// WHY: Narrowing helpers — keep call sites exhaustive.
export function isMutationSuccess(r: MutationResult): r is MutationSuccess {
  return r.ok === true;
}

export function isMutationFailure(r: MutationResult): r is MutationFailure {
  return r.ok === false;
}

// WHY: Also re-export batch section for callers that build tool results.
export type { BatchSection, NormalizedEditRequest };
