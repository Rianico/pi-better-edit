/**
 * Read expansion — the one seam between `read` and any boundary parser.
 *
 * `read` asks a provider for the structural block that encloses a small requested window. The
 * provider answers with 1-indexed line bounds or null, and this module owns every invariant that
 * makes the answer safe to serve:
 *
 * - the widened window is a superset of the requested window;
 * - it never exceeds `SPAN_CAP` lines (a larger block is refused, never clamped);
 * - only a requested window at or below `TRIGGER_MAX` is a candidate;
 * - any doubt (bad bounds, non-text provider answer, a throwing provider) yields null.
 *
 * WHY a seam: parsers are optional and arrive per language, while the read path must stay free of
 * grammar, wasm, network and language-server concerns. With no provider injected (`regRead(pi)`),
 * this module is never entered and the served output is exactly today's.
 */

/** Where a boundary came from. `lsp` is optional enrichment; it never widens on its own. */
type SpanSource = "ast" | "md" | "text" | "lsp";

/** A structural block, in the reader's 1-indexed inclusive line terms. */
interface EnclosingSpan {
  start: number;
  end: number;
  kind: string;
  name: string;
  source: SpanSource;
}

/** One requested line window, in the reader's 1-indexed terms. */
export interface SpanWindow {
  offset: number;
  limit: number;
}

/**
 * The boundary provider seam. A provider may answer synchronously now and asynchronously once a
 * grammar has to be fetched, so the read path always awaits it.
 */
export interface SpanProvider {
  enclosingSpan(
    file: string,
    window: SpanWindow,
  ): EnclosingSpan | null | Promise<EnclosingSpan | null>;
}

/**
 * Only a requested window at or below this size triggers expansion. Tighter than the 100-line
 * trigger used elsewhere: a probe already naming a large range is not a fragment, so widening it
 * would add cost without answering a second-turn question.
 */
export const TRIGGER_MAX = 40;

/**
 * The widened block's hard ceiling. A block above it is refused, not clamped — a clamp would serve
 * a block that is neither the requested window nor the structural unit. Tighter than the 300-line
 * cap used elsewhere because measured dilation reached 16x.
 */
export const SPAN_CAP = 200;

/** The request a widening answered: the widened window plus the record the read carries. */
export interface Expansion {
  /** The window the read will walk: the provider's span, never beyond `SPAN_CAP` lines. */
  window: SpanWindow;
  /** The boundary identity, plus requested versus served line terms. */
  record: ExpansionRecord;
}

/** One widening's machine-readable identity and requested line terms. */
export interface ExpansionRecord {
  kind: string;
  name: string;
  source: SpanSource;
  requested: SpanWindow;
  /** The structural block the provider named. */
  span: { startLine: number; endLine: number };
}

/** A widened window already validated against the file's visible line count. */
export interface ExpansionInput {
  /** The path handed to the provider; absolute and already resolved by the read path. */
  file: string;
  /** Total visible lines the read will address. */
  totalLines: number;
  window: SpanWindow;
  provider: SpanProvider;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSpanSource(value: unknown): value is SpanSource {
  return value === "ast" || value === "md" || value === "text" || value === "lsp";
}

/** Collapse a provider-supplied name to what a one-line note can carry. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Whether a requested window is even a candidate. The read uses this before loading the file, so a
 * large or whole-file request pays nothing for a feature it cannot use.
 */
export function isExpandableWindow(window: SpanWindow): boolean {
  return (
    isPositiveInteger(window.offset) &&
    isPositiveInteger(window.limit) &&
    window.limit <= TRIGGER_MAX
  );
}

/**
 * Ask the provider for the block enclosing `window` and return the widened window, or undefined
 * when the answer cannot be served.
 *
 * WHY every check is here rather than in the provider: one seam carries the invariants, so a new
 * language cannot forget one, and a wrong provider answer degrades to today's exact read.
 */
export async function widenWindow(input: ExpansionInput): Promise<Expansion | undefined> {
  const { file, totalLines, window, provider } = input;
  if (!isExpandableWindow(window)) return undefined;
  if (!Number.isInteger(totalLines) || totalLines < 1) return undefined;
  if (window.offset > totalLines) return undefined;

  let answer: EnclosingSpan | null;
  try {
    answer = await provider.enclosingSpan(file, { offset: window.offset, limit: window.limit });
  } catch {
    // SAFETY: a parser/provider failure is "no boundary", never a failed read (spec user story 10).
    return undefined;
  }
  if (answer === null || typeof answer !== "object") return undefined;
  const { start, end, kind, name, source } = answer as Partial<EnclosingSpan>;
  if (!isPositiveInteger(start) || !isPositiveInteger(end) || end < start) return undefined;
  if (!isNonEmptyText(kind) || !isNonEmptyText(name) || !isSpanSource(source)) return undefined;
  if (end > totalLines) return undefined;

  const requestedEnd = Math.min(window.offset + window.limit - 1, totalLines);
  // WHY: the superset invariant — any span that does not cover every addressable requested line is
  // WHY: a wrong answer, and a wrong answer must behave exactly like no answer.
  if (start > window.offset || end < requestedEnd) return undefined;
  // WHY: refuse, never clamp (spec: a block above the cap falls back to the requested window).
  if (end - start + 1 > SPAN_CAP) return undefined;

  return {
    window: { offset: start, limit: end - start + 1 },
    record: {
      kind: oneLine(kind),
      name: oneLine(name),
      source,
      requested: { offset: window.offset, limit: window.limit },
      span: { startLine: start, endLine: end },
    },
  };
}

/** The one model-facing note line: boundary kind, name, and the served line range. */
export function expansionNote(record: ExpansionRecord, servedEnd?: number): string {
  const end = servedEnd ?? record.span.endLine;
  return `[Read widened: ${record.kind} "${record.name}"; served lines ${record.span.startLine}-${end}]`;
}
