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
/** WHY: (ADR-0048 D3) one parsed search row and which geometry printed it. */
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
 * WHY: (ADR-0048 D3 — context searches) a row is a MATCH (`LINE:content`) or — only when the command
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
 * WHY: (ADR-0048 D3 — the search's own prediction half of D1) a CONTEXT row is witnessable only when
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
 * WHY: (ADR-0048 D3) the row-budget and prediction gates of one search, all BEFORE the first lease.
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
 * WHY: (ADR-0049 M3) one selected row of the concatenated stream: which page it belongs to, its
 * file-relative line, its stream line, and the bytes the re-read file holds there.
 */
interface MultiViewStreamRow {
  readonly fileIndex: number;
  readonly fileLine: number;
  readonly streamLine: number;
  readonly text: string;
}

/**
 * WHY: (ADR-0049 M3) boundaries are LINE COUNTS. The operands are laid end to end; each file owns
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
 * WHY: (ADR-0049 M3) the stream rows in stream order, built from the RE-READ files — the observed
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
 * WHY two numbering candidates (ADR-0049 M3): the numbering transform is `cat -n` / `nl -ba`, and the
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
    // WHY: strict 1-based sequencing — `cat -n`/`nl -ba` number every line from 1.
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
      // SAFETY: best-effort serve recording — failures are ignored; file edit already succeeded and next read will re-establish serves, no data loss.
      reportDiagnostic("lifecycle-hooks", "Failed to record served rows:", error);
    }
  }

  async function handleSessionStart(_event: unknown, ctx: ToolContext): Promise<void> {
    // WHY: a new session re-arms the first-interception notice the last one consumed.
    warnedBashViewSessions.clear();
    await deps.initHasher();
    try {
      await deps.pruneMissingAll();
    } catch (err) {
      // SAFETY: best-effort startup cleanup — pruneMissingAll failures are ignored; hash store remains usable and stale entries will be retried next startup, no user data loss.
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
        // SAFETY: best-effort undo cleanup after write — clearUndo failures are ignored; stale undo history will be overwritten on next edit or pruned, no data loss.
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
      // WHY: literal declaration audit for `write` (ADR-0009 revision): the pre-write
      // WHY: guard allowed `mode: "literal"` through, so re-evaluate the written bytes
      // WHY: against the pre-auto-read served mirror (still the pre-write mirror here)
      // WHY: and append the dimmed human line when the bytes reproduce a served row.
      let literalBypass = false;
      // WHY: middle tier for `write`: a written line opening with a served anchor
      // WHY: whose remainder canon digest matches none of the digests the leases recorded for that
      // WHY: The bytes are already on disk; each note only informs the model channel,
      // WHY: never alters bytes, never blocks, keeps no state, fires per line.
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
      // WHY: an auto-read re-serves the whole file, so one full-file span is the honest shape here;
      // WHY: a zero-line result sends empty spans, which notifies nobody. The mutation is notified
      // WHY: first, so a mirror that reads the file observes the bytes now on disk.
      notifyServedSpans({
        filePath: absolutePath,
        spans: resultLineCount > 0 ? [{ startLine: 1, lineCount: resultLineCount }] : [],
        source: "auto-read",
        // WHY: the auto-read holds the verbatim bytes, so the mirror hashes caller evidence in
        // WHY: memory; the anchored preview is never the source of a line hash.
        content: normalized,
      });
      // WHY: the clear side of the tally: this runs only after the write's bytes are on disk
      // WHY: (the auto-read above re-served this session's rows), never on the pre-write
      // WHY: verification, which must keep the count for a resubmission.
      try {
        clearServedRefusals(sessionKey, absolutePath);
      } catch {
        // SAFETY: best-effort counter clear — a missed clear only sharpens the next refusal message, never blocks a write.
      }
      // WHY: the auto-read is a whole-file page, so its header states the file's total (and, when the
      // WHY: byte budget cut it, where it stopped) — the same grammar the read tool uses (read-chrome).
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
        // WHY: same contract as the servedByPath branch: the undo or edit landed on disk, and the
        // WHY: details' first/last changed lines bound the changed span (empty when unnamed).
        notifyMutatedFile({
          filePath: resolvedPath,
          kind: "edit",
          ranges: toChangedRanges(details.firstChangedLine, details.lastChangedLine),
          sourceTool: event.toolName === "undo_last_edit" ? "undo_last_edit" : "edit",
        });
        // WHY: mutation first, then the rows it produced, so a mirror that reads the file observes
        // WHY: the post-edit bytes; a diff holds no verbatim text and falls back to disk evidence.
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

  /**
  /**
   * WHY deferred module load: `bash-classifier` statically pulls `unbash`, which must
   * WHY: never join the extension entry graph — entry import cost is budgeted
   * WHY: (`measure-import --max-ratio 0.75`). The handler therefore reaches the
   * WHY: classifier only through a dynamic `import()` on the first bash result.
   * WHY:
   * WHY: Load-shape record (ADR-0033): esbuild bundles the relative specifier into
   * WHY: the entry and hoists the external `unbash` import to a top-level static
   * WHY: import in the shipped artifact, so the artifact is NOT lazy — only the
   * WHY: source entry is. Measured cost is negligible (`unbash` 52 KB parser,
  * WHY: no transitive deps, cold import ~0.01-0.03 ms), and a resolve/eval failure
  * WHY: of the lazily imported classifier still fails closed via the catch below,
  * WHY: which passes the original output through untouched (in the shipped artifact
  * WHY: the hoisted top-level import is instead fatal at entry — same class as the
  * WHY: other entry imports).
   */
  async function handleBash(
    event: ToolResultEvent,
    ctx: ToolContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown } | undefined> {
    if (event.toolName !== "bash") return undefined;
    // WHY: the off switch bypasses EVERY seam below — view, search, content filter,
    // WHY: multi-file, recursive walk and `rg --files` — so raw output passes through
    // WHY: byte-identical. The default is on, so an unconfigured session never reaches this
    // WHY: return.
    if (resolveBashViewMode(ctx.cwd) === "off") return undefined;
    if (event.isError) return undefined;
    const rawInput = event.input as Record<string, unknown> | undefined;
    const command = rawInput?.command;
    if (typeof command !== "string" || command.trim() === "") return undefined;
    // WHY: `ToolResultEvent.details` is typed as `EditDetails`, but the pi runtime
    // WHY: delivers `BashToolDetails` (`truncation`, `fullOutputPath`) for bash —
    // WHY: read it structurally. A truncated stdout means the model did NOT see
    // WHY: the whole file, so replacing it with anchored lines would invent
    // WHY: viewed lines: fail closed.
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
      /**
       * WHY (#151): the single decision switch — every conversion shape routes by
       * WHY: `decision.kind`; no shape-sniffing, no stringified reasons downstream (the
       * WHY: debug seam below records the reason in the diagnostics file, never in the model's
       * WHY: text (ADR-0033 D6: observability is never model-visible). Banners and headers stay
       * WHY: in the shape seams this calls; this is where the routing decision lands.
       */
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
        // WHY: (ADR-0049 M2) the multi-file view is N pages in one result: its own seam, because the
        // WHY: proof is per-file line-count boundaries and its leases are per file.
        if (decision.kind === "pureMultiView") {
          return await handleBashMultiView(event, ctx, decision.view);
        }
        if (decision.kind === "pureCompound") {
          return await handleBashCompound(event, ctx, decision);
        }
        if (decision.kind !== "pureView") {
          // WHY: (ADR-0033 observability) a systematic regression (parser drift, a
          // WHY: filtering wrapper, a new view shape) is otherwise indistinguishable
          // WHY: from "no views issued". Log the internal reason behind the existing
          // WHY: debug seam — the diagnostics log, never the model's text (D6 holds).
          const debugValue = process.env.PI_HASHLINE_DEBUG;
          if (debugValue === "1" || debugValue === "true") {
            reportDiagnostic("lifecycle-hooks", `[bash-view] pass-through (${decision.reason})`);
          }
          return undefined;
        }
        /**
         * WHY: shared view serving (single views call it with whole stdout; the envelope calls it
         * WHY: per verified slice). Pure relocation of the branch body — `event`, `deps` and helpers
         * WHY: resolve via closure. Throws propagate to the caller SAFETY catch.
         */
        /**
         * WHY: (ADR-0039 D1/D2/D4) sequential peeling + hybrid envelope. Each segment's expected raw
         * WHY: bytes come from re-read disk (never observed stdout); the peel consumes exact prefixes
         * WHY: left-to-right and halts at the first mismatch, keeping verified prefix rendering and
         * WHY: leases with the rest raw. Glue contributes verified bytes verbatim; views/searches
         * WHY: render anchored blocks via the shared paths on verified slices. Zero blocks, nothing
         * WHY: verified, or a trailing remainder beyond lone-newline leniency returns undefined (F2).
         */
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
            // fall through to partial halt below (SAFETY: never break the view).
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
        /**
         * WHY: (ADR-0039 D2/D4) render one verified envelope block (single trailing newline; glue
         * WHY: stays byte-exact). Views/searches render through the shared serving paths on their
         * WHY: verified slice (their internal gates re-verify defensively); multi/recursive/file-list
         * WHY: searches never reach here (no expected variants — the peel halts first). An empty
         * WHY: search renders its banner with zero rows and zero leases rather than halting the rest.
         */
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
        /**
         * WHY (ADR-0049 M2/M3): a served multi-file view is ONE result with ONE page section per file,
         * in operand order, under the existing page header grammar — no new root
         * banner and no second chrome dialect. Every page's rows come from its own re-read file and are
         * leased under the existing `(session, path, anchor)` identity: no anchor is ever shared between files.
         *
         * WHY the whole-command gate (M8): boundaries are line counts, so the observed STREAM must
         * equal the render built from the re-read files before the first lease — one bad file, page,
         * transform or cap passes the entire command through raw with zero leases. The zero-row page
         * (M4) has a zero-length observed interval, which is why it cannot weaken that proof.
         */
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
          // WHY: (M3 + ADR-0033 D9 + ADR-0048 D1) the stream the shell printed must equal the render
          // WHY: built from the re-read files, with the same lone-trailing-newline leniency every other
          // WHY: view seam applies. A missing newline, a numbering mismatch, TOCTOU drift or a reordered
          // WHY: row fails closed here, before any lease exists.
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
                // WHY: (M4) a page that serves nothing reports `0 lines total`, so it claims nothing
                // WHY: about the file's length — an empty FILE and a file with no selected row are the
                // WHY: same page, exactly as M4/M5 prescribe.
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
          // WHY: (item 8) numbered and unnumbered are the same view — full-file, leased.
          // WHY: `lineNumbered` only selects the stdout-verification parser; leases and render
          // WHY: always come from re-read positions, never from parsed stdout numbers.
          const isNumbered = lineNumbered === true;
          // WHY: (item 8) numbered views admit no slice ops — the classifier only emits
          // WHY: `ops: []` with the marker, but defense-in-depth fails closed on any drift.
          if (isNumbered && ops.length !== 0) return undefined;
          if (display !== undefined && (isNumbered || ops.some(isContentOp))) return undefined;
          // WHY: the single pre-view literal `cd` re-bases relative resolution; an absolute
          // WHY: view target ignores it (`toCwd` returns absolutes unchanged). Multi-`cd`
          // WHY: and post-view-`cd` chains never reach here — the classifier fails them
          // WHY: closed to pass-through (ADR-0033 D1).
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
          // WHY: intervals fold over the re-read line count, so an empty selection
          // WHY: (e.g. `head -n 0`, out-of-range `sed` addresses) serves nothing and
          // WHY: passes through — zero leases, zero output change (ADR-0033 D3).
          const allLines = deps.visLines(normalized);
          // WHY: (item 9) a content stage needs the line bytes, so it takes its own seam (row
          // WHY: leases over the survivors, bounded like a search). The predicate is the type
          // WHY: refinement that keeps the selector-only path structurally `SliceOp[]`, so the
          // WHY: interval algebra keeps its exact contract.
          // WHY: (item 11) the line-set consumers take this same seam: the predicate is the single
          // WHY: split over `ViewOp`, so a new content op routes here by construction.
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
          // WHY: [ADR-0033 D9] the observed stdout must byte-match the re-read slice —
          // WHY: this is what makes transparent wrappers (e.g. `rtk`) safe by
          // WHY: construction instead of by reputation. A filtering wrapper, a
          // WHY: numbering wrapper, TOCTOU drift between exec and re-read, or any
          // WHY: skew the re-read does not normalize (undecodable bytes, a reordered
          // WHY: row, an edited line) still fails closed to pass-through. Line-ending
          // WHY: and BOM skew is normalized instead of rejected: `cat` emits the disk
          // WHY: bytes while `readNormFile` — and therefore the anchors below —
          // WHY: describes the LF/no-BOM text, so comparing raw stdout would drop
          // WHY: anchors on exactly the CRLF and BOM files the model views via bash.
          // WHY: Exactly one text block is required — anything else (multi-block,
          // WHY: non-text) cannot be attributed to the view.
          // WHY: Trailing-newline-only leniency: `joined` vs `joined + "\n"`.
          if (typeof rawText !== "string") return undefined;
          const stdoutText: string = rawText;
          const sliceLines: string[] = [];
          for (const iv of intervals) sliceLines.push(...allLines.slice(iv.lo - 1, iv.hi));
          const joinedSlice = sliceLines.join("\n");
          // D1/D9, amended 2026-10-09 (commit 7b78278): See ADR-0033. This site
          // WHY: implements D9's symmetric CRLF/BOM normalization here; D1's
          // WHY: `;`-chain gate lives in the classifier.
          const observedText = toLF(stripBOM(stdoutText).text);
          if (display !== undefined) {
            // WHY: (ADR-0048 D2) the observed bytes are the transform, not the file. Prove the
            // WHY: exact raw head slice against the same transform; only then serve the raw rows.
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
            // WHY: (ADR-0033 D9 / ADR-0048 D1) match the observed normalization. BSD `cat -vet`
            // WHY: leaves a UTF-8 BOM byte-for-byte, so stripping it on only one side would refuse
            // WHY: exactly the BOM files the display tail is meant to inspect.
            if (toLF(stripBOM(transformed).text) !== observedText) return undefined;
          } else if (isNumbered) {
            // WHY: (item 8) strip display numbers, then the SAME byte-equality gate as below.
            // WHY: the numbers are never trusted as coordinates — positions come from `intervals`
            // WHY: (full-file here), and a row-count or content mismatch fails closed with no lease.
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
          // WHY: (ADR-0033 D3) anchors add bytes per row, so a view whose raw stdout
          // WHY: fits the bash byte budget can still exceed the preview budget — the
          // WHY: shortened preview would then silently drop lines while the header
          // WHY: claims the full range. A truncated preview is never slice-accurate:
          // WHY: pass through with the original output untouched.
          if (preview.truncation !== undefined) return undefined;
          if (preview.served.length === 0) return undefined;
          const sessionKey = deps.sessionKeyFor(ctx);
          // WHY: plain mode (no `resultLineCount`/`firstChangedLine`): truncated mode
          // WHY: belongs to diffs and would corrupt the mirror. The grant leases
          // WHY: exactly the served rows against the re-read snapshot (ADR-0033 D4).
          await recordServesBestEffort({
            sessionKey,
            path: absolutePath,
            servedRows: preview.served,
            contentHash: snapshotHashFor(normalized),
          });
          // WHY: `servedRowsToSpans` compresses the served window rows into honest
          // WHY: per-run spans — a slice view notifies its slice, never whole-file. The bash
          // WHY: view already re-read the file, so the mirror gets those bytes rather than
          // WHY: re-reading the slice itself.
          notifyServedSpans({
            filePath: absolutePath,
            spans: servedRowsToSpans(preview.served),
            source: "auto-read",
            content: normalized,
          });
          // WHY: FULL replacement (not append): the raw stdout is unanchored bytes the
          // WHY: model already paid for once — swapping it for the anchored slice is
          // WHY: the zero-bloat interception point (ADR-0033 D4).
          // WHY: FIRST-notice: the interception landed, so the session is told once what saved
          // WHY: the round trip and where the off switch lives; later interceptions stay silent.
          notifyBashViewOnce(ctx, sessionKey);
          // WHY: the view's page names itself (read-chrome): one interval is a page, so its header
          // WHY: carries the range; several intervals keep the total and let each section name its own.
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
      // SAFETY: every failure returns undefined so the original bash output reaches
      // SAFETY: the model untouched — interception must never break a view.
      // WHY: the three-way split — a DomainError code means the file the shell just read is no
      // WHY: longer statable/readable (deleted, chmod, rotating symlink); that is expected in a live
      // WHY: workspace and the view already passes through, so it must not read as a defect, while
      // WHY: anything else is a classifier/serve bug and must read as one.
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

  /**
   * WHY: (item 10) resolve + read one candidate file for a triple serve. The classifier is pure
   * WHY: and zero-fs, so the file kind is re-checked here: anything that is not decodable text
   * WHY: fails the WHOLE serve closed rather than being silently skipped.
   */
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

  /**
   * WHY: (ADR-0048 D1 — bash serve admission) never content matching, no
   * WHY: other-file anchor bleed. The triple regex splits `FILE:LINE:content` non-greedily, so
   * WHY: when two splits of one observed row both resolve into the admitted set, the row is
   * WHY: served under a coordinate bash never printed. Concrete twin: file `a` line 1 ==
   * WHY: `b.txt:3:x` and file `a:1:b.txt` line 3 == `x` produce the identical stdout row
   * WHY: `a:1:b.txt:3:x`. Enumerate EVERY split whose suffix is itself a line-number shape
   * WHY: (`^\d+:` with a safe integer >= 1, the parser's own line rule) and resolve the prefix —
   * WHY: candidates are resolved, never display-matched, because `admitted` displays are
   * WHY: `path.join`-normalized (`sub/a`) while bash prints the operand spelling (`./sub/a`
   * WHY: for a `.` root). A prefix that fails to resolve is not a file and is skipped, never a
   * WHY: refusal: matched content beginning `digits:` yields phantom candidates (e.g.
   * WHY: `sub/ok.txt:2:5:foo` yields `sub/ok.txt:2`), and refusing on throw would make the
   * WHY: common content-with-colons case unservable. More than one distinct resolved path
   * WHY: fails the WHOLE serve closed before the first lease — several display aliases of one
   * WHY: resolved path are not ambiguous. Residual, still fail-closed: `resolveTarget` catches
   * WHY: ENOENT and resolves a deleted admitted file lexically, so deletion cannot blind this
   * WHY: guard — the serve then fails at `valAccess` (`E_NOT_FOUND`) in `loadTextTarget` before
   * WHY: the first lease, and the outer `handleBash` catch passes the command through raw.
   */
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
            // SAFETY: an unresolvable prefix is not a file, therefore not admitted — skip.
          }
        }
        idx = raw.indexOf(":", idx + 1);
      }
    }
    return false;
  }

  /**
   * WHY: (item 10) the shared multi-file / recursive serve seam. Every named file must resolve
   * INTO the admitted set (explicit operands or the walked set), every row's bytes must equal
   * the disk line at that number, and the total row count must fit `SEARCH_MAX_MATCHES` — all
   * verified BEFORE the first lease, so a refusal grants nothing (invariant 2) and an over-cap
   * search passes through raw instead of truncating (invariant 3). Sections render in operand /
   * first-seen order under the admitted display (which differs from bash's spelling for a `.`
   * root: `sub/a` renders where bash printed `./sub/a`), so coordinates are stable.
   */
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
    // WHY: (ADR-0048 D1 — bash serve admission) the ambiguity gate below runs
    // WHY: on raw lines, not parsed rows, so every candidate split is enumerated before the
    // WHY: first lease is recorded.
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
      // WHY: (review F3) a repeated `(file, line)` coordinate renders and leases ONCE: the
      // WHY: coordinate set is a set, and `grep -n pat a.txt a.txt` prints the same line twice
      // WHY: only because the operand was repeated. Nothing new is witnessed by a second copy.
      if (!rows.some((existing) => existing.line === row.line)) {
        rows.push({ line: row.line, content: row.content });
      }
      grouped.set(resolved, rows);
    }
    // WHY: (serve-seam policy: one row per file line, rows in stream order) the repeat dedupe
    // WHY: above already yields one row per `(file, line)`, so a reordering would keep the
    // WHY: bijection — what this refuses is an unproven render order from a reordering consumer
    // WHY: (`grep -n pat a.txt a.txt` repeats a coordinate legitimately and still serves). A
    // WHY: reordered file's rows fail the whole serve closed here, with zero leases.
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
        // WHY: [ADR-0033 D9] byte equality per matched line against the re-read snapshot — the
        // WHY: witness that the anchored row is the line bash printed. A stale or forged row
        // WHY: fails the WHOLE serve, so no partial grant can ever be recorded.
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

  /**
   * WHY: (item 10) the walk behind a recursive search and `rg --files`: breadth-first, hidden and
   * `node_modules` directories never descended into, symlinks never followed (a `Dirent`'s
   * `isFile()` does not follow one), and the visit count bounded — past
   * `BASH_SEARCH_WALK_MAX_FILES` the WHOLE command passes through raw.
   */
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

  /**
   * WHY: (item 10) the multi-file seam. Triples require a numbered spelling, and the `tool_call`
   * rewrite supplies it; a command that somehow reaches here without it fails closed instead of
   * serving an unverifiable geometry.
   */
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

  /**
   * WHY: (item 10) the recursive seam over one explicit root (`grep -r PATTERN DIR`, and an `rg`
   * directory operand). Only files the walk actually visited can be leased, so the exclusion list
   * is what keeps `node_modules`/`.git`/hidden subtrees out of the anchor budget.
   */
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

  /**
   * WHY: (item 10) `rg --files`: every entry is existence-checked against the walk (invariant 2)
   * inside the same count cap, and NOTHING is leased — a path list has no lines to anchor, so
   * listing grants no edit rights.
   */
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
    // WHY: (review F5) no `valAccess`/`loadFileKindAndText` here on purpose: a path list has
    // WHY: no bytes to witness and grants no anchors, so the walk's membership is the whole
    // WHY: witness chain. The cap below is the scope bound `constants.ts` states for this
    // WHY: constant: how many paths one listing may name — the brief's "same count cap",
    // WHY: not an anchor budget, because nothing here is leased. A listing larger than it
    // WHY: therefore passes through raw, which ADR-0033 D10 records.
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

  /**
   * WHY: (item 9) the content stage's serve seam. A filter's survivors are sparse, so they are
   * WHY: leased row by row exactly like a search's matches — the same `fmtServedRows` renderer
   * WHY: and `SEARCH_MAX_MATCHES` bound — rather than borrowing the read tool's window budget,
   * WHY: which would pass a realistic sparse filter through raw. The whole-stdout byte gate is
   * WHY: the witness: a literal fold that diverges from what bash printed (a regex pattern, an
   * WHY: `-i` spelling) fails closed here instead of being served as if it were the command's
   * WHY: output. Empty survivors pass through, so a filter that matched nothing leases nothing.
   *
   * WHY: (item 11) the same seam serves the line-SET consumers. `sort -u`/`uniq` reorder the
   * WHY: rows, so the header names the order while every lease keeps the true file coordinate;
   * WHY: `wc -l` is terminal and takes the count gate instead of the byte gate, leasing EVERY
   * WHY: counted row in file order so the number it printed is checkable by editing a row.
   */
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
    // WHY: empty survivors and over-cap output both pass the WHOLE stdout through with zero
    // WHY: leases: `SEARCH_MAX_MATCHES` bounds a content stage exactly as it bounds a search, and
    // WHY: an empty fold has no row to lease — never a truncated or invented render.
    if (survivors.length === 0 || survivors.length > SEARCH_MAX_MATCHES) return undefined;
    let rows: ContentLine[];
    if (input.ops.some((op) => op.kind === "count")) {
      // WHY: (item 11) `wc -l` is terminal and its observed stdout is the NUMBER, not the
      // WHY: content, so the count REPLACES the whole-stdout byte gate. A count the fold does
      // WHY: not produce refuses the whole serve with zero leases.
      const observed = COUNT_STDOUT_LINE.exec(observedText);
      if (observed === null || Number(observed[1]) !== survivors.length) return undefined;
      // WHY: the counted rows render in FILE order — the number is checkable only against stable
      // WHY: coordinates, not against the stream order a preceding consumer established.
      rows = [...survivors].sort((left, right) => left.line - right.line);
    } else {
      // WHY: [ADR-0033 D9] the whole-stdout byte gate against the disk-derived fold; a fold
      // WHY: that diverges from what bash printed fails closed here.
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

  /**
   * [spec §3.4] The `tool_result` half of search interception: parse the `LINE:content` stdout of an
   * already-rewritten search, verify every match against the disk bytes (D9), then swap the raw
   * match list for anchored rows and synchronously enroll their leases.
   *
   * WHY the stdout is normalized rather than rejected: `grep` emits the disk bytes, so a CRLF file
   * yields `5:line5\r` while `readNormFile` — and the anchors served here — describe LF/no-BOM text.
   * `toLF(stripBOM(...))` is exactly the D9 normalization `handleBash` applies to a view, which
   * keeps both seams consistent on the files the model inspects through bash.
   *
   * Every gate fails closed to `undefined` (raw bash output untouched): a non-zero exit or zero
   * matches, an unparsable row, more than `SEARCH_MAX_MATCHES` rows, a byte mismatch on any line, or
   * a line the hash array does not cover. Truncating or partially leasing would serve anchors for
   * lines the model never saw.
   */
  /**
   * WHY: (ADR-0039 D1) expected raw bytes for one envelope segment, computed from re-read disk
   * WHY: content (never from observed stdout). Each entry is an exact byte candidate, longest
   * WHY: first: glue is a single predicted literal; views cover the two D9-accepted trailing
   * WHY: forms; searches cover theirs. A candidate that matches as a prefix is consumed; if none
   * WHY: matches, peeling halts. No candidate invents bytes — mismatch fails closed, never leases.
   */
  async function segmentExpectedVariants(
    segment: CompoundSegment,
    effCwd: string,
  ): Promise<string[] | undefined> {
    // WHY: (ADR-0039 D10) a raw tail has no predicted bytes — its already-observed stdout
    // WHY: passes through via the peel loop's `rest` (the loop breaks on this `undefined`).
    // WHY: Nothing is leased or anchored for it; the block above carries the only leases.
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
    // WHY: (ADR-0048 D3 scope) predicting a context block byte-exactly would mean reproducing grep's
    // WHY: window-merge and `--` separator rules from disk. That prediction is not part of D3, so a
    // WHY: context search segment halts the peel here: the rest rides through raw with zero leases for
    // WHY: it — never a guessed block, and never a regression for the plain search segments beside it.
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
    // WHY: the single pre-search literal `cd` re-bases relative resolution under the same rule as a
    // WHY: view (ADR-0033 D1); multi-`cd` and post-search-`cd` chains never reach here.
    const effCwd = search.baseDir === undefined ? ctx.cwd : deps.toCwd(search.baseDir, ctx.cwd);
    const resolvedPath = await deps.resolveTarget(deps.toCwd(search.filePath, effCwd));
    await deps.valAccess(resolvedPath, search.filePath);
    // WHY: the pure classifier cannot see the filesystem, so the single-operand target is re-checked
    // WHY: FIRST — before any stdout geometry is parsed, because a directory operand's stdout is
    // WHY: `FILE:LINE:content` triples, not the `LINE:content` rows below.
    const file = await deps.loadFileKindAndText(resolvedPath, {
      maxLines: SERVED_MAX_LINES,
      displayPath: search.filePath,
    });
    if (file.kind === "directory") {
      // WHY: (item 10) rg recurses by default, so a directory operand is a recursive search and
      // WHY: delegates to the walk seam. grep needs its explicit `-r`, so the same operand for
      // WHY: grep stays raw — native grep errors on a directory without the marker.
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
    // WHY: exactly one text block, the same attribution rule the view path applies — a search whose
    // WHY: stdout is split or non-text cannot be proven to be this command's output.
    const stdoutText = observedText ?? singleTextBlock(event);
    if (stdoutText === undefined) return undefined;
    const rows = parseSearchStdout(
      toLF(stripBOM(stdoutText).text),
      search.context === undefined ? undefined : { context: true },
    );
    if (rows === undefined || rows.length === 0) return undefined;
    const matchLines = searchRowsWithinBudget(rows, search.context);
    if (matchLines === undefined) return undefined;
    // WHY: (serve-seam policy: one row per file line, rows in stream order — ADR-0048, bash
    // WHY: serve admission, states the no-bleed invariant, not an ordering clause)
    // WHY: the printed number is a label whose ORDER is proven by the stream, not by matching
    // WHY: content. A descending or repeated label breaks stream order, so the WHOLE serve fails
    // WHY: closed with zero leases. Real `grep`/`rg` on one file always print ascending, so
    // WHY: nothing served regresses.
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
      // WHY: [ADR-0033 D9] byte equality per matched line — the witness that the anchored row is the
      // WHY: line bash printed. A stale/forged/stdout-only line fails closed with no lease.
      if (diskLines[line - 1] !== content) return undefined;
      const hash = fileHashes[line - 1];
      if (hash === undefined) return undefined;
      servedRows.push({ position: line - 1, hash });
    }
    // WHY: [ADR-0039 D3] a pipelined search (`grep -n pat f | head -2`) slices the resolved rows,
    // WHY: not the file. Only survivors are leased, rendered and counted; an empty survivor set
    // WHY: declines rather than leasing nothing while claiming success (F4).
    const shownRows = applySliceToServedRows(servedRows, search.sliceOps ?? []);
    if (shownRows.length === 0) return undefined;
    // WHY: (ADR-0048 D3) the header's count names what the block HOLDS: the pattern hits, with the
    // WHY: context rows named beside them once a window was served. A plain search has no context row,
    // WHY: so its frozen `[file (N matches)]` literal is byte-identical to before.
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
    // WHY: the header is frozen (spec §3.4): the same search banner literal from `bashBanner` names
    // WHY: the interception seam, and the bracketed count uses the singular for one match.
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

  /**
   * WHY: [ADR-0039 D3] positional fold over resolved search rows. `first`/`last` (and their
   * WHY: `from`/`dropLast`/`range` siblings, kept total so a new kind breaks typecheck here)
   * WHY: select by stream position; each row already carries its original file line, so surviving
   * WHY: rows keep original numbers by construction. Uses `slice`, never a line split.
   */
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
  (pi as unknown as { on: (e: string, h: unknown) => void }).on(
    // SAFETY: string-key widening for session_start
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
