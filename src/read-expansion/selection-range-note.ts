/**
 * The selection-range note seam — one module decides whether a note is due and renders it.
 *
 * WHY its own module: a provider answers "what encloses this window" and nothing else, the header
 * formatter only places a finished clause, and the read path never formats note text. This module is
 * the one place those three meet, so the note cannot scatter across sources, read modes or arities.
 *
 * The note is silent in four distinct situations, and only one of them is a fault:
 *
 * - the window equals its span (nothing to add);
 * - nothing encloses the window (the provider declines);
 * - the pre-lookup gate declined it (no window, no registered provider, a whole-file window);
 * - the lookup failed (threw, timed out, or answered something invalid) — the only case that logs.
 *
 * The gate runs before any parser work: a whole-file read, a data path, and a window that covers its
 * file all reach no provider. The note is chrome — it changes no served line, holds no lease, and
 * carries no anchor.
 */
import {
  REFUSAL_REASONS,
  type OffsetWindow,
  type RefusalReason,
  type SpanAnswer,
  type SpanProvider,
  type SpanSource,
} from "./provider-contract.js";
import { providerSourceFor } from "./read-provider.js";
import { isSpanKind, spanKindLabel, type SpanKind } from "./span-kind.js";

/** A lookup this slow is treated as failed: the note is chrome and must never stall a read. */
const NOTE_LOOKUP_TIMEOUT_MS = 500;

/** How much of a span name the one-line header clause may carry. */
const NOTE_NAME_MAX = 60;

/**
 * Refusals that are faults rather than ordinary silence. A decline that answers "nothing encloses
 * this window" is the quiet case; a grammar, runtime, cold-start or malformed answer is a defect the
 * operator can act on, so only those log.
 */
const LOGGED_REFUSALS: ReadonlySet<RefusalReason> = new Set<RefusalReason>([
  "provider_error",
  "invalid_answer",
  "grammar_unavailable",
  "runtime_absent",
  "cold_grammar",
  "not_text",
]);

/** What a failed lookup owes the read path: the source to name, and the reason to record. */
interface SelectionNoteFailure {
  readonly source: SpanSource;
  readonly reason: RefusalReason;
}

/** The seam's answer: a finished clause, a failure to log, or silence. */
export interface SelectionRangeNote {
  /** The finished header clause (`; in function parse_args, lines 230-290`), absent for silence. */
  readonly clause?: string;
  readonly failure?: SelectionNoteFailure;
}

export interface SelectionRangeNoteInput {
  /** The path handed to the provider: absolute and already resolved by the read path. */
  readonly file: string;
  /** The windows this read walks, or `undefined` for a whole-file read. */
  readonly windows: readonly OffsetWindow[] | undefined;
  /** Total visible lines the read addresses. */
  readonly totalLines: number;
  readonly provider: SpanProvider | undefined;
  /** The reader's setting; `off` silences the note without any provider work. */
  readonly enabled: boolean;
  /** Test seam; the shipped lookup uses `NOTE_LOOKUP_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

const TIMED_OUT = Symbol("timed-out");

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isSpanSource(value: unknown): value is SpanSource {
  return value === "ast" || value === "md" || value === "text" || value === "lsp";
}

function isRefusalReason(value: unknown): value is RefusalReason {
  return typeof value === "string" && (REFUSAL_REASONS as readonly string[]).includes(value);
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, timeoutMs));
  });
  return Promise.race([task, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Collapse a provider-supplied name to what one header clause can carry safely. */
function sanitizeName(value: string): string {
  // WHY: a Markdown heading may legally contain brackets, and the header is one bracket grammar.
  const collapsed = value.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  return collapsed.slice(0, NOTE_NAME_MAX).trim();
}

/** The label one header clause carries: kind plus name, or kind alone where the source has no name. */
function spanLabel(kind: SpanKind, name: string, source: SpanSource): string {
  const label = spanKindLabel(kind);
  if (source === "text" || name === "") return label;
  return source === "md" ? `${label} "${name}"` : `${label} ${name}`;
}

/**
 * The pre-lookup gate: only a windowed read of a path with a registered provider, whose window is
 * smaller than its file, reaches a provider. Everything else is the ordinary no-note case.
 */
function admittedWindow(
  input: SelectionRangeNoteInput,
): { readonly window: OffsetWindow; readonly source: SpanSource } | undefined {
  if (!input.enabled || input.provider === undefined || input.totalLines < 1) return undefined;
  const windows = input.windows;
  // WHY: a multi-window page names each span on its own section, so the page carries no clause.
  if (windows === undefined || windows.length !== 1) return undefined;
  const window = windows[0];
  if (window === undefined) return undefined;
  if (!isPositiveInteger(window.offset) || !isPositiveInteger(window.limit)) return undefined;
  if (window.offset > input.totalLines) return undefined;
  const end = Math.min(window.offset + window.limit - 1, input.totalLines);
  // WHY: a window that covers its file has no larger span to name, so it is not a candidate.
  if (window.offset === 1 && end === input.totalLines) return undefined;
  const source = providerSourceFor(input.file);
  if (source === undefined) return undefined;
  return { window: { offset: window.offset, limit: end - window.offset + 1 }, source };
}

interface AdmittedSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: SpanKind;
  readonly name: string;
  readonly source: SpanSource;
}

