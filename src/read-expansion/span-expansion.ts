/**
 * Read expansion — the one seam between `read` and any boundary parser.
 *
 * `read` folds the requested windows, requests the structural block enclosing each
 * folded span, and this module owns every invariant that makes the answer safe to serve:
 *
 * - the widened window is a superset of the requested window;
 * - it never exceeds the cap for its source (80 code, 80 Markdown, 40 plain text);
 * - Markdown is the one clamp: an over-cap section serves a cap-sized window containing the
 *   names the full section extent; code and plain text are refused instead;
 * - only a folded requested span at or below `TRIGGER_MAX` is a candidate;
 * - overlapping or adjacent answers become one ascending run, so every row is served once;
 * - any doubt (bad bounds, non-text provider answer, a throwing provider) yields a refusal.
 *
 * WHY a seam: parsers are optional and arrive per language, while the read path must stay free of
 * grammar, wasm, network and language-server concerns. With no provider injected (`regRead(pi)`),
 * this module is never entered and the served output is exactly today's.
 */
import { mergeServedSpans } from "../served-spans.js";

/** Where a boundary came from. `lsp` is optional enrichment; it never widens on its own. */
type SpanSource = "ast" | "md" | "text" | "lsp";

/** A structural block the provider answered, in 1-indexed inclusive line terms. */
interface EnclosingSpan {
  start: number;
  end: number;
  kind: string;
  name: string;
  source: SpanSource;
}

/** An admitted offset window, in the reader's 1-indexed terms. */
export interface OffsetWindow {
  offset: number;
  limit: number;
}

/** An admitted anchor window. `read` resolves it through admission before widening. */
interface AnchorWindow {
  around_anchor: string;
  radius: number;
}

/** The window shape the seam accepts; `read` delegates anchor resolution to admission. */
export type SpanWindow = OffsetWindow | AnchorWindow;

/**
 * The boundary provider seam. A provider may answer synchronously now and asynchronously once a
 * grammar has to be fetched, so the read path always awaits it. `around_anchor` windows reach the
 * provider already resolved to an offset window by `read` admission; the union documents the shape
 * both sides share.
 */
export interface SpanProvider {
  enclosingSpan(
    file: string,
    window: SpanWindow,
  ): EnclosingSpan | null | Promise<EnclosingSpan | null>;
  /** Set once an AST attempt found the optional wasm runtime unavailable. */
  readonly runtimeAbsent?: boolean;
}

/**
 * Only a folded requested span at or below this size triggers expansion. Folding happens first, so
 * sixteen adjacent 24-line windows are one 384-line span and refuse the trigger.
 */
export const TRIGGER_MAX = 24;

/** Code scopes may widen to a function or method; this ceiling is refused, never clamped. */
export const SPAN_CAP_CODE = 80;

/** Markdown sections clamp to a cap-sized window that still contains the requested window. */
export const SPAN_CAP_MARKDOWN = 80;

/** Plain-text paragraphs refuse above their smaller ceiling. */
export const SPAN_CAP_TEXT = 40;

/** One 1-indexed inclusive line range. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/** Why an expansion attempt did not widen. */
type RefusalReason =
  | "above_trigger"
  | "past_eof"
  | "not_text"
  | "provider_declined"
  | "provider_error"
  | "invalid_answer"
  | "not_superset"
  | "over_cap";

/** The provider identity a refused attempt may still name (over-cap and non-superset answers). */
interface RefusedBoundary {
  span?: LineRange;
  kind?: string;
  name?: string;
  source?: SpanSource;
}

/** One widening: the served window plus the full structural extent and every requested window. */
export interface Expansion {
  /** The window the read will walk; for a Markdown clamp this is the cap-sized slice. */
  window: OffsetWindow;
  /** The boundary identity, the full extent, and the requested windows it answered. */
  record: {
    kind: string;
    name: string;
    source: SpanSource;
    requested: LineRange[];
    /** The provider's full block; for Markdown this is the section extent, which may exceed served. */
    span: LineRange;
    /** True only for the Markdown over-cap clamp. */
    clamped?: true;
  };
}

/** One expansion decision: applied, or refused for an auditable reason. */
export type ExpansionDecision =
  | { outcome: "applied"; expansion: Expansion }
  | ({ outcome: "refused"; reason: RefusalReason } & RefusedBoundary);

/** One merged served run and every requested window it answered. */
export interface WidenedBlock {
  served: LineRange;
  requested: LineRange[];
  kind: string;
  name: string;
  source: SpanSource;
  /** The full Markdown section extent, when the block came from Markdown. */
  section?: LineRange;
}

/** The served windows after union, plus the block records the note owes. */
export interface ExpandedRead {
  windows: OffsetWindow[];
  blocks: WidenedBlock[];
}

/** One folded request: the merged span, and the original requested windows that folded into it. */
export interface FoldedWindow {
  window: OffsetWindow;
  requested: LineRange[];
}

