/**
 * WHY: one shared bracket grammar for page chrome (#149, read-chrome): the served read, the bash view,
 * WHY: the auto-read and every multi-window section name a page, and each seam used to freeze its own
 * WHY: punctuation — a `---` banner above a `===` sub-banner above a paging footer, three dialects on
 * WHY: one result. Both builders live here, so a header's shape has ONE definition site and the footer
 * WHY: they replaced cannot come back from a call site.
 */
import { formatSize } from "@earendil-works/pi-coding-agent";

/** The lines a page rendered, 1-based and inclusive. */
interface RenderedRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** One page's identity: what was shown, of which file, and why the page stopped (spec §4.4). */
export interface PageHeader {
  /** Which seam produced the page (`Auto-read`, `Bash view`); absent for a plain read. */
  readonly label?: string;
  /** The file as the caller named it. */
  readonly file: string;
  /** The file's total visible line count — never the requested count. */
  readonly totalLines: number;
  /**
   * The lines this page actually rendered, absent when it showed none (empty file, beyond EOF, a page
   * of only warnings). A range covering the whole file is dropped as well: the count already states
   * it, and a whole-file page is the only thing a bare count can mean.
   */
  readonly shownRange?: RenderedRange;
  /** The only mode marker: a verbatim page serves no anchors. */
  readonly verbatim?: boolean;
  /** The byte budget a page stopped at, set only when truncation cut by bytes. */
  readonly stoppedAtBytes?: number;
}

/** WHY: `stopped at` names the budget the page stopped under, so the model can size its next ask. */
function stopSuffix(stoppedAtBytes: number | undefined): string {
  return stoppedAtBytes === undefined ? "" : `; stopped at ${formatSize(stoppedAtBytes)}`;
}

/** WHY: a range that covers every line restates the total, so a whole-file page prints the count alone. */
function rangeOf(shown: RenderedRange | undefined, totalLines: number): string {
  if (shown === undefined || (shown.startLine === 1 && shown.endLine === totalLines)) {
    return `${totalLines} lines total`;
  }
  return `lines ${shown.startLine}-${shown.endLine} of ${totalLines} total`;
}

/**
 * The page header: `[file (40 lines total)]`, `[file (lines 1-5 of 40 total)]`, with an optional
 * `verbatim` marker and `stopped at` suffix — and, for the bash seams, a `Auto-read: ` / `Bash view: `
 * label inside the bracket so the page and its provenance are one line.
 */
export function formatPageHeader(parts: PageHeader): string {
  const count = rangeOf(parts.shownRange, parts.totalLines);
  const body = parts.verbatim === true ? `verbatim, ${count}` : count;
  const label = parts.label === undefined ? "" : `${parts.label}: `;
  return `[${label}${parts.file} (${body}${stopSuffix(parts.stoppedAtBytes)})]`;
}

/**
 * WHY: a multi-window read is N pages in one result, so each section names its own range; a
 * WHY: single-window page needs no section header because its page header already named it.
 */
export function formatSectionHeader(
  startLine: number,
  endLine: number,
  totalLines: number,
  stoppedAtBytes?: number,
): string {
  return `[Lines ${startLine}-${endLine} of ${totalLines} total${stopSuffix(stoppedAtBytes)}]`;
}