/** The provider answer, validated into a span the clause may name; `undefined` means silence. */
function admittedSpan(answer: SpanAnswer): AdmittedSpan | undefined {
  if (answer === null || typeof answer !== "object" || "refusal" in answer) return undefined;
  const { start, end, kind, name, source } = answer;
  if (!isPositiveInteger(start) || !isPositiveInteger(end) || end < start) return undefined;
  if (!isSpanKind(kind) || typeof name !== "string" || name.trim() === "") return undefined;
  if (!isSpanSource(source)) return undefined;
  return { start, end, kind, name, source };
}

/** The finished clause for a span strictly larger than the served window. */
function renderClause(span: AdmittedSpan): string {
  return `; in ${spanLabel(span.kind, sanitizeName(span.name), span.source)}, lines ${span.start}-${span.end}`;
}

/**
 * Decide whether the served window gets a note, and render the clause when it does.
 *
 * Never throws: a provider failure degrades to silence plus one failure record for the read path.
 */
export async function selectionRangeNote(
  input: SelectionRangeNoteInput,
): Promise<SelectionRangeNote> {
  const admitted = admittedWindow(input);
  if (admitted === undefined || input.provider === undefined) return {};
  const { window, source } = admitted;

  let answer: SpanAnswer | typeof TIMED_OUT;
  try {
    answer = await withTimeout(
      Promise.resolve(input.provider.enclosingSpan(input.file, window)),
      input.timeoutMs ?? NOTE_LOOKUP_TIMEOUT_MS,
    );
  } catch {
    // SAFETY: a throwing or hanging provider must never fail a read; the note is a best effort.
    return { failure: { source, reason: "provider_error" } };
  }
  if (answer === TIMED_OUT) return { failure: { source, reason: "provider_error" } };
  if (answer === null || typeof answer !== "object") return {};
  if ("refusal" in answer) {
    if (!isRefusalReason(answer.refusal)) return { failure: { source, reason: "invalid_answer" } };
    return LOGGED_REFUSALS.has(answer.refusal)
      ? { failure: { source, reason: answer.refusal } }
      : {};
  }

  const span = admittedSpan(answer);
  if (span === undefined) return { failure: { source, reason: "invalid_answer" } };
  const windowEnd = window.offset + window.limit - 1;
  // WHY: an answer that misses the window is a wrong answer, and a wrong answer must behave
  // WHY: exactly like no answer — the served rows are already correct, so this is silence.
  if (span.start > window.offset || span.end < windowEnd) return {};
  if (span.start === window.offset && span.end === windowEnd) return {};
  return { clause: renderClause(span) };
}
