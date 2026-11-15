import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initHasher as defaultInitHasher } from "../hashline/hash-identity.js";
import {
  findServedHashEcho,
  findServedPrefixMismatches,
  buildServedWritePrefixNote,
  LITERAL_BYPASS_NOTICE,
  clearServedRefusals,
} from "../served-session/serve-render.js";
import { assertNever, splitLines } from "../utils.js";
import { denseServeRows, fmtServedRows, type ServedRow } from "../served-session/serve-render.js";
import { notifyServedSpans, servedRowsToSpans, type ServedSpan } from "../served-spans.js";
import { notifyMutatedFile } from "../mutated-files.js";
import { applySliceOps, isSliceOp } from "../bash-classifier.js";
import { resolveBashViewMode } from "../bash-view-config.js";
import { resolveBashMultiFileSettings } from "../bash-multifile-config.js";
import { pruneMissingAll as defaultPruneMissingAll } from "../snapshot-store";
import { clearUndo as defaultClearUndo } from "../edit-undo.js";
import { stripBOM, toLF } from "../edit-diff.js";
import {
  createSessionHandle,
  sessionKeyFor as defaultSessionKeyFor,
} from "../served-session/session.js";
import { snapshotHashFor } from "../snapshot-store";
import { BASH_AUTO_READ_LABEL, BASH_VIEW_LABEL, bashBanner } from "../bash-view-banner.js";
import type { Decision } from "../bash-conversion/decide.js";
import { formatPageHeader } from "../file-content/served-header.js";

async function defaultRecordDiffServes(input: {
  sessionKey: string;
  path: string;
  servedRows: import("../served-session/serve-render.js").ServedRow[];
  contentHash: string;
  resultLineCount?: number;
  firstChangedLine?: number;
  lastChangedLine?: number;
}): Promise<void> {
  await createSessionHandle(input.sessionKey, input.path).recordDiff(input.servedRows, {
    contentHash: input.contentHash,
    ...(input.resultLineCount !== undefined ? { resultLineCount: input.resultLineCount } : {}),
    ...(input.firstChangedLine !== undefined ? { firstChangedLine: input.firstChangedLine } : {}),
    ...(input.lastChangedLine !== undefined ? { lastChangedLine: input.lastChangedLine } : {}),
  });
}
import { readNormFile as defaultReadNormFile } from "../file-reader.js";
import { loadFileKindAndText as defaultLoadFileKindAndText } from "../file-kind.js";
import { toCwd as defaultToCwd } from "../paths.js";
import { resolveTarget as defaultResolveTarget } from "../fs-write.js";
import { valAccess as defaultValAccess } from "../validation.js";
import { visLines as defaultVisLines } from "../utils.js";
import { fmtReadPreview as defaultFmtReadPreview } from "../read.js";
import { runDisplayTransform as defaultRunDisplayTransform } from "../bash-display-transform.js";
import { finalizeToolResult as defaultFinalizeToolResult } from "../edit-response.js";
import { reportDiagnostic, reportInfo, reportWarning } from "../diagnostics.js";
import { DomainError } from "../domain-errors.js";
import {
  AUTO_READ_MAX,
  BASH_SEARCH_MAX_FILES,
  BASH_SEARCH_WALK_MAX_FILES,
  MAX_READ_WINDOWS,
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_TOTAL_ROWS,
  SERVED_MAX_LINES,
} from "../constants.js";
import type {
  BashFilesList,
  BashMultiSearch,
  BashMultiView,
  BashRecursiveSearch,
  BashSearch,
  BashSearchContext,
  CompoundSegment,
  ContentLine,
  DisplayTransform,
  SliceOp,
  ViewOp,
} from "../bash-classifier.js";

import type { LifecycleDeps, ToolContext, ToolResultEvent } from "./types.js";

export type { ToolContext, ToolResultEvent, LifecycleDeps } from "./types.js";

function defaultDeps(): LifecycleDeps {
  return {
    initHasher: defaultInitHasher,
    pruneMissingAll: defaultPruneMissingAll,
    clearUndo: defaultClearUndo,
    resolveTarget: defaultResolveTarget,
    toCwd: defaultToCwd,
    valAccess: defaultValAccess,
    loadFileKindAndText: defaultLoadFileKindAndText,
    readNormFile: defaultReadNormFile,
    fmtReadPreview: defaultFmtReadPreview,
    recordDiffServes: defaultRecordDiffServes,
    sessionKeyFor: defaultSessionKeyFor,
    finalizeToolResult: defaultFinalizeToolResult,
    visLines: defaultVisLines,
    runDisplayTransform: defaultRunDisplayTransform,
  };
}

/** WHY: (item 10) one `FILE:LINE:content` row of a multi-file / recursive search. The file
 * field is non-greedy, so a path that itself contains `:` still parses (`a:b.txt:3:x`). */
const MULTI_SEARCH_STDOUT_LINE = /^(.+?):(\d+):([\s\S]*)$/;

/**
 * WHY: (item 10) parse the `FILE:LINE:content` triples of a multi-file or recursive search.
 * Fails closed (`undefined`) unless EVERY row is a triple with a 1-indexed line — the same
 * all-or-nothing geometry rule `parseSearchStdout` applies — so a single-geometry row, a
 * heading, or a match count is never mistaken for the admitted shape.
 */
function parseTripleStdout(
  observed: string,
): Array<{ file: string; line: number; content: string }> | undefined {
  const lines = observed.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;
  const matches: Array<{ file: string; line: number; content: string }> = [];
  for (const text of lines) {
    const parsed = MULTI_SEARCH_STDOUT_LINE.exec(text);
    if (!parsed) return undefined;
    const line = Number(parsed[2]);
    if (!Number.isSafeInteger(line) || line < 1) return undefined;
    matches.push({ file: parsed[1] ?? "", line, content: parsed[3] ?? "" });
  }
  return matches;
}

/** WHY: (item 10) exactly one text block, the attribution rule every seam applies. */
function singleTextBlock(event: ToolResultEvent): string | undefined {
  const block = Array.isArray(event.content) ? event.content : undefined;
  return block?.length === 1 && block[0]?.type === "text" ? block[0].text : undefined;
}

/**
 * WHY: (item 11) the header states the order whenever a consumer reordered the stream — a sorted
 * WHY: or adjacent-deduped render is not the file's own order, and the model reads the header to
 * WHY: know which coordinates it holds. The order suffix is empty for every order-preserving fold
 * WHY: (so the item-9/item-10 headers stay byte-identical), and `count` names itself instead.
 */
function viewHeader(filePath: string, ops: readonly ViewOp[], count: number): string {
  if (ops.some((op) => op.kind === "count")) {
    return `[${BASH_VIEW_LABEL}: ${filePath} (count: ${count})]`;
  }
  const markers: string[] = [];
  if (ops.some((op) => op.kind === "sortUnique")) markers.push("sorted");
  if (ops.some((op) => op.kind === "uniq")) markers.push("adjacent-dedup");
  const order = markers.length === 0 ? "" : `, ${markers.join(", ")}`;
  return `[${BASH_VIEW_LABEL}: ${filePath} (${count} ${count === 1 ? "line" : "lines"}${order})]`;
}

/**
 * WHY: (item 10) the recursive-walk exclusion list, stated rather than inferred: no directory
 * whose name is hidden (leading `.`, which covers `.git`) and none named `node_modules` is ever
 * descended into. Exclusions gate DESCENT only — an explicitly named operand is still honored,
 * because the operator asked for that path.
 */
const SEARCH_WALK_EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules"]);

function isWalkableDirName(name: string): boolean {
  if (name.startsWith(".")) return false;
  return !SEARCH_WALK_EXCLUDED_DIR_NAMES.has(name);
}

/** `grep -n`/`rg --line-number` stdout row: a 1-indexed line number, a colon, the matched text. */
const SEARCH_STDOUT_LINE = /^(\d+):([\s\S]*)$/;
/** WHY: (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3) one parsed search row and which geometry printed it. */
interface SearchStdoutRow {
  line: number;
  kind: "match" | "context";
  content: string;
}
/** `grep -n -C`/`rg --line-number -C` CONTEXT row: line number, `-`, the line's own bytes. */
const SEARCH_STDOUT_CONTEXT_LINE = /^(\d+)-([\s\S]*)$/;
/** The group separator `grep -C`/`rg -C` print between non-contiguous context groups. */
const SEARCH_STDOUT_GROUP_SEPARATOR = "--";
/** `cat -n`/`nl -ba` stdout row: blank-padded 1-indexed number, a tab, the line content. */
const NUMBERED_STDOUT_LINE = /^\s*(\d+)\t([\s\S]*)$/;
/**
 * WHY: (item 11) `wc -l` stdout is the count ALONE. GNU pads to a fixed width when it
 * WHY: names a file (`   12 f`), so both `12\n` and `   12\n` are accepted
 * WHY: for a piped count; a second field, a non-number or an empty stdout fails the gate.
 */
const COUNT_STDOUT_LINE = /^\s*(\d+)\s*$/;

/**
 * Parse the rows of a line-numbered single-file search. Fails closed (`undefined`) unless every row is
 * the admitted geometry, so a filename prefix, a match count, a heading or any other `grep`/`rg` shape
 * is never mistaken for it. The only empty line tolerated is the trailing newline every search emits.
 *
 * WHY: (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3 — context searches) a row is a MATCH (`LINE:content`) or — only when the command
 * asked for a window — one of that match's CONTEXT lines (`LINE-content`), and non-contiguous groups
 * are separated by a bare `--`. The first field is the maximal leading digit run and the very next byte
 * decides the kind, so the split is deterministic: unlike `FILE:LINE:content`, whose prefix may itself
 * contain `:`, there is no second reading to enumerate. Context geometry is admitted ONLY when it was
 * asked for — a `--` or `LINE-content` row in a plain search's stdout is foreign output, not evidence.
 */