/** A widened window already validated against the file's visible line count. */
export interface ExpansionInput {
  /** The path handed to the provider; absolute and already resolved by the read path. */
  file: string;
  /** Total visible lines the read will address. */
  totalLines: number;
  /** The folded window sent to the provider. */
  window: OffsetWindow;
  /** The original requested windows that folded into this fold. */
  requested?: readonly LineRange[];
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

function isOffsetWindow(window: SpanWindow): window is OffsetWindow {
  return "offset" in window && "limit" in window;
}

/** Collapse a provider-supplied name to what a one-line note can carry. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function spanCapFor(source: SpanSource): number {
  if (source === "text") return SPAN_CAP_TEXT;
  if (source === "md") return SPAN_CAP_MARKDOWN;
  return SPAN_CAP_CODE;
}

function fmtRange(range: LineRange): string {
  return `${range.startLine}-${range.endLine}`;
}

function rangeKey(range: LineRange): string {
  return `${range.startLine}:${range.endLine}`;
}

/**
 * Whether a requested window is even a candidate. The read uses this before loading the file, so a
 * large or whole-file request pays nothing for a feature it cannot use.
 */
function isExpandableWindow(window: SpanWindow): boolean {
  if (isOffsetWindow(window)) {
    return (
      isPositiveInteger(window.offset) &&
      isPositiveInteger(window.limit) &&
      window.limit <= TRIGGER_MAX
    );
  }
  return (
    isNonEmptyText(window.around_anchor) &&
    isPositiveInteger(window.radius) &&
    // WHY: the resolved offset window is `line ± radius`, so its size is `2 * radius + 1`.
    window.radius * 2 + 1 <= TRIGGER_MAX
  );
}

/**
 * Fold overlapping or adjacent requested windows before the trigger test.
 *
 * WHY before: the trigger bounds the whole request, not each probe. Sixteen adjacent 24-line windows
 * are one 384-line request and must not expand, or a multi-window call could multiply the cost by
 * the window count.
 */
export function foldWindows(windows: readonly OffsetWindow[]): FoldedWindow[] {
  const runs = mergeServedSpans(
    windows.map((window) => ({ startLine: window.offset, lineCount: window.limit })),
  );
  return runs.map((run) => {
    const start = run.startLine;
    const end = run.startLine + run.lineCount - 1;
    const requested = windows
      .filter((window) => window.offset >= start && window.offset + window.limit - 1 <= end)
      .map((window) => ({
        startLine: window.offset,
        endLine: window.offset + window.limit - 1,
      }))
      .sort((left, right) => left.startLine - right.startLine);
    return {
      window: { offset: start, limit: run.lineCount },
      requested,
    };
  });
}

function normalizeRequested(ranges: readonly LineRange[], totalLines: number): LineRange[] {
  const seen = new Set<string>();
  const normalized: LineRange[] = [];
  for (const range of ranges) {
    if (!isPositiveInteger(range.startLine) || !isPositiveInteger(range.endLine)) continue;
    const endLine = Math.min(range.endLine, totalLines);
    if (range.startLine > endLine) continue;
    const value = { startLine: range.startLine, endLine };
    const key = rangeKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized.sort((left, right) => left.startLine - right.startLine);
}

function refused(reason: RefusalReason, boundary?: RefusedBoundary): ExpansionDecision {
  return {
    outcome: "refused",
    reason,
    ...(boundary?.span === undefined ? {} : { span: boundary.span }),
    ...(boundary?.kind === undefined ? {} : { kind: boundary.kind }),
    ...(boundary?.name === undefined ? {} : { name: boundary.name }),
    ...(boundary?.source === undefined ? {} : { source: boundary.source }),
  };
}

/**
 * Ask the provider for the block enclosing `window` and return the applied or refused decision.
 *
 * WHY every check is here rather than in the provider: one seam carries the invariants, so a new
 * language cannot forget one, and a wrong provider answer degrades to today's exact read.
 */
export async function widenWindow(input: ExpansionInput): Promise<ExpansionDecision> {
  const { file, totalLines, window, provider } = input;
  if (!isExpandableWindow(window)) return refused("above_trigger");
  if (!Number.isInteger(totalLines) || totalLines < 1 || window.offset > totalLines) {
    return refused("past_eof");
  }

  let answer: EnclosingSpan | null;
  try {
    answer = await provider.enclosingSpan(file, { offset: window.offset, limit: window.limit });
  } catch {
    // SAFETY: a parser/provider failure is "no boundary", never a failed read (spec user story 10).
    return refused("provider_error");
  }
  if (answer === null || typeof answer !== "object") return refused("provider_declined");
  const { start, end, kind, name, source } = answer as Partial<EnclosingSpan>;
  if (!isPositiveInteger(start) || !isPositiveInteger(end) || end < start) {
    return refused("invalid_answer");
  }
  if (!isNonEmptyText(kind) || !isNonEmptyText(name) || !isSpanSource(source)) {
    return refused("invalid_answer");
  }
  const boundary = {
    span: { startLine: start, endLine: end },
    kind: oneLine(kind),
    name: oneLine(name),
    source,
  };
  if (end > totalLines) return refused("invalid_answer", boundary);

  const requestedEnd = Math.min(window.offset + window.limit - 1, totalLines);
  // WHY: the superset invariant — any span that does not cover every addressable requested line is
  // WHY: a wrong answer, and a wrong answer must behave exactly like no answer.
  if (start > window.offset || end < requestedEnd) return refused("not_superset", boundary);

  const requested = normalizeRequested(
    input.requested ?? [{ startLine: window.offset, endLine: requestedEnd }],
    totalLines,
  );
  const cap = spanCapFor(source);
  const fullLength = end - start + 1;
  if (fullLength > cap) {
    // WHY: Markdown is the one clamp in the feature (D15): a section above the cap serves a
    // WHY: cap-sized window that still contains the requested window, and the note names the full extent.
    if (source !== "md") return refused("over_cap", boundary);
    let servedStart = start;
    if (requestedEnd > servedStart + cap - 1) servedStart = requestedEnd - cap + 1;
    servedStart = Math.max(start, servedStart);
    const servedEnd = Math.min(servedStart + cap - 1, end);
    return {
      outcome: "applied",
      expansion: {
        window: { offset: servedStart, limit: servedEnd - servedStart + 1 },
        record: { ...boundary, requested, clamped: true },
      },
    };
  }

  return {
    outcome: "applied",
    expansion: {
      window: { offset: start, limit: fullLength },
      record: { ...boundary, requested },
    },
  };
}

/**
 * Union the served windows and attach every requested window to the run that serves it.
 *
 * `windows` is one served candidate per original request: the widened window when that request's
 * folded group applied, or the requested window when it did not. Returns undefined when no group
 * widened, so the caller keeps today's exact plan and output.
 */
export function applyExpansions(
  windows: readonly OffsetWindow[],
  expansions: readonly Expansion[],
): ExpandedRead | undefined {
  if (expansions.length === 0) return undefined;
  const merged = mergeServedSpans(
    windows.map((window) => ({ startLine: window.offset, lineCount: window.limit })),
  ).map((span) => ({
    startLine: span.startLine,
    endLine: span.startLine + span.lineCount - 1,
  }));

  const blocks: WidenedBlock[] = [];
  for (const run of merged) {
    const inside = expansions
      .filter((expansion) => {
        const start = expansion.window.offset;
        const end = start + expansion.window.limit - 1;
        return start >= run.startLine && end <= run.endLine;
      })
      .sort((left, right) => left.window.offset - right.window.offset);
    const first = inside[0];
    if (first === undefined) continue;
    const requested = [
      ...new Map(
        inside.flatMap((expansion) =>
          expansion.record.requested.map((range) => [rangeKey(range), range] as const),
        ),
      ).values(),
    ].sort((left, right) => left.startLine - right.startLine);
    blocks.push({
      served: run,
      requested,
      kind: first.record.kind,
      name: first.record.name,
      source: first.record.source,
      ...(first.record.source === "md" ? { section: first.record.span } : {}),
    });
  }

  return {
    windows: merged.map((run) => ({
      offset: run.startLine,
      limit: run.endLine - run.startLine + 1,
    })),
    blocks,
  };
}

function quoteLabel(source: SpanSource, kind: string, name: string): string {
  if (source === "md") return `${kind} "${name}"`;
  if (source === "text") return kind;
  return `${kind} ${name}`;
}

/**
 * The model-facing note chrome: `[widened <requested> -> <served>, <label>]`.
 *
 * Up to three requested windows name every block; more than three collapse to one line naming the count
 * and the served ranges. A Markdown clamp appends the full section extent when it differs.
 */
export function expansionNotes(blocks: readonly WidenedBlock[], shownRange?: LineRange): string[] {
  if (blocks.length === 0) return [];
  const totalRequested = blocks.reduce((count, block) => count + block.requested.length, 0);
  if (totalRequested > 3) {
    const ranges = blocks
      .map((block) => {
        const extent =
          block.section !== undefined &&
          (block.section.startLine !== block.served.startLine ||
            block.section.endLine !== block.served.endLine)
            ? ` (section ${fmtRange(block.section)})`
            : "";
        return `${fmtRange(block.served)}${extent}`;
      })
      .join(", ");
    return [`[widened ${totalRequested} windows: ${ranges}]`];
  }
  return blocks.map((block) => {
    const servedEnd =
      blocks.length === 1 && shownRange !== undefined ? shownRange.endLine : block.served.endLine;
    const requested = block.requested.map(fmtRange).join(", ");
    const label = quoteLabel(block.source, block.kind, block.name);
    const extent =
      block.section !== undefined &&
      (block.section.startLine !== block.served.startLine ||
        block.section.endLine !== block.served.endLine)
        ? ` (section ${fmtRange(block.section)})`
        : "";
    return `[widened ${requested} -> ${block.served.startLine}-${servedEnd}, ${label}${extent}]`;
  });
}
