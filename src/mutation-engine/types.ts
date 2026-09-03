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

// WHY: Re-export pipeline-facing options — validated once at admission (edit.ts),
// WHY: trusted inside the engine. No `any`.
export interface PipelineOptions {
  accessMode?: number;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
  sessionKey?: string;
}

// WHY: Internal: the engine's view of one file's mutation outcome.
// WHY: Mirrors `ProcessedEditFile` from the old pipeline — kept here as the
// WHY: engine's owned fact. `edit-pipeline.ts` re-exports this for compat.
export interface ProcessedEditFile {
  path: string;
  absolutePath: string;
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: LineEnding;
  hadUtf8DecodeErrors: boolean;
  warnings: string[];
  originalHashes: string[];
  resultHashes: string[];
  appliedCount: number;
  noopCount: number;
  totalAddedLines: number;
  totalRemovedLines: number;
  driftNotice: string | undefined;
  range: ResolvedRange;
  editedIntervals: ResolvedRange[];
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
  /** SAFETY: Machine code, e.g. E_BATCH_ABORT, E_STALE_ANCHOR, E_STALE_RANGE, E_SERVED_ECHO, E_NOOP_LOOP, E_EMPTY_RANGE */
  code: string;
  /** SAFETY: Human message — model-facing signal when applicable. */
  message: string;
  /** SAFETY: Fresh anchor echo for retry when available (reject-and-serve). */
  echo?: string;
  servedRows?: import("../hashline/served.js").ServedRow[];
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