function parseSearchStdout(
  observed: string,
  options?: { context: true },
): SearchStdoutRow[] | undefined {
  const context = options?.context === true;
  const lines = observed.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;
  const rows: SearchStdoutRow[] = [];
  for (const text of lines) {
    // WHY: a separator carries no file byte — it only marks a gap grep did not merge — so it is
    // WHY: dropped here and the surviving line numbers keep that gap visible in the render.
    if (context && text === SEARCH_STDOUT_GROUP_SEPARATOR) continue;
    const matched = SEARCH_STDOUT_LINE.exec(text);
    if (matched !== null) {
      const line = Number(matched[1]);
      if (!Number.isSafeInteger(line) || line < 1) return undefined;
      rows.push({ line, kind: "match", content: matched[2] ?? "" });
      continue;
    }
    if (!context) return undefined;
    const surrounding = SEARCH_STDOUT_CONTEXT_LINE.exec(text);
    if (surrounding === null) return undefined;
    const line = Number(surrounding[1]);
    if (!Number.isSafeInteger(line) || line < 1) return undefined;
    rows.push({ line, kind: "context", content: surrounding[2] ?? "" });
  }
  return rows.length === 0 ? undefined : rows;
}

/**
 * WHY: (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3 — the search's own prediction half of D1) a CONTEXT row is witnessable only when
 * some match could have printed it: it must lie inside that match's window, and it must not BE a match
 * line (grep prints a matched line as a match row, never as context). A match row is witnessed by its
 * own byte equality, so it needs no window. A row that fails this is not this command's output.
 */
function contextRowIsWitnessable(
  row: SearchStdoutRow,
  matchLines: ReadonlySet<number>,
  window: BashSearchContext,
): boolean {
  if (row.kind === "match") return true;
  if (matchLines.has(row.line)) return false;
  for (const matchLine of matchLines) {
    if (row.line >= matchLine - window.before && row.line <= matchLine + window.after) return true;
  }
  return false;
}

/**
 * WHY: (docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md D3) the row-budget and prediction gates of one search, all BEFORE the first lease.
 * Two INDEPENDENT caps: `SEARCH_MAX_MATCHES` still bounds the pattern hits — the bytes-cost argument
 * behind it is about matches — while `SEARCH_MAX_TOTAL_ROWS` bounds match+context rows, which one
 * `-C N` window inflates far past the match count. Both are all-or-nothing: over either one the whole
 * command passes through raw, because a truncated window names lines bash never printed. With a window
 * requested, every context row must also be witnessable (see `contextRowIsWitnessable`).
 *
 * Returns the MATCH line set the seam reuses for the header counts, or `undefined` to pass through.
 */
function searchRowsWithinBudget(
  rows: readonly SearchStdoutRow[],
  window: BashSearchContext | undefined,
): ReadonlySet<number> | undefined {
  const matchLines = new Set<number>();
  for (const row of rows) if (row.kind === "match") matchLines.add(row.line);
  if (matchLines.size > SEARCH_MAX_MATCHES) return undefined;
  if (rows.length > SEARCH_MAX_TOTAL_ROWS) return undefined;
  if (window !== undefined) {
    for (const row of rows) {
      if (!contextRowIsWitnessable(row, matchLines, window)) return undefined;
    }
  }
  return matchLines;
}

/**
 * WHY: (docs/.archive_adrs/0049-multi-file-bash-views.md M3) one selected row of the concatenated stream: which page it belongs to, its
 * file-relative line, its stream line, and the bytes the re-read file holds there.
 */
interface MultiViewStreamRow {
  readonly fileIndex: number;
  readonly fileLine: number;
  readonly streamLine: number;
  readonly text: string;
}

/**
 * WHY: (docs/.archive_adrs/0049-multi-file-bash-views.md M3) boundaries are LINE COUNTS. The operands are laid end to end; each file owns
 * `[start, start + count - 1]` of the stream, and a stream line maps to a file line by subtracting
 * that start. No byte arithmetic and no content matching is involved, so a `sed` range spanning files
 * (M5) is just interval intersection. A file with no selected line keeps an empty page (M4).
 *
 * `undefined` means the selection is not provable as ONE page per file: a stream line outside every
 * file, or a DISJOINT selection inside one file (one page header names one contiguous range, M5).
 */
function multiViewSelection(
  lineCounts: readonly number[],
  intervals: ReadonlyArray<{ lo: number; hi: number }>,
): number[][] | undefined {
  const starts: number[] = [];
  let next = 1;
  for (const count of lineCounts) {
    starts.push(next);
    next += count;
  }
  const selected: number[][] = lineCounts.map(() => []);
  for (const interval of intervals) {
    for (let streamLine = interval.lo; streamLine <= interval.hi; streamLine++) {
      const index = starts.findIndex((start, fileIndex) => {
        const count = lineCounts[fileIndex] ?? 0;
        return count > 0 && streamLine >= start && streamLine < start + count;
      });
      if (index === -1) return undefined;
      selected[index]!.push(streamLine - starts[index]! + 1);
    }
  }
  // WHY: (M5) one page header names one contiguous range, so a file whose selected lines are not a
  // WHY: single run has no honest header: pass the whole command through instead of inventing one.
  for (const lines of selected) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (first === undefined || last === undefined) continue;
    if (last - first + 1 !== lines.length) return undefined;
  }
  return selected;
}

/**
 * WHY: (docs/.archive_adrs/0049-multi-file-bash-views.md M3) the stream rows in stream order, built from the RE-READ files — the observed
 * stdout is compared against these bytes, so every served row is byte-identical to its disk slice by
 * construction. `undefined` when the layout and the bytes disagree (an impossible state, refused).
 */
function multiViewStreamRows(
  files: ReadonlyArray<{ allLines: readonly string[] }>,
  selected: ReadonlyArray<readonly number[]>,
): MultiViewStreamRow[] | undefined {
  const rows: MultiViewStreamRow[] = [];
  let streamStart = 1;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const allLines = files[fileIndex]?.allLines ?? [];
    for (const fileLine of selected[fileIndex] ?? []) {
      const text = allLines[fileLine - 1];
      if (text === undefined) return undefined;
      rows.push({ fileIndex, fileLine, streamLine: streamStart + fileLine - 1, text });
    }
    streamStart += allLines.length;
  }
  return rows;
}

/**
 * The candidate observed renders of one multi-file view, byte-exact and trailing-newline free.
 *
 * WHY two numbering candidates (docs/.archive_adrs/0049-multi-file-bash-views.md M3): the numbering transform is `cat -n` / `nl -ba`, and the
 * STREAM numbering is continuous while GNU `cat -n`/`nl` implement exactly that — but a per-file
 * restart is what BSD `cat -n` prints, and `nl` there refuses multiple operands. Both renders are
 * pure functions of line counts, so admitting either is still a length-derived proof: the observed
 * bytes choose which convention ran, and a stream that matches neither fails closed.
 */
function multiViewExpectedTexts(
  rows: readonly MultiViewStreamRow[],
  lineNumbered: boolean,
): string[] {
  const plain = rows.map((row) => row.text).join("\n");
  if (!lineNumbered) return [plain];
  const numbered = (number: (row: MultiViewStreamRow) => number): string =>
    rows.map((row) => `${String(number(row)).padStart(6)}\t${row.text}`).join("\n");
  const continuous = numbered((row) => row.streamLine);
  const perFile = numbered((row) => row.fileLine);
  return perFile === continuous ? [continuous] : [continuous, perFile];
}

/**
 * Parse one `cat -n` / `nl -ba` full-file stdout into content lines. Fails closed
 * (`undefined`) unless EVERY non-trailing-newline row matches the shared numbered
 * geometry — ONE parser for both spellings (they are the same view). The numeric
 * field is display geometry: it is validated only for strict `1..L` sequencing and
 * never used as a lease coordinate (leases come from re-read positions).
 */
function parseNumberedStdout(observed: string): string[] | undefined {
  const lines = observed.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = NUMBERED_STDOUT_LINE.exec(lines[i]);
    if (!parsed) return undefined;
    if (Number(parsed[1]) !== i + 1) return undefined;
    out.push(parsed[2]);
  }
  return out;
}

/**
 * The changed line span of one mutated file, or an empty list meaning "whole file".
 *
 * WHY empty means whole file: the io-bridge adapter maps an empty list to a whole-file write, and
 * the bridge resolves a whole-file write the same way — so an unnamed span stays honest instead of
 * inventing a line. WHY the validation: a non-integer, a zero, or an inverted pair would be refused
 * downstream (`isValidRange` in the v2 contract) or would name lines the file never had.
 */
function toChangedRanges(first: number | undefined, last: number | undefined): ServedSpan[] {
  if (first === undefined || last === undefined) return [];
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) return [];
  return [{ startLine: first, lineCount: last - first + 1 }];
}

/**
 * Sessions already shown the first-interception notice, keyed by `deps.sessionKeyFor`.
 * Module scope, not per hooks instance: a session outlives any one hooks object, and the
 * notice is once per session. Cleared in `handleSessionStart`, which re-arms it.
 */
const warnedBashViewSessions = new Set<string>();

/** First-interception notice: names the round saved and the off-ramp. */
const BASH_VIEW_FIRST_NOTICE =
  "Bash view replaced this output with anchored lines, saving a re-read round trip. " +
  "Turn it off with /pi-better-edit bash-view off, or pick a scope via /pi-better-edit bash-view.";

/**
 * Warn once per session about the interception. A context without a notify surface falls
 * back to the console — the same degradation the command's notify uses, inlined here so
 * the editing path imports no command module for three lines.
 */
