/**
 * Read expansion — the one seam between `read` and any boundary parser.
 *
 * `read` asks a provider for the structural block that encloses each small requested window. The
 * provider answers with 1-indexed line bounds or null, and this module owns every invariant that
 * makes the answer safe to serve:
 *
 * - the widened window is a superset of the requested window;
 * - it never exceeds the cap for its source (code vs Markdown/plain text);
 * - only a requested window at or below `TRIGGER_MAX` is a candidate;
 * - overlapping or adjacent answers become one ascending run, so every row is served once;
 * - any doubt (bad bounds, non-text provider answer, a throwing provider) yields null.
 *
 * WHY a seam: parsers are optional and arrive per language, while the read path must stay free of
 * grammar, wasm, network and language-server concerns. With no provider injected (`regRead(pi)`),
 * this module is never entered and the served output is exactly today's.
 */
import { mergeServedSpans } from "../served-spans.js";

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
}

/**
 * Only a requested window at or below this size triggers expansion. A 24-line probe is still a
 * fragment; a larger ask is already a deliberate range, so widening it would add cost without
 * answering a second-turn question.
 */
export const TRIGGER_MAX = 24;

/** Code scopes may widen further than prose: a function or method is the block a reader asked for. */
export const SPAN_CAP_CODE = 80;

/** A Markdown section or plain-text paragraph stays proportionate at a smaller ceiling. */
export const SPAN_CAP_MD_TEXT = 40;

/** One 1-indexed inclusive line range. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/** One widening: the served block plus what the reader actually asked for. */
export interface Expansion {
  /** The window the read will walk: the provider's span, never beyond its source cap. */
  window: OffsetWindow;
  /** The boundary identity and the requested range it answered. */
  record: {
    kind: string;
    name: string;
    source: SpanSource;
    asked: LineRange;
    span: LineRange;
  };
}

/** One merged served run and every asked window it answered. */
export interface WidenedBlock {
  served: LineRange;
  asked: LineRange[];
  kind: string;
  name: string;
  source: SpanSource;
}

/** The per-window requested-versus-served record carried in `details.widened`. */
export interface WidenedDetail {
  asked: LineRange;
  served: LineRange;
  kind: string;
  name: string;
  source: SpanSource;
}

/** The served windows after union, plus the block and per-window records the note/details owe. */
export interface ExpandedRead {
  windows: OffsetWindow[];
  blocks: WidenedBlock[];
  details: WidenedDetail[];
}

/** A widened window already validated against the file's visible line count. */
export interface ExpansionInput {
  /** The path handed to the provider; absolute and already resolved by the read path. */
  file: string;
  /** Total visible lines the read will address. */
  totalLines: number;
  window: OffsetWindow;
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
  return source === "md" || source === "text" ? SPAN_CAP_MD_TEXT : SPAN_CAP_CODE;
}

/**
 * Whether a requested window is even a candidate. The read uses this before loading the file, so a
 * large or whole-file request pays nothing for a feature it cannot use.
 */
export function isExpandableWindow(window: SpanWindow): boolean {
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

  const askedEnd = Math.min(window.offset + window.limit - 1, totalLines);
  // WHY: the superset invariant — any span that does not cover every addressable requested line is
  // WHY: a wrong answer, and a wrong answer must behave exactly like no answer.
  if (start > window.offset || end < askedEnd) return undefined;
  // WHY: refuse, never clamp (spec: a block above the cap falls back to the requested window).
  if (end - start + 1 > spanCapFor(source)) return undefined;

  return {
    window: { offset: start, limit: end - start + 1 },
    record: {
      kind: oneLine(kind),
      name: oneLine(name),
      source,
      asked: { startLine: window.offset, endLine: askedEnd },
      span: { startLine: start, endLine: end },
    },
  };
}

function rangeKey(range: LineRange): string {
  return `${range.startLine}:${range.endLine}`;
}

/**
 * Union the served windows and attach every asked window to the run that serves it.
 *
 * Returns undefined when no window widened, so the caller keeps today's exact plan and output.
 */
export function applyExpansions(
  windows: readonly OffsetWindow[],
  decisions: readonly (Expansion | undefined)[],
): ExpandedRead | undefined {
  const widened = decisions.filter((decision): decision is Expansion => decision !== undefined);
  if (widened.length === 0) return undefined;
  if (windows.length !== decisions.length) {
    throw new Error("read expansion decisions do not match the planned windows");
  }

  const served = windows.map((window, index) => {
    const decision = decisions[index];
    return decision === undefined
      ? { startLine: window.offset, lineCount: window.limit }
      : { startLine: decision.window.offset, lineCount: decision.window.limit };
  });
  const merged = mergeServedSpans(served).map((span) => ({
    startLine: span.startLine,
    endLine: span.startLine + span.lineCount - 1,
  }));
  const runFor = (window: OffsetWindow): LineRange => {
    const found = merged.find(
      (run) => window.offset >= run.startLine && window.offset + window.limit - 1 <= run.endLine,
    );
    if (found === undefined) {
      throw new Error("a widened window has no merged run");
    }
    return found;
  };

  const blocks: WidenedBlock[] = [];
  for (const run of merged) {
    const inside = widened
      .filter((decision) => {
        const start = decision.window.offset;
        const end = start + decision.window.limit - 1;
        return start >= run.startLine && end <= run.endLine;
      })
      .sort((left, right) => left.record.asked.startLine - right.record.asked.startLine);
    if (inside.length === 0) continue;
    const first = inside[0];
    if (first === undefined) continue;
    const asked = [
      ...new Map(
        inside.map((decision) => [rangeKey(decision.record.asked), decision.record.asked]),
      ).values(),
    ];
    blocks.push({
      served: run,
      asked,
      kind: first.record.kind,
      name: first.record.name,
      source: first.record.source,
    });
  }

  const details: WidenedDetail[] = widened.map((decision) => ({
    asked: decision.record.asked,
    served: runFor(decision.window),
    kind: decision.record.kind,
    name: decision.record.name,
    source: decision.record.source,
  }));

  return {
    windows: merged.map((run) => ({
      offset: run.startLine,
      limit: run.endLine - run.startLine + 1,
    })),
    blocks,
    details,
  };
}

function fmtRange(range: LineRange): string {
  return `${range.startLine}-${range.endLine}`;
}

/**
 * The model-facing note chrome.
 *
 * Up to three asked windows name every block and every asked range; more than three collapse to one
 * line naming the count and the served ranges, so a wide multi-probe read cannot flood the page.
 */
export function expansionNotes(blocks: readonly WidenedBlock[], shownRange?: LineRange): string[] {
  if (blocks.length === 0) return [];
  const totalAsked = blocks.reduce((count, block) => count + block.asked.length, 0);
  if (totalAsked > 3) {
    const ranges = blocks.map((block) => fmtRange(block.served)).join(", ");
    return [`[widened ${totalAsked} windows: ${ranges}]`];
  }
  return blocks.map((block) => {
    const servedEnd =
      blocks.length === 1 && shownRange !== undefined ? shownRange.endLine : block.served.endLine;
    const asked = block.asked.map(fmtRange).join(", ");
    return `[widened ${block.served.startLine}-${servedEnd} (asked ${asked}) ${block.kind} ${block.name}]`;
  });
}