function notifyBashViewOnce(ctx: ToolContext, sessionKey: string): void {
  if (warnedBashViewSessions.has(sessionKey)) return;
  warnedBashViewSessions.add(sessionKey);
  const ui = ctx.ui as { notify: (message: string, level: string) => void } | undefined;
  if (ui !== undefined) {
    ui.notify(BASH_VIEW_FIRST_NOTICE, "warning");
    return;
  }
  reportInfo("lifecycle-hooks", BASH_VIEW_FIRST_NOTICE);
}
export function createLifecycleHooks(overrides: Partial<LifecycleDeps> = {}): {
  onSessionStart: (event: unknown, ctx: ToolContext) => Promise<void>;
  onToolResult: (
    event: ToolResultEvent,
    ctx: ToolContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown } | undefined>;
  onWrite: (
    event: ToolResultEvent,
    ctx: ToolContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown } | undefined>;
  onEdit: (
    event: ToolResultEvent,
    ctx: ToolContext,
  ) => Promise<{ content: Array<{ type: string; text: string }> } | undefined>;
  onBash: (
    event: ToolResultEvent,
    ctx: ToolContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown } | undefined>;
} {
  const deps: LifecycleDeps = { ...defaultDeps(), ...overrides };

  async function recordServesBestEffort(input: {
    sessionKey: string;
    path: string;
    servedRows: import("../served-session/serve-render.js").ServedRow[];
    contentHash: string;
    resultLineCount?: number;
    firstChangedLine?: number;
    lastChangedLine?: number;
  }): Promise<void> {
    if (input.servedRows.length === 0) return;
    try {
      await deps.recordDiffServes(input);
    } catch (error) {
      // WHY: a lost serve record costs a re-read; the write already landed, so this failure must not fail the tool.
      reportDiagnostic("lifecycle-hooks", "Failed to record served rows:", error);
    }
  }

  async function handleSessionStart(_event: unknown, ctx: ToolContext): Promise<void> {
    warnedBashViewSessions.clear();
    await deps.initHasher();
    try {
      await deps.pruneMissingAll();
    } catch (err) {
      // WHY: a failed prune leaves stale rows the next startup retries; the store stays usable either way.
      reportDiagnostic("lifecycle-hooks", "Failed to load or prune hash store:", err);
    }
    const debugValue = process.env.PI_HASHLINE_DEBUG;
    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify("Hashline Edit mode active", "info");
    }
  }

  async function handleWrite(
    event: ToolResultEvent,
    ctx: ToolContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown } | undefined> {
    const rawInput = event.input as Record<string, unknown> | undefined;
    const writtenPath = rawInput?.file ?? rawInput?.path;
    if (typeof writtenPath === "string") {
      try {
        await deps.clearUndo(await deps.resolveTarget(deps.toCwd(writtenPath, ctx.cwd)));
      } catch (error) {
        // WHY: a missed clear leaves undo history the next edit overwrites; it never blocks the write.
        reportDiagnostic("lifecycle-hooks", "Failed to clear undo after write:", error);
      }
    }
    if (typeof writtenPath !== "string") return undefined;
    try {
      const resolvedPath = await deps.resolveTarget(deps.toCwd(writtenPath, ctx.cwd));
      await deps.valAccess(resolvedPath, writtenPath);
      const file = await deps.loadFileKindAndText(resolvedPath, {
        maxLines: SERVED_MAX_LINES,
        displayPath: writtenPath,
      });
      if (file.kind !== "text") return undefined;
      const { normalized, fileHashes, absolutePath } = await deps.readNormFile(
        writtenPath,
        ctx.cwd,
        {
          maxLines: SERVED_MAX_LINES,
          preloadedFile: file,
        },
      );
      const preview = await deps.fmtReadPreview(
        normalized,
        {},
        fileHashes,
        absolutePath,
        DEFAULT_MAX_BYTES,
        AUTO_READ_MAX,
      );
      // WHY: `mode: "literal"` is admitted by the pre-write guard, so the declaration is detected here,
      // WHY: against the mirror that still holds the pre-write rows — the auto-read replaces it below.
      let literalBypass = false;
      // WHY: middle tier for `write`: a line opening with a served anchor whose remainder matches none of
      // WHY: the digests recorded for that anchor is a copied anchor without its served line — so it earns
      // WHY: a note, never a refusal, because the bytes are already on disk.
      let prefixNotes: string[] = [];
      // WHY: one session key for the whole post-write handler: the literal audit, the
      // WHY: serve recording it triggers, and the refusal clear all belong to the session
      // WHY: that wrote the bytes, never to another session sharing the path (#132).
      const sessionKey = deps.sessionKeyFor(ctx);
      try {
        const rawContent = (event.input as Record<string, unknown> | undefined)?.content;
        const rawMode = (event.input as Record<string, unknown> | undefined)?.mode;
        if (typeof rawContent === "string") {
          const handle = createSessionHandle(sessionKey, absolutePath);
          const served = await handle.load();
          let canonDigests: (string | null)[] = [];
          try {
            canonDigests = await handle.loadCanonDigests();
          } catch {
            canonDigests = [];
          }
          if (rawMode === "literal") {
            const reproduction = findServedHashEcho(
              splitLines(rawContent),
              served,
              canonDigests,
              1,
            );
            if (reproduction) literalBypass = true;
          }
          const mismatches = findServedPrefixMismatches(
            splitLines(rawContent),
            served,
            canonDigests,
            1,
          );
          prefixNotes = mismatches.map((mismatch) =>
            buildServedWritePrefixNote({
              line: mismatch.line,
              anchor: mismatch.anchor,
              servedLine: mismatch.servedLine,
            }),
          );
        }
      } catch (error) {
        reportDiagnostic(
          "lifecycle-hooks",
          "Failed to evaluate served prefix notes after write:",
          error,
        );
        prefixNotes = [];
      }
      const resultLineCount = deps.visLines(normalized).length;
      await recordServesBestEffort({
        sessionKey,
        path: absolutePath,
        servedRows: denseServeRows(fileHashes),
        contentHash: snapshotHashFor(normalized),
        resultLineCount,
        firstChangedLine: 1,
      });
      // WHY: the bytes are on disk and the auto-read re-served the whole file, so the honest shape
      // WHY: is whole-file authorship: an empty range list means the whole file changed, which keeps
      // WHY: this hot path free of any line counting.
      notifyMutatedFile({ filePath: absolutePath, kind: "write", ranges: [], sourceTool: "write" });
      // WHY: an auto-read re-serves the whole file, so one full-file span is the honest shape; a zero-line
      // WHY: result sends empty spans, which notifies nobody.
      notifyServedSpans({
        filePath: absolutePath,
        spans: resultLineCount > 0 ? [{ startLine: 1, lineCount: resultLineCount }] : [],
        source: "auto-read",
        // WHY: the auto-read holds the verbatim bytes, so the mirror hashes caller evidence in
        // WHY: memory; the anchored preview is never the source of a line hash.
        content: normalized,
      });
      // WHY: the clear side of the tally runs only after the bytes are on disk — the pre-write verification
      // WHY: must keep its count so a resubmission still reads as a repeat.
      try {
        clearServedRefusals(sessionKey, absolutePath);
      } catch {
        // WHY: a missed clear only sharpens the next refusal message; it never blocks a write.
      }
      // WHY: the auto-read is a whole-file page, so its header uses the read tool's own chrome grammar.
      const autoReadHeader = formatPageHeader({
        label: BASH_AUTO_READ_LABEL,
        file: writtenPath,
        totalLines: resultLineCount,
        ...(preview.truncation === undefined
          ? {}
          : { shownRange: { startLine: 1, endLine: preview.truncation.outputLines } }),
        ...(preview.truncation?.truncatedBy === "bytes"
          ? { stoppedAtBytes: preview.truncation.maxBytes }
          : {}),
      });
      return {
        content: [
          ...(event.content ?? []),
          {
            type: "text",
            text: `\n\n${autoReadHeader}\n${preview.text}`,
          },
          ...(literalBypass ? [{ type: "text" as const, text: LITERAL_BYPASS_NOTICE }] : []),
          ...prefixNotes.map((note) => ({ type: "text" as const, text: note })),
        ],
        ...(literalBypass
          ? {
              details: {
                metrics: {
                  classification: "applied" as const,
                  edits_attempted: 0,
                  edits_noop: 0,
                  warnings: 0,
                  literalDeclarations: 1,
                },
              },
            }
          : {}),
      };
    } catch (error) {
      reportDiagnostic("lifecycle-hooks", "Auto-read after write failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n[Auto-read failed: ${message}]` },
        ],
      };
    }
  }

  async function handleEdit(
    event: ToolResultEvent,
    ctx: ToolContext,
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    if (event.toolName !== "edit" && event.toolName !== "undo_last_edit") return undefined;
    const details = event.details as import("../edit-response.js").EditDetails | undefined;
    if (details?.metrics?.classification === "noop") return undefined;
    if (!details?.diff) return undefined;

    const { content, servedRows } = deps.finalizeToolResult(details);
    if (details.servedByPath && details.servedByPath.length > 0) {
      for (const entry of details.servedByPath) {
        if (entry.servedRows.length === 0) continue;
        const resolvedPath = await deps.resolveTarget(deps.toCwd(entry.path, ctx.cwd));
        await recordServesBestEffort({
          sessionKey: deps.sessionKeyFor(ctx),
          path: resolvedPath,
          servedRows: entry.servedRows,
          contentHash: entry.contentHash,
          ...(entry.resultLineCount !== undefined
            ? { resultLineCount: entry.resultLineCount }
            : {}),
          ...(entry.firstChangedLine !== undefined
            ? { firstChangedLine: entry.firstChangedLine }
            : {}),
          ...(entry.lastChangedLine !== undefined
            ? { lastChangedLine: entry.lastChangedLine }
            : {}),
        });
        // WHY: a served diff means the bytes changed on disk, and the committed span is this
        // WHY: file's changed range. A `reject-and-serve` payload never reaches here (it carries an
        // WHY: error, not a diff), so a read-only refusal can never be reported as a mutation.
        notifyMutatedFile({
          filePath: resolvedPath,
          kind: "edit",
          ranges: toChangedRanges(entry.firstChangedLine, entry.lastChangedLine),
          sourceTool: event.toolName === "undo_last_edit" ? "undo_last_edit" : "edit",
        });
        // WHY: the mutation is notified before the rows it produced, so a mirror that reads the file
        // WHY: observes the post-edit bytes. A diff holds no verbatim text, so the read is text-less
        // WHY: and falls back to disk evidence.
        notifyServedSpans({
          filePath: resolvedPath,
          spans:
            entry.resultLineCount !== undefined && entry.resultLineCount > 0
              ? [{ startLine: 1, lineCount: entry.resultLineCount }]
              : servedRowsToSpans(entry.servedRows),
          source: "diff",
        });
      }
    } else if (servedRows && servedRows.length > 0) {
      const rawInput = event.input as Record<string, unknown> | undefined;
      const rawPath = rawInput?.file ?? rawInput?.path;
      if (typeof rawPath === "string") {
        const resolvedPath = await deps.resolveTarget(deps.toCwd(rawPath, ctx.cwd));
        await recordServesBestEffort({
          sessionKey: deps.sessionKeyFor(ctx),
          path: resolvedPath,
          servedRows,
          // WHY: undo_last_edit names the restored snapshot on its details; legacy synthesized
          // WHY: details may not, in which case "" names no snapshot and no lease is granted
          // WHY: (fail-closed rather than binding to whatever was materialized most recently).
          contentHash: details.contentHash ?? "",
          ...(details.resultLineCount !== undefined
            ? { resultLineCount: details.resultLineCount }
            : {}),
          ...(details.firstChangedLine !== undefined
            ? { firstChangedLine: details.firstChangedLine }
            : {}),
          ...(details.lastChangedLine !== undefined
            ? { lastChangedLine: details.lastChangedLine }
            : {}),
        });
        notifyMutatedFile({
          filePath: resolvedPath,
          kind: "edit",
          ranges: toChangedRanges(details.firstChangedLine, details.lastChangedLine),
          sourceTool: event.toolName === "undo_last_edit" ? "undo_last_edit" : "edit",
        });
        notifyServedSpans({
          filePath: resolvedPath,
          spans:
            details.resultLineCount !== undefined && details.resultLineCount > 0
              ? [{ startLine: 1, lineCount: details.resultLineCount }]
              : servedRowsToSpans(servedRows),
          source: "diff",
        });
      }
    }
    return { content };
  }

  // WHY: `bash-classifier` statically pulls `unbash`, which must never join the extension entry graph —
  // WHY: entry import cost is budgeted (`measure-import --max-ratio 0.75`) — so the classifier is reached
  // WHY: through a dynamic `import()` on the first bash result, and a resolve/eval failure fails closed
  // WHY: to raw output through the catch below.
  // Ref: docs/.archive_adrs/0033-bash-view-interception.md
  async function handleBash(
    event: ToolResultEvent,
    ctx: ToolContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown } | undefined> {
    if (event.toolName !== "bash") return undefined;
    // WHY: the off switch is read before every seam below, so an opted-out session gets byte-identical raw
    // WHY: output; it defaults to on, so only a configured opt-out reaches this return.
    if (resolveBashViewMode(ctx.cwd) === "off") return undefined;
    if (event.isError) return undefined;
    const rawInput = event.input as Record<string, unknown> | undefined;
    const command = rawInput?.command;
    if (typeof command !== "string" || command.trim() === "") return undefined;
    // WHY: the runtime delivers `BashToolDetails` for bash though the event type says `EditDetails`, so
    // WHY: the read is structural. A truncated stdout means the model never saw the whole file, and
    // WHY: anchored lines would invent viewed lines — fail closed.
    // SAFETY: the runtime hands bash a `BashToolDetails`, while the event type
    // SAFETY: declares `EditDetails` for every tool. The assertion only widens the
    // SAFETY: read to an optional `truncation`; the guard below re-checks the shape
    // SAFETY: structurally before either field is touched.

    const bashDetails = event.details as unknown as { truncation?: unknown } | undefined;
    if (bashDetails && typeof bashDetails === "object" && bashDetails.truncation != null) {
      return undefined;
    }
    try {
      const { classifyBashCommand, applySliceOps, isContentOp, isSliceOp } =
        await import("../bash-classifier.js");
      const conversion: Decision = classifyBashCommand(command);
      // WHY: (#151) every conversion shape routes on `decision.kind` — no shape-sniffing, and no stringified
      // WHY: reason downstream: a diagnostic reason must never reach the model's text (D6). Banners and
      // WHY: headers stay in the shape seams this calls; this is where the routing decision lands.
      // Ref: docs/.archive_adrs/0033-bash-view-interception.md
      async function renderDecision(
        decision: Decision,
      ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
        if (decision.kind === "pureSearch") {
          return await handleBashSearch(event, ctx, decision.search);
        }
        // WHY: (item 10) the three new geometries each get their own seam; every one of them
        // WHY: returns `undefined` (raw output, zero leases) the moment a gate fails.
        if (decision.kind === "pureMultiSearch") {
          return await handleBashMultiSearch(event, ctx, decision.search);
        }
        if (decision.kind === "pureRecursiveSearch") {
          return await handleBashRecursiveSearch(event, ctx, decision.search);
        }
        if (decision.kind === "pureFilesList") {
          return await handleBashFilesList(event, ctx, decision.search);
        }
        // WHY: (M2) the multi-file view is N pages in one result: its own seam, because the proof is per-file
        // WHY: line-count boundaries and its leases are per file.
        // Ref: docs/.archive_adrs/0049-multi-file-bash-views.md
        if (decision.kind === "pureMultiView") {
          return await handleBashMultiView(event, ctx, decision.view);
        }
        if (decision.kind === "pureCompound") {
          return await handleBashCompound(event, ctx, decision);
        }
        if (decision.kind !== "pureView") {
          // WHY: a systematic regression (parser drift, a filtering wrapper, a new view shape) is otherwise
          // WHY: indistinguishable from "no views issued", so the reason goes to the diagnostics log and never
          // WHY: to the model's text (D6).
          // Ref: docs/.archive_adrs/0033-bash-view-interception.md
          const debugValue = process.env.PI_HASHLINE_DEBUG;
          if (debugValue === "1" || debugValue === "true") {
            reportDiagnostic("lifecycle-hooks", `[bash-view] pass-through (${decision.reason})`);
          }
          return undefined;
        }
        // WHY: each segment's expected raw bytes come from re-read disk, never from the observed stdout, so a
        // WHY: match is a proof about the file rather than a repeat of what bash printed. The peel consumes
        // WHY: prefixes left-to-right and halts at the first mismatch: the verified prefix keeps its leases,
        // WHY: the rest stays raw and leases nothing.
        // Ref: docs/.archive_adrs/0039-compound-bash-view-interception.md
        async function handleBashCompound(
          event: ToolResultEvent,
          ctx: ToolContext,
          compound: { kind: "pureCompound"; segments: CompoundSegment[]; baseDir?: string },
        ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
          const dbg = (...a: unknown[]) => {
            if (process.env.PI_HASHLINE_DEBUG === "1")
              reportDiagnostic("lifecycle-hooks", "[peel]", ...a);
          };
          dbg("segments", compound.segments.map((x) => x.kind).join(","));
          const blocks = compound.segments.filter(
            (segment) => segment.kind === "view" || segment.kind === "search",
          );
          if (blocks.length === 0) return undefined;
          const effCwd =
            compound.baseDir === undefined ? ctx.cwd : deps.toCwd(compound.baseDir, ctx.cwd);
          const stdoutText = singleTextBlock(event);
          if (stdoutText === undefined) return undefined;
          const observed = toLF(stripBOM(stdoutText).text);
          const parts: string[] = [];
          let renderedBlocks = 0;
          let pos = 0;
          try {
            for (const segment of compound.segments) {
              const candidates = await segmentExpectedVariants(segment, effCwd);
              dbg(
                segment.kind,
                "candidates",
                candidates === undefined ? "UNDEF" : candidates.map((c) => c.length),
              );
              if (candidates === undefined) break;
              let consumed: string | undefined;
              for (const candidate of candidates) {
                if (observed.startsWith(candidate, pos)) {
                  consumed = candidate;
                  break;
                }
              }
              if (consumed === undefined) {
                dbg(segment.kind, "NO-CONSUME halt");
                break;
              }
              if (segment.kind === "glue") {
                if (consumed !== "") parts.push(consumed);
                pos += consumed.length;
                continue;
              }
              const rendered = await renderVerifiedBlock(
                segment,
                observed.slice(pos, pos + consumed.length),
                compound.baseDir,
                ctx,
              );
              if (rendered === undefined) {
                dbg(segment.kind, "RENDER-UNDEF halt");
                break;
              }
              parts.push(rendered);
              renderedBlocks++;
              pos += consumed.length;
            }
          } catch {
            // WHY: fall through to partial halt below — a failed render must never break the view.
          }
          dbg("done", { renderedBlocks, pos, len: observed.length });
          if (renderedBlocks === 0) return undefined;
          const rest = observed.slice(pos);
          if (rest !== "" && rest !== "\n") {
            return { content: [{ type: "text", text: parts.join("") + rest }] };
          }
          return {
            content: [{ type: "text", text: parts.join("") + (rest === "\n" ? "\n" : "") }],
          };
        }
        // WHY: an empty search renders its banner with zero rows and zero leases rather than halting the block;
        // WHY: a multi/recursive/file-list segment never reaches here — it has no expected variants, so the peel
        // WHY: halts first.
        // Ref: docs/.archive_adrs/0039-compound-bash-view-interception.md
        async function renderVerifiedBlock(
          segment: CompoundSegment,
          slice: string,
          baseDir: string | undefined,
          ctx: ToolContext,
        ): Promise<string | undefined> {
          const withBase = baseDir === undefined ? {} : { baseDir };
          if (segment.kind === "view") {
            const res = await servePureViewBlock({ ...segment, ...withBase }, slice, ctx);
            if (res === undefined) return undefined;
            const text = res.content[0]?.text;
            if (typeof text !== "string") return undefined;
            return text.endsWith("\n") ? text : `${text}\n`;
          }
          if (segment.kind !== "search" || segment.family.kind !== "pureSearch") return undefined;
          if (slice === "") {
            const file = segment.family.search.filePath;
            return `${bashBanner("search")}\n[${file} (0 matches)]\n`;
          }
          const res = await handleBashSearch(
            event,
            ctx,
            { ...segment.family.search, ...withBase },
            slice,
          );
          if (res === undefined) return undefined;
          const text = res.content[0]?.text;
          if (typeof text !== "string") return undefined;
          return text.endsWith("\n") ? text : `${text}\n`;
        }
        // WHY: a served multi-file view is ONE result with ONE page section per file, in operand order, under
        // WHY: the existing page header grammar — no new root banner and no second chrome dialect. Each page
        // WHY: leases under the existing `(session, path, anchor)` identity, so no anchor is shared between
        // WHY: files. The whole-command gate compares the observed stream against the render built from the
        // WHY: re-read files before the first lease, so one bad file, page, transform or cap passes the whole
        // WHY: command through raw.
        // Ref: docs/.archive_adrs/0049-multi-file-bash-views.md
        async function handleBashMultiView(
          event: ToolResultEvent,
          ctx: ToolContext,
          view: BashMultiView,
        ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
          const caps = resolveBashMultiFileSettings(ctx.cwd, (reason) =>
            reportWarning("lifecycle-hooks", reason),
          );
          // WHY: (M6) the file cap counts EVERY operand, a zero-row page included; the row cap counts
          // WHY: served rows only, never page headers. Over either cap the whole command is raw.
          if (view.filePaths.length < 2 || view.filePaths.length > caps.maxFiles) return undefined;
          const effCwd = view.baseDir === undefined ? ctx.cwd : deps.toCwd(view.baseDir, ctx.cwd);
          const files: Array<{
            display: string;
            absolutePath: string;
            normalized: string;
            allLines: string[];
            fileHashes: string[];
          }> = [];
          for (const display of view.filePaths) {
            const target = await loadTextTarget(display, effCwd);
            if (target === undefined) return undefined;
            // WHY: (M1) a page boundary is proved from line counts, so an unterminated final line has
            // WHY: no provable boundary; a 0-byte file is the zero-line case, not an unterminated one.
            if (target.normalized !== "" && !target.normalized.endsWith("\n")) return undefined;
            files.push({ display, ...target });
          }
          const lineCounts = files.map((file) => file.allLines.length);
          const totalLines = lineCounts.reduce((sum, count) => sum + count, 0);
          const selected = multiViewSelection(lineCounts, applySliceOps(view.ops, totalLines));
          if (selected === undefined) return undefined;
          const rows = multiViewStreamRows(files, selected);
          if (rows === undefined) return undefined;
          // WHY: (M4) an all-empty command stays raw: serving only synthetic headers would show the
          // WHY: model no observed byte at all, and every page would lease nothing.
          if (rows.length === 0) return undefined;
          if (rows.length > caps.maxRows) return undefined;
          const stdoutText = singleTextBlock(event);
          if (stdoutText === undefined) return undefined;
          const observed = toLF(stripBOM(stdoutText).text);
          // WHY: (M3) the stream the shell printed must equal the render built from the re-read files, with the
          // WHY: same lone-trailing-newline leniency every other view seam applies; any skew fails closed here,
          // WHY: before the first lease exists.
          // Ref: docs/.archive_adrs/0033-bash-view-interception.md
          // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
          const expected = multiViewExpectedTexts(rows, view.lineNumbered === true);
          if (!expected.some((text) => observed === text || observed === `${text}\n`)) {
            return undefined;
          }

          // WHY: (M8) build every page's rows FIRST — after this loop there is no failure path, so a
          // WHY: refusal can never leave a partial grant behind.
          const pages: Array<{
            header: string;
            servedRows: ServedRow[];
            file: (typeof files)[number];
          }> = [];
          for (let index = 0; index < files.length; index++) {
            const file = files[index]!;
            const lines = selected[index] ?? [];
            const servedRows: ServedRow[] = [];
            for (const line of lines) {
              const hash = file.fileHashes[line - 1];
              if (hash === undefined) return undefined;
              servedRows.push({ position: line - 1, hash });
            }
            const first = lines[0];
            const last = lines[lines.length - 1];
            const wholeFile =
              first === 1 && last === file.allLines.length && lines.length === file.allLines.length;
            pages.push({
              file,
              servedRows,
              header: formatPageHeader({
                label: BASH_VIEW_LABEL,
                file: file.display,
                // WHY: (M4) a page that serves nothing reports `0 lines total` rather than the file's length — it must
                // WHY: claim no size for rows it never showed.
                totalLines: servedRows.length === 0 ? 0 : file.allLines.length,
                ...(wholeFile || first === undefined || last === undefined
                  ? {}
                  : { shownRange: { startLine: first, endLine: last } }),
              }),
            });
          }

          const sessionKey = deps.sessionKeyFor(ctx);
          const sections: string[] = [];
          for (const page of pages) {
            if (page.servedRows.length > 0) {
              await recordServesBestEffort({
                sessionKey,
                path: page.file.absolutePath,
                servedRows: page.servedRows,
                contentHash: snapshotHashFor(page.file.normalized),
              });
              notifyServedSpans({
                filePath: page.file.absolutePath,
                spans: servedRowsToSpans(page.servedRows),
                source: "auto-read",
                content: page.file.normalized,
              });
            }
            const rowsText = fmtServedRows(page.servedRows, page.file.allLines);
            sections.push(rowsText === "" ? page.header : `${page.header}\n${rowsText}`);
          }
          notifyBashViewOnce(ctx, sessionKey);
          return { content: [{ type: "text", text: sections.join("\n") }] };
        }

        async function servePureViewBlock(
          view: {
            filePath: string;
            baseDir?: string;
            ops: ViewOp[];
            lineNumbered?: boolean;
            display?: DisplayTransform;
          },
          rawText: string | undefined,
          ctx: ToolContext,
        ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
          const { filePath, baseDir, ops, lineNumbered, display } = view;
          // WHY: (item 8) numbered and unnumbered are the same view: `lineNumbered` only selects the stdout
          // WHY: parser, because leases and rows come from re-read positions, never from the printed numbers.
          const isNumbered = lineNumbered === true;
          // WHY: (item 8) numbered views admit no slice ops; the classifier emits none, and drift fails closed.
          if (isNumbered && ops.length !== 0) return undefined;
          if (display !== undefined && (isNumbered || ops.some(isContentOp))) return undefined;
          // WHY: the single pre-view literal `cd` re-bases relative resolution; an absolute target ignores it
          // WHY: because `toCwd` returns absolutes unchanged. Multi-`cd` and post-`cd` chains never reach here —
          // WHY: the classifier fails them closed to pass-through (D1).
          // Ref: docs/.archive_adrs/0033-bash-view-interception.md
          const effCwd = baseDir === undefined ? ctx.cwd : deps.toCwd(baseDir, ctx.cwd);
          const resolvedPath = await deps.resolveTarget(deps.toCwd(filePath, effCwd));
          await deps.valAccess(resolvedPath, filePath);
          const file = await deps.loadFileKindAndText(resolvedPath, {
            maxLines: SERVED_MAX_LINES,
            displayPath: filePath,
          });
          if (file.kind !== "text") return undefined;
          const { normalized, fileHashes, absolutePath, originalEnding } = await deps.readNormFile(
            filePath,
            effCwd,
            {
              maxLines: SERVED_MAX_LINES,
              preloadedFile: file,
            },
          );
          // WHY: intervals fold over the re-read line count, so an empty selection (`head -n 0`, an out-of-range
          // WHY: `sed` address) serves nothing and passes through raw — zero leases, zero output change (D3).
          // Ref: docs/.archive_adrs/0033-bash-view-interception.md
          const allLines = deps.visLines(normalized);
          // WHY: (item 9) a content stage needs the line bytes, so it takes its own seam rather than borrowing
          // WHY: the interval algebra. The predicate is the type refinement that keeps a selector-only view
          // WHY: structurally `SliceOp[]` (item 11), and it is the single split over `ViewOp`, so a new content
          // WHY: op routes here by construction.
          if (ops.some(isContentOp)) {
            return await serveContentView(event, ctx, {
              filePath,
              absolutePath,
              normalized,
              fileHashes,
              allLines,
              ops,
              observedText: rawText,
            });
          }
          const intervals = applySliceOps(ops.filter(isSliceOp), allLines.length);
          if (intervals.length === 0 || intervals.length > MAX_READ_WINDOWS) return undefined;
          // WHY: the observed stdout must byte-match the re-read slice — what makes a transparent wrapper (e.g.
          // WHY: `rtk`) safe by construction instead of by reputation. A filtering or numbering wrapper, TOCTOU
          // WHY: drift between exec and re-read, a reordered row or an edited line still fails closed (D9).
          // WHY: Line-ending and BOM skew is normalized rather than rejected: `cat` emits the disk bytes while
          // WHY: `readNormFile` describes the LF/no-BOM text, so comparing raw stdout would drop anchors on
          // WHY: exactly the CRLF and BOM files the model views via bash.
          // Ref: docs/.archive_adrs/0033-bash-view-interception.md
          if (typeof rawText !== "string") return undefined;
          const stdoutText: string = rawText;
          const sliceLines: string[] = [];
          for (const iv of intervals) sliceLines.push(...allLines.slice(iv.lo - 1, iv.hi));
          const joinedSlice = sliceLines.join("\n");
          // WHY: (D1) the `;`-chain gate lives in the classifier; only D9's symmetric CRLF/BOM normalization is
          // WHY: implemented here.
          // Ref: docs/.archive_adrs/0033-bash-view-interception.md
          const observedText = toLF(stripBOM(stdoutText).text);
          if (display !== undefined) {
            // WHY: (D2) the observed bytes are the transform, not the file — so the raw head slice is proved
            // WHY: against the same transform, and only then are the raw rows served.
            // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
            if (originalEnding === "\r") return undefined;
            const rawContent = file.text;
            // WHY: a CRLF file is supported; a lone CR (or a mixed-in CR) is not, because `toLF`
            // WHY: would change the line count and the raw-head bytes would no longer map to intervals.
            if (rawContent.replace(/\r\n/g, "").includes("\r")) return undefined;
            const rawLines = rawContent.split("\n");
            const rawSelected: string[] = [];
            for (const iv of intervals) {
              rawSelected.push(...rawLines.slice(iv.lo - 1, iv.hi));
            }
            if (rawSelected.length === 0) return undefined;
            const lastSelected = intervals[intervals.length - 1];
            const trailingNewline =
              lastSelected !== undefined &&
              (lastSelected.hi < rawLines.length - 1 || rawContent.endsWith("\n"));
            const rawHead = rawSelected.join("\n") + (trailingNewline ? "\n" : "");
            const transformed = await deps.runDisplayTransform(display, rawHead);
            if (transformed === undefined) return undefined;
            // WHY: BSD `cat -vet` leaves a UTF-8 BOM byte-for-byte, so stripping it on only one side would refuse
            // WHY: exactly the BOM files the display tail exists to inspect (D9).
            // Ref: docs/.archive_adrs/0033-bash-view-interception.md
            // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
            if (toLF(stripBOM(transformed).text) !== observedText) return undefined;
          } else if (isNumbered) {
            // WHY: (item 8) the display numbers are stripped and the same byte-equality gate applies; a row-count
            // WHY: or content mismatch fails closed with no lease.
            const deNumbered = parseNumberedStdout(observedText);
            if (deNumbered === undefined) return undefined;
            if (deNumbered.length !== allLines.length) return undefined;
            for (let i = 0; i < allLines.length; i++) {
              if (deNumbered[i] !== allLines[i]) return undefined;
            }
          } else if (observedText !== joinedSlice && observedText !== `${joinedSlice}\n`) {
            return undefined;
          }
          const preview = await deps.fmtReadPreview(
            normalized,
            {
              windows: intervals.map((iv) => ({ offset: iv.lo, limit: iv.hi - iv.lo + 1 })),
            },
            fileHashes,
            absolutePath,
            DEFAULT_MAX_BYTES,
            AUTO_READ_MAX,
          );
          // WHY: anchors add bytes per row, so a view whose raw stdout fits the bash byte budget can still exceed
          // WHY: the preview budget — and a truncated preview would drop lines while its header claims the full
          // WHY: range. A truncated preview is never slice-accurate, so pass through (D3).
          // Ref: docs/.archive_adrs/0033-bash-view-interception.md
          if (preview.truncation !== undefined) return undefined;
          if (preview.served.length === 0) return undefined;
          const sessionKey = deps.sessionKeyFor(ctx);
          // WHY: plain mode (no `resultLineCount`/`firstChangedLine`): truncated mode belongs to diffs and would
          // WHY: corrupt the mirror. The grant leases exactly the served rows against the re-read snapshot (D4).
          // Ref: docs/.archive_adrs/0033-bash-view-interception.md
          await recordServesBestEffort({
            sessionKey,
            path: absolutePath,
            servedRows: preview.served,
            contentHash: snapshotHashFor(normalized),
          });
          // WHY: `servedRowsToSpans` notifies the slice, never whole-file, and reuses the bytes the view already
          // WHY: re-read instead of reading the slice again.
          notifyServedSpans({
            filePath: absolutePath,
            spans: servedRowsToSpans(preview.served),
            source: "auto-read",
            content: normalized,
          });
          // WHY: FULL replacement, not append: the raw stdout is unanchored bytes the model already paid for
          // WHY: once, so swapping it for the anchored slice is the zero-bloat interception point (D4).
          // Ref: docs/.archive_adrs/0033-bash-view-interception.md
          notifyBashViewOnce(ctx, sessionKey);
          const [firstInterval] = intervals;
          const lastInterval = intervals[intervals.length - 1];
          const header = formatPageHeader({
            label: BASH_VIEW_LABEL,
            file: filePath,
            totalLines: allLines.length,
            ...(intervals.length === 1 && firstInterval !== undefined && lastInterval !== undefined
              ? { shownRange: { startLine: firstInterval.lo, endLine: lastInterval.hi } }
              : {}),
          });
          const disclosure =
            display === undefined ? "" : `[${display.label} rendering dropped; raw rows served]\n`;
          return { content: [{ type: "text", text: `${header}\n${disclosure}${preview.text}` }] };
        }

        return await servePureViewBlock(decision.view, singleTextBlock(event), ctx);
      }
      return await renderDecision(conversion);
    } catch (error) {
      // WHY: every failure returns undefined so the original output reaches the model untouched — interception
      // WHY: must never break a view. `E_NOT_FOUND`/`E_ACCESS` mean the file the shell just read is gone
      // WHY: (deleted, chmod, rotating symlink), ordinary in a live workspace and not a defect; anything else
      // WHY: is a classifier or serve bug and must read as one.
      const failureCode = error instanceof DomainError ? error.code : undefined;
      if (failureCode === "E_NOT_FOUND" || failureCode === "E_ACCESS") {
        reportWarning(
          "lifecycle-hooks",
          `bash view declined (${failureCode}) — source changed after exec:`,
          command,
          error,
        );
      } else {
        reportDiagnostic("lifecycle-hooks", "Bash view interception failed:", command, error);
      }
      return undefined;
    }
  }

  // WHY: (item 10) the classifier is pure and zero-fs, so the file kind is re-checked here — a target that
  // WHY: is not decodable text fails the WHOLE serve closed rather than being silently skipped.
  async function loadTextTarget(
    displayPath: string,
    effCwd: string,
  ): Promise<
    | { absolutePath: string; normalized: string; fileHashes: string[]; allLines: string[] }
    | undefined
  > {
    const resolvedPath = await deps.resolveTarget(deps.toCwd(displayPath, effCwd));
    await deps.valAccess(resolvedPath, displayPath);
    const file = await deps.loadFileKindAndText(resolvedPath, {
      maxLines: SERVED_MAX_LINES,
      displayPath,
    });
    if (file.kind !== "text") return undefined;
    const { normalized, fileHashes, absolutePath } = await deps.readNormFile(displayPath, effCwd, {
      maxLines: SERVED_MAX_LINES,
      preloadedFile: file,
    });
    return { absolutePath, normalized, fileHashes, allLines: deps.visLines(normalized) };
  }

  // WHY: (D1) serve admission is by resolved path, never by content matching, so no anchor from one file
  // WHY: can bleed into another. The triple regex splits `FILE:LINE:content` non-greedily, so when two
  // WHY: splits of one observed row both resolve into the admitted set, the row would be served under a
  // WHY: coordinate bash never printed. Twin: file `a` line 1 == `b.txt:3:x` and file `a:1:b.txt` line 3
  // WHY: == `x` produce the identical row `a:1:b.txt:3:x`. So every split whose suffix is a line-number
  // WHY: shape is enumerated and its prefix resolved — resolved, never display-matched, because `admitted`
  // WHY: displays are `path.join`-normalized while bash prints the operand spelling. A prefix that fails to
  // WHY: resolve is not a file and is skipped, never a refusal: matched content beginning `digits:` yields
  // WHY: phantom candidates, and refusing on throw would make the common content-with-colons case
  // WHY: unservable. More than one distinct resolved path fails the WHOLE serve closed before the first
  // WHY: lease — alias spellings of one path are not ambiguous. Residual, still fail-closed:
  // WHY: `resolveTarget` resolves a deleted admitted file lexically, so the serve then fails at
  // WHY: `valAccess` before the first lease.
  // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
  async function tripleSplitAmbiguous(
    rawLines: readonly string[],
    effCwd: string,
    admitted: ReadonlyMap<string, string>,
  ): Promise<boolean> {
    // WHY: ambiguity needs two admitted paths — a single-operand search skips the fs cost whole.
    if (admitted.size < 2) return false;
    for (const raw of rawLines) {
      const resolved = new Set<string>();
      let idx = raw.indexOf(":");
      while (idx !== -1) {
        const prefix = raw.slice(0, idx);
        const rest = raw.slice(idx + 1);
        const numbered = /^(\d+):[\s\S]*$/.exec(rest);
        const line = numbered === null ? NaN : Number(numbered[1]);
        if (Number.isSafeInteger(line) && line >= 1) {
          try {
            const abs = await deps.resolveTarget(deps.toCwd(prefix, effCwd));
            if (admitted.has(abs)) {
              resolved.add(abs);
              if (resolved.size > 1) return true;
            }
          } catch {
            // WHY: a prefix that does not resolve cannot be an admitted path — skipping it is the answer,
            // WHY: not a swallowed error, because admission is the only question this gate asks.
          }
        }
        idx = raw.indexOf(":", idx + 1);
      }
    }
    return false;
  }

  // WHY: (item 10) every gate runs before the first lease, so a refusal grants nothing (invariant 2) and
  // WHY: an over-cap search passes through raw instead of truncating (invariant 3). Sections render in
  // WHY: operand order under the admitted display — `sub/a` where bash printed `./sub/a` — so coordinates
  // WHY: stay stable.
  async function serveMatchTriples(
    event: ToolResultEvent,
    ctx: ToolContext,
    input: { effCwd: string; admitted: ReadonlyMap<string, string> },
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    const stdoutText = singleTextBlock(event);
    if (stdoutText === undefined) return undefined;
    const normalizedObserved = toLF(stripBOM(stdoutText).text);
    const parsed = parseTripleStdout(normalizedObserved);
    if (parsed === undefined || parsed.length === 0) return undefined;
    if (parsed.length > SEARCH_MAX_MATCHES) return undefined;
    // WHY: (D1) the ambiguity gate runs on raw lines, not parsed rows, so every candidate split is
    // WHY: enumerated before the first lease is recorded.
    // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
    const rawLines = normalizedObserved.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
    if (await tripleSplitAmbiguous(rawLines, input.effCwd, input.admitted)) return undefined;
    const grouped = new Map<string, Array<{ line: number; content: string }>>();
    for (const row of parsed) {
      const resolved = await deps.resolveTarget(deps.toCwd(row.file, input.effCwd));
      // WHY: a triple may only name a file this command could have read — `../` escapes, alias
      // WHY: spellings that resolve outside the set, and unwalked subtrees all fail closed.
      if (!input.admitted.has(resolved)) return undefined;
      const rows = grouped.get(resolved) ?? [];
      // WHY: (review F3) a repeated `(file, line)` coordinate renders and leases ONCE — `grep -n pat a.txt
      // WHY: a.txt` repeats it only because the operand did, and a second copy witnesses nothing new.
      if (!rows.some((existing) => existing.line === row.line)) {
        rows.push({ line: row.line, content: row.content });
      }
      grouped.set(resolved, rows);
    }
    // WHY: the dedupe above already yields one row per `(file, line)`, so what this refuses is not the
    // WHY: bijection but an unproven render order: a reordering consumer's rows fail the whole serve closed
    // WHY: here, with zero leases.
    for (const rows of grouped.values()) {
      for (let i = 1; i < rows.length; i++) {
        if (rows[i]!.line <= rows[i - 1]!.line) return undefined;
      }
    }
    if (grouped.size === 0 || grouped.size > BASH_SEARCH_MAX_FILES) return undefined;
    const verified: Array<{
      display: string;
      absolutePath: string;
      normalized: string;
      allLines: string[];
      servedRows: ServedRow[];
    }> = [];
    for (const [resolved, rows] of grouped) {
      const display = input.admitted.get(resolved) ?? resolved;
      const target = await loadTextTarget(display, input.effCwd);
      if (target === undefined) return undefined;
      const servedRows: ServedRow[] = [];
      for (const row of rows) {
        // WHY: byte equality per matched line against the re-read snapshot is the witness that the anchored row
        // WHY: is the line bash printed; a stale or forged row fails the WHOLE serve, so no partial grant (D9).
        // Ref: docs/.archive_adrs/0033-bash-view-interception.md
        if (target.allLines[row.line - 1] !== row.content) return undefined;
        const hash = target.fileHashes[row.line - 1];
        if (hash === undefined) return undefined;
        servedRows.push({ position: row.line - 1, hash });
      }
      verified.push({ display, ...target, servedRows });
    }
    const sessionKey = deps.sessionKeyFor(ctx);
    const blocks: string[] = [];
    for (const group of verified) {
      // WHY: the lease key is the existing `(session, file_path, anchor)` triple, so per-file
      // WHY: leases ride the path Tier 1 already uses — no new identity, no #24 revival.
      await recordServesBestEffort({
        sessionKey,
        path: group.absolutePath,
        servedRows: group.servedRows,
        contentHash: snapshotHashFor(group.normalized),
      });
      notifyServedSpans({
        filePath: group.absolutePath,
        spans: servedRowsToSpans(group.servedRows),
        source: "auto-read",
        content: group.normalized,
      });
      const count = group.servedRows.length;
      blocks.push(
        `[${group.display} (${count} ${count === 1 ? "match" : "matches"})]\n${fmtServedRows(group.servedRows, group.allLines)}`,
      );
    }
    notifyBashViewOnce(ctx, sessionKey);
    return {
      content: [{ type: "text", text: `${bashBanner("search")}\n${blocks.join("\n")}` }],
    };
  }

  // WHY: (item 10) the walk is breadth-first, excludes hidden and `node_modules` directories, and follows
  // WHY: no symlink — a `Dirent`'s `isFile()` does not follow one. Past `BASH_SEARCH_WALK_MAX_FILES` the
  // WHY: WHOLE command passes through raw.
  async function walkSearchFiles(
    rootAbsolute: string,
    rootDisplay: string,
  ): Promise<Map<string, string> | undefined> {
    const found = new Map<string, string>();
    let root;
    try {
      root = await lstat(rootAbsolute);
    } catch {
      return undefined;
    }
    if (root.isSymbolicLink()) return undefined;
    if (root.isFile()) {
      found.set(rootAbsolute, rootDisplay);
      return found;
    }
    if (!root.isDirectory()) return undefined;
    const queue: Array<{ abs: string; display: string }> = [
      { abs: rootAbsolute, display: rootDisplay },
    ];
    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      let entries;
      try {
        entries = await readdir(current.abs, { withFileTypes: true });
      } catch {
        return undefined;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (isWalkableDirName(entry.name)) {
            queue.push({
              abs: join(current.abs, entry.name),
              display: join(current.display, entry.name),
            });
            // WHY: (review F4) the visit bound must cover DIRECTORIES too: a forest of empty
            // WHY: directories has no files to count, so an unbounded queue would walk it whole.
            if (queue.length > BASH_SEARCH_WALK_MAX_FILES) return undefined;
          }
          continue;
        }
        if (!entry.isFile()) continue;
        visited += 1;
        if (visited > BASH_SEARCH_WALK_MAX_FILES) return undefined;
        found.set(join(current.abs, entry.name), join(current.display, entry.name));
      }
    }
    return found;
  }

  // WHY: (item 10) triples require a numbered spelling that the `tool_call` rewrite supplies, so a command
  // WHY: reaching here without it fails closed rather than serving an unverifiable geometry.
  async function handleBashMultiSearch(
    event: ToolResultEvent,
    ctx: ToolContext,
    search: BashMultiSearch,
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    if (!search.lineNumbered) return undefined;
    const effCwd = search.baseDir === undefined ? ctx.cwd : deps.toCwd(search.baseDir, ctx.cwd);
    const admitted = new Map<string, string>();
    for (const filePath of search.filePaths) {
      admitted.set(await deps.resolveTarget(deps.toCwd(filePath, effCwd)), filePath);
    }
    return await serveMatchTriples(event, ctx, { effCwd, admitted });
  }

  // WHY: (item 10) only files the walk visited can be leased, so the exclusion list is what keeps
  // WHY: `node_modules`/`.git`/hidden subtrees out of the anchor budget.
  async function handleBashRecursiveSearch(
    event: ToolResultEvent,
    ctx: ToolContext,
    search: BashRecursiveSearch,
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    if (!search.lineNumbered) return undefined;
    const effCwd = search.baseDir === undefined ? ctx.cwd : deps.toCwd(search.baseDir, ctx.cwd);
    const rootResolved = await deps.resolveTarget(deps.toCwd(search.dirPath, effCwd));
    const walked = await walkSearchFiles(rootResolved, search.dirPath);
    if (walked === undefined) return undefined;
    return await serveMatchTriples(event, ctx, { effCwd, admitted: walked });
  }

  // WHY: (item 10) every entry is checked against the walk inside the same count cap, and NOTHING is
  // WHY: leased — a path list has no lines to anchor, so listing grants no edit rights.
  async function handleBashFilesList(
    event: ToolResultEvent,
    ctx: ToolContext,
    search: BashFilesList,
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    const effCwd = search.baseDir === undefined ? ctx.cwd : deps.toCwd(search.baseDir, ctx.cwd);
    const rootDisplay = search.dirPath ?? ".";
    const rootResolved = await deps.resolveTarget(deps.toCwd(rootDisplay, effCwd));
    const walked = await walkSearchFiles(rootResolved, rootDisplay);
    if (walked === undefined) return undefined;
    // WHY: (review F5) no `valAccess`/`loadFileKindAndText` here on purpose: a path list has no bytes to
    // WHY: witness and grants no anchors, so the walk's membership is the whole witness chain. The cap is a
    // WHY: scope bound on how many paths one listing may name, not an anchor budget, so a larger listing
    // WHY: passes through raw (D10).
    // Ref: docs/.archive_adrs/0033-bash-view-interception.md
    const stdoutText = singleTextBlock(event);
    if (stdoutText === undefined) return undefined;
    const lines = toLF(stripBOM(stdoutText).text).split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0 || lines.length > BASH_SEARCH_MAX_FILES) return undefined;
    for (const entry of lines) {
      if (entry === "" || !walked.has(await deps.resolveTarget(deps.toCwd(entry, effCwd)))) {
        return undefined;
      }
    }
    return {
      content: [{ type: "text", text: `${bashBanner("file-list")}\n${lines.join("\n")}` }],
    };
  }

  // WHY: (item 9) a filter's survivors are sparse, so they are leased row by row exactly like a search's
  // WHY: matches rather than under the read tool's window budget, which would pass a realistic sparse
  // WHY: filter through raw. The whole-stdout byte gate is the witness: a literal fold that diverges from
  // WHY: what bash printed (a regex pattern, an `-i` spelling) fails closed instead of being served as if
  // WHY: it were the command's output. (item 11) `sort -u`/`uniq` reorder the rows, so the header names
  // WHY: the order while every lease keeps its file coordinate; `wc -l` is terminal and takes the count
  // WHY: gate (D10).
  // Ref: docs/.archive_adrs/0033-bash-view-interception.md
  async function serveContentView(
    event: ToolResultEvent,
    ctx: ToolContext,
    input: {
      filePath: string;
      absolutePath: string;
      normalized: string;
      fileHashes: string[];
      allLines: string[];
      ops: ViewOp[];
      observedText?: string | undefined;
    },
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    const { applyViewOps } = await import("../bash-classifier.js");
    const stdoutText = input.observedText ?? singleTextBlock(event);
    if (stdoutText === undefined) return undefined;
    const observedText = toLF(stripBOM(stdoutText).text);
    const survivors = applyViewOps(
      input.ops,
      input.allLines.map((text, index) => ({ line: index + 1, text })),
    );
    // WHY: `SEARCH_MAX_MATCHES` bounds a content stage exactly as it bounds a search, and an empty fold has
    // WHY: no row to lease — both pass the WHOLE stdout through, never a truncated or invented render.
    if (survivors.length === 0 || survivors.length > SEARCH_MAX_MATCHES) return undefined;
    let rows: ContentLine[];
    if (input.ops.some((op) => op.kind === "count")) {
      // WHY: (item 11) `wc -l` prints the NUMBER, not the content, so the count REPLACES the byte gate; a
      // WHY: count the fold does not produce refuses the whole serve with zero leases.
      const observed = COUNT_STDOUT_LINE.exec(observedText);
      if (observed === null || Number(observed[1]) !== survivors.length) return undefined;
      // WHY: the counted rows render in FILE order — the number is checkable only against stable
      // WHY: coordinates, not against the stream order a preceding consumer established.
      rows = [...survivors].sort((left, right) => left.line - right.line);
    } else {
      const joined = survivors.map((entry) => entry.text).join("\n");
      if (observedText !== joined && observedText !== `${joined}\n`) return undefined;
      rows = survivors;
    }
    const servedRows: ServedRow[] = [];
    for (const entry of rows) {
      const hash = input.fileHashes[entry.line - 1];
      if (hash === undefined) return undefined;
      servedRows.push({ position: entry.line - 1, hash });
    }
    const sessionKey = deps.sessionKeyFor(ctx);
    await recordServesBestEffort({
      sessionKey,
      path: input.absolutePath,
      servedRows,
      contentHash: snapshotHashFor(input.normalized),
    });
    notifyServedSpans({
      filePath: input.absolutePath,
      spans: servedRowsToSpans(servedRows),
      source: "auto-read",
      content: input.normalized,
    });
    notifyBashViewOnce(ctx, sessionKey);
    const count = servedRows.length;
    return {
      content: [
        {
          type: "text",
          text: `${viewHeader(input.filePath, input.ops, count)}\n${fmtServedRows(servedRows, input.allLines)}`,
        },
      ],
    };
  }

  // WHY: the stdout is normalized rather than rejected — `grep` emits the disk bytes, so a CRLF file
  // WHY: yields `5:line5\r` while `readNormFile` describes LF/no-BOM text; `toLF(stripBOM(...))` is the
  // WHY: same D9 normalization `handleBash` applies to a view, which keeps both seams consistent.
  // Invariant: every gate fails closed to `undefined` (raw bash output untouched) — a non-zero
  // Invariant: exit or zero matches, an unparsable row, more than `SEARCH_MAX_MATCHES` rows, a
  // Invariant: byte mismatch on any line, or a line the hash array does not cover. Truncating or
  // Invariant: partially leasing would serve anchors for lines the model never saw.
  // WHY: (D1) expected bytes come from re-read disk, never from the observed stdout, so no candidate can
  // WHY: invent bytes: longest-first exact candidates, a prefix match is consumed, and if none matches the
  // WHY: peel halts rather than leasing.
  // Ref: docs/.archive_adrs/0039-compound-bash-view-interception.md
  async function segmentExpectedVariants(
    segment: CompoundSegment,
    effCwd: string,
  ): Promise<string[] | undefined> {
    // WHY: (D10) a raw tail has no predicted bytes, so it rides through unleased — the block above carries
    // WHY: the only leases.
    // Ref: docs/.archive_adrs/0039-compound-bash-view-interception.md
    if (segment.kind === "raw") return undefined;

    if (segment.kind === "glue") {
      return [segment.glue.expectedText];
    }
    if (segment.kind === "view") {
      const resolved = await resolveSegmentFile(segment.filePath, effCwd);
      if (resolved === undefined) return undefined;
      const intervals = applySliceOps(segment.ops.filter(isSliceOp), resolved.allLines.length);
      if (segment.lineNumbered === true) {
        if (intervals.length === 0) return [""];
        const numbered = resolved.allLines.map(
          (line, index) => `${String(index + 1).padStart(6)}\t${line}`,
        );
        return variantsOf(numbered.join("\n"));
      }
      if (intervals.length === 0) return [""];
      const selected: string[] = [];
      for (const iv of intervals) selected.push(...resolved.allLines.slice(iv.lo - 1, iv.hi));
      return variantsOf(selected.join("\n"));
    }
    const family = segment.family;
    if (family.kind !== "pureSearch") return undefined;
    // WHY: predicting a context block byte-exactly would mean reproducing grep's window-merge and `--`
    // WHY: separator rules from disk, which is not part of D3 — so the peel halts here and the rest rides
    // WHY: through raw with zero leases, never a guessed block.
    // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
    if (family.search.context !== undefined) return undefined;
    const resolved = await resolveSegmentFile(family.search.filePath, effCwd);
    if (resolved === undefined) return undefined;
    const rows: ServedRow[] = [];
    for (let i = 0; i < resolved.diskLines.length; i++) {
      const content = resolved.diskLines[i];
      if (content === undefined || !content.includes(family.search.pattern)) continue;
      const hash = resolved.fileHashes[i];
      if (hash === undefined) return undefined;
      rows.push({ position: i, hash });
    }
    const shown = applySliceToServedRows(rows, family.search.sliceOps ?? []);
    if (shown.length === 0) return [""];
    const text = shown
      .map((row) => `${row.position + 1}:${resolved.diskLines[row.position]}`)
      .join("\n");
    return variantsOf(text);
  }
  function variantsOf(base: string): string[] {
    return base === "" ? [""] : [`${base}\n`, base];
  }
  async function resolveSegmentFile(
    filePath: string,
    effCwd: string,
  ): Promise<
    | { normalized: string; allLines: string[]; fileHashes: string[]; diskLines: string[] }
    | undefined
  > {
    const resolvedPath = await deps.resolveTarget(deps.toCwd(filePath, effCwd));
    await deps.valAccess(resolvedPath, filePath);
    const file = await deps.loadFileKindAndText(resolvedPath, {
      maxLines: SERVED_MAX_LINES,
      displayPath: filePath,
    });
    if (file.kind !== "text") return undefined;
    const { normalized, fileHashes } = await deps.readNormFile(filePath, effCwd, {
      maxLines: SERVED_MAX_LINES,
      preloadedFile: file,
    });
    const allLines = deps.visLines(normalized);
    return { normalized, allLines, fileHashes, diskLines: allLines };
  }
  async function handleBashSearch(
    event: ToolResultEvent,
    ctx: ToolContext,
    search: BashSearch,
    observedText?: string,
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    // WHY: the single pre-search literal `cd` re-bases relative resolution exactly as the view seam does.
    const effCwd = search.baseDir === undefined ? ctx.cwd : deps.toCwd(search.baseDir, ctx.cwd);
    const resolvedPath = await deps.resolveTarget(deps.toCwd(search.filePath, effCwd));
    await deps.valAccess(resolvedPath, search.filePath);
    // WHY: the classifier cannot see the filesystem, so the target is re-checked before any stdout is
    // WHY: parsed — a directory operand's stdout is triples, not the `LINE:content` rows below.
    const file = await deps.loadFileKindAndText(resolvedPath, {
      maxLines: SERVED_MAX_LINES,
      displayPath: search.filePath,
    });
    if (file.kind === "directory") {
      // WHY: (item 10) rg recurses by default, so a directory operand delegates to the walk seam; grep needs
      // WHY: its explicit `-r` and errors instead, so the same operand stays raw.
      if (search.program !== "rg") return undefined;
      return await handleBashRecursiveSearch(event, ctx, {
        program: "rg",
        pattern: search.pattern,
        dirPath: search.filePath,
        lineNumbered: search.lineNumbered,
        ...(search.baseDir !== undefined ? { baseDir: search.baseDir } : {}),
      });
    }
    if (file.kind !== "text") return undefined;
    const stdoutText = observedText ?? singleTextBlock(event);
    if (stdoutText === undefined) return undefined;
    const rows = parseSearchStdout(
      toLF(stripBOM(stdoutText).text),
      search.context === undefined ? undefined : { context: true },
    );
    if (rows === undefined || rows.length === 0) return undefined;
    const matchLines = searchRowsWithinBudget(rows, search.context);
    if (matchLines === undefined) return undefined;
    // WHY: the printed number is a label whose ORDER the stream proves, not content matching — a descending
    // WHY: or repeated label breaks it, so the WHOLE serve fails closed with zero leases. Real `grep`/`rg`
    // WHY: on one file print ascending, so nothing served regresses.
    // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]!.line <= rows[i - 1]!.line) return undefined;
    }
    const { normalized, fileHashes, absolutePath } = await deps.readNormFile(
      search.filePath,
      effCwd,
      {
        maxLines: SERVED_MAX_LINES,
        preloadedFile: file,
      },
    );
    const diskLines = deps.visLines(normalized);
    const servedRows: ServedRow[] = [];
    for (const { line, content } of rows) {
      if (diskLines[line - 1] !== content) return undefined;
      const hash = fileHashes[line - 1];
      if (hash === undefined) return undefined;
      servedRows.push({ position: line - 1, hash });
    }
    // WHY: (D3) a pipelined search slices the resolved rows, not the file: only survivors are leased and
    // WHY: counted, and an empty survivor set declines rather than claiming success.
    // Ref: docs/.archive_adrs/0039-compound-bash-view-interception.md
    const shownRows = applySliceToServedRows(servedRows, search.sliceOps ?? []);
    if (shownRows.length === 0) return undefined;
    // WHY: (D3) the header count names what the block HOLDS — hits, plus context rows once a window was
    // WHY: served — so a plain search's frozen `[file (N matches)]` literal stays byte-identical.
    // Ref: docs/.archive_adrs/0048-bash-serve-admission-display-context-compound.md
    const shownMatchRows = shownRows.filter((row) => matchLines.has(row.position + 1)).length;
    const shownContextRows = shownRows.length - shownMatchRows;
    const sessionKey = deps.sessionKeyFor(ctx);
    await recordServesBestEffort({
      sessionKey,
      path: absolutePath,
      servedRows: shownRows,
      contentHash: snapshotHashFor(normalized),
    });
    notifyServedSpans({
      filePath: absolutePath,
      spans: servedRowsToSpans(shownRows),
      source: "auto-read",
      content: normalized,
    });
    // WHY: the header is frozen (spec §3.4): only the count's noun varies, so the chrome stays put.
    const matchNoun = shownMatchRows === 1 ? "match" : "matches";
    const contextNoun = shownContextRows === 1 ? "line" : "lines";
    const matches = `${shownMatchRows} ${matchNoun}`;
    const count =
      shownContextRows === 0 ? matches : `${matches}, ${shownContextRows} context ${contextNoun}`;
    const header = `${bashBanner("search")}\n[${search.filePath} (${count})]`;
    notifyBashViewOnce(ctx, sessionKey);
    return {
      content: [{ type: "text", text: `${header}\n${fmtServedRows(shownRows, diskLines)}` }],
    };
  }

  // WHY: (D3) each row carries its original file line, so a positional fold keeps original numbers by
  // WHY: construction — `slice`, never a line split. The `SliceOp` union is kept total so a new kind
  // WHY: breaks typecheck here.
  // Ref: docs/.archive_adrs/0039-compound-bash-view-interception.md
  function applySliceToServedRows(rows: ServedRow[], ops: SliceOp[]): ServedRow[] {
    let shown = rows;
    for (const op of ops) {
      switch (op.kind) {
        case "first":
          shown = shown.slice(0, Math.max(0, op.n));
          break;
        case "last":
          shown = op.n <= 0 ? [] : shown.slice(Math.max(0, shown.length - op.n));
          break;
        case "from":
          shown = shown.slice(Math.max(0, op.n - 1));
          break;
        case "dropLast":
          shown = shown.slice(0, Math.max(0, shown.length - op.n));
          break;
        case "range":
          shown = shown.slice(Math.max(0, op.from - 1), Math.max(0, op.to));
          break;
        default:
          // WHY: `assertNever` carries the union's exhaustiveness to the compiler: a sixth SliceOp
          // WHY: kind fails the build here instead of passing silently through the fold.
          return assertNever(op);
      }
    }
    return shown;
  }

  async function handleToolResult(
    event: ToolResultEvent,
    ctx: ToolContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown } | undefined> {
    if (event.isError) return undefined;
    if (event.toolName === "write") {
      return handleWrite(event, ctx);
    }
    if (event.toolName === "edit" || event.toolName === "undo_last_edit") {
      return handleEdit(event, ctx);
    }
    if (event.toolName === "bash") {
      return handleBash(event, ctx);
    }
    return undefined;
  }

  return {
    onSessionStart: handleSessionStart,
    onToolResult: handleToolResult,
    onWrite: handleWrite,
    onEdit: handleEdit,
    onBash: handleBash,
  };
}

export function registerLifecycleHooks(
  pi: ExtensionAPI,
  overrides: Partial<LifecycleDeps> = {},
): ReturnType<typeof createLifecycleHooks> {
  const hooks = createLifecycleHooks(overrides);
  // SAFETY: ExtensionAPI on() typed for known events — string-key widening validated by lifecycle hook contract
  // SAFETY: string-key widening for session_start
  (pi as unknown as { on: (e: string, h: unknown) => void }).on(
    "session_start",
    // SAFETY: onSessionStart handler tuple overload — cast to never validated by handleSessionStart signature
    hooks.onSessionStart as unknown as never,
  );
  // SAFETY: ExtensionAPI on() typed for known events — string-key widening for tool_result delegation
  (pi as unknown as { on: (e: string, h: unknown) => void }).on(
    "tool_result",
    // SAFETY: onToolResult handler tuple overload — cast to never validated by handleToolResult signature
    hooks.onToolResult as unknown as never,
  );
  return hooks;
}
