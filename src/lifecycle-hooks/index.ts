import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  initHasher as defaultInitHasher,
  findServedHashEcho,
  findServedPrefixMismatches,
  buildServedWritePrefixNote,
  LITERAL_BYPASS_NOTICE,
  clearServedRefusals,
} from "../hashline/index.js";
import { splitLines } from "../utils.js";
import { denseServeRows, fmtServedRows, type ServedRow } from "../hashline/served.js";
import { notifyServedSpans, servedRowsToSpans, type ServedSpan } from "../served-spans.js";
import { notifyMutatedFile } from "../mutated-files.js";
import { resolveBashViewMode } from "../bash-view-config.js";
import { pruneMissingAll as defaultPruneMissingAll } from "../snapshot-store";
import { clearUndo as defaultClearUndo } from "../edit-undo.js";
import { stripBOM, toLF } from "../edit-diff.js";
import {
  createSessionHandle,
  sessionKeyFor as defaultSessionKeyFor,
} from "../served-session/session.js";
import { snapshotHashFor } from "../snapshot-store";

async function defaultRecordDiffServes(input: {
  sessionKey: string;
  path: string;
  servedRows: import("../hashline/served.js").ServedRow[];
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
import { finalizeToolResult as defaultFinalizeToolResult } from "../edit-response.js";
import {
  AUTO_READ_MAX,
  BASH_SEARCH_MAX_FILES,
  BASH_SEARCH_WALK_MAX_FILES,
  MAX_READ_WINDOWS,
  SEARCH_MAX_MATCHES,
  SERVED_MAX_LINES,
} from "../constants.js";
import type {
  BashFilesList,
  BashMultiSearch,
  BashRecursiveSearch,
  BashSearch,
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
/** `cat -n`/`nl -ba` stdout row: blank-padded 1-indexed number, a tab, the line content. */
const NUMBERED_STDOUT_LINE = /^\s*(\d+)\t([\s\S]*)$/;

/**
 * Parse the `LINE:content` rows of a line-numbered single-file search. Fails closed (`undefined`)
 * unless every row is a match row, so a filename prefix, a context header, a match count or any
 * other `grep`/`rg` shape is never mistaken for the admitted geometry. The only empty line
 * tolerated is the trailing newline every search emits.
 */
function parseSearchStdout(observed: string): Array<{ line: number; content: string }> | undefined {
  const lines = observed.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;
  const matches: Array<{ line: number; content: string }> = [];
  for (const text of lines) {
    const parsed = SEARCH_STDOUT_LINE.exec(text);
    if (!parsed) return undefined;
    const line = Number(parsed[1]);
    if (!Number.isSafeInteger(line) || line < 1) return undefined;
    matches.push({ line, content: parsed[2] });
  }
  return matches;
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
  console.log(BASH_VIEW_FIRST_NOTICE);
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
    servedRows: import("../hashline/served.js").ServedRow[];
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
      console.error("Failed to record served rows:", error);
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
      console.error("Failed to load or prune hash store:", err);
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
        console.error("Failed to clear undo after write:", error);
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
        console.error("Failed to evaluate served prefix notes after write:", error);
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
      return {
        content: [
          ...(event.content ?? []),
          {
            type: "text",
            text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}`,
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
      console.error("Auto-read after write failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n--- Auto-read failed: ${message} ---` },
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
    // WHY: the off switch bypasses BOTH branches below — view and search — so raw output
    // WHY: passes through byte-identical. The default is on, so an unconfigured session
    // WHY: never reaches this return.
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
      const { classifyBashCommand, applySliceOps } = await import("../bash-classifier.js");
      const classification = classifyBashCommand(command);
      if (classification.kind === "pureSearch") {
        return await handleBashSearch(event, ctx, classification.search);
      }
      // WHY: (item 10) the three new geometries each get their own seam; every one of them
      // WHY: returns `undefined` (raw output, zero leases) the moment a gate fails.
      if (classification.kind === "pureMultiSearch") {
        return await handleBashMultiSearch(event, ctx, classification.search);
      }
      if (classification.kind === "pureRecursiveSearch") {
        return await handleBashRecursiveSearch(event, ctx, classification.search);
      }
      if (classification.kind === "pureFilesList") {
        return await handleBashFilesList(event, ctx, classification.search);
      }
      if (classification.kind !== "pureView") {
        // WHY: (ADR-0033 observability) a systematic regression (parser drift, a
        // WHY: filtering wrapper, a new view shape) is otherwise indistinguishable
        // WHY: from "no views issued". Log the internal reason behind the existing
        // WHY: debug seam — stderr only, never model-visible text (D6 holds).
        const debugValue = process.env.PI_HASHLINE_DEBUG;
        if (debugValue === "1" || debugValue === "true") {
          console.error(`[bash-view] pass-through (${classification.reason})`);
        }
        return undefined;
      }
      const { filePath, baseDir, ops, lineNumbered } = classification.view;
      // WHY: (item 8) numbered and unnumbered are the same view — full-file, leased.
      // WHY: `lineNumbered` only selects the stdout-verification parser; leases and render
      // WHY: always come from re-read positions, never from parsed stdout numbers.
      const isNumbered = lineNumbered === true;
      // WHY: (item 8) numbered views admit no slice ops — the classifier only emits
      // WHY: `ops: []` with the marker, but defense-in-depth fails closed on any drift.
      if (isNumbered && ops.length !== 0) return undefined;
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
      const { normalized, fileHashes, absolutePath } = await deps.readNormFile(filePath, effCwd, {
        maxLines: SERVED_MAX_LINES,
        preloadedFile: file,
      });
      // WHY: intervals fold over the re-read line count, so an empty selection
      // WHY: (e.g. `head -n 0`, out-of-range `sed` addresses) serves nothing and
      // WHY: passes through — zero leases, zero output change (ADR-0033 D3).
      const allLines = deps.visLines(normalized);
      // WHY: (item 9) a content stage needs the line bytes, so it takes its own seam (row
      // WHY: leases over the survivors, bounded like a search). The predicate is the type
      // WHY: refinement that keeps the selector-only path structurally `SliceOp[]`, so the
      // WHY: interval algebra keeps its exact contract.
      if (ops.some((op) => op.kind === "keep" || op.kind === "drop")) {
        return await serveContentView(event, ctx, {
          filePath,
          absolutePath,
          normalized,
          fileHashes,
          allLines,
          ops,
        });
      }
      const intervals = applySliceOps(
        ops.filter((op): op is SliceOp => op.kind !== "keep" && op.kind !== "drop"),
        allLines.length,
      );
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
      const stdoutBlock = Array.isArray(event.content) ? event.content : undefined;
      const stdoutText =
        stdoutBlock?.length === 1 && stdoutBlock[0]?.type === "text"
          ? stdoutBlock[0].text
          : undefined;
      if (typeof stdoutText !== "string") return undefined;
      const sliceLines: string[] = [];
      for (const iv of intervals) sliceLines.push(...allLines.slice(iv.lo - 1, iv.hi));
      const joinedSlice = sliceLines.join("\n");
      // D1/D9, amended 2026-10-09 (commit 7b78278): See ADR-0033. This site
      // WHY: implements D9's symmetric CRLF/BOM normalization here; D1's
      // WHY: `;`-chain gate lives in the classifier.
      const observedText = toLF(stripBOM(stdoutText).text);
      if (isNumbered) {
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
        { windows: intervals.map((iv) => ({ offset: iv.lo, limit: iv.hi - iv.lo + 1 })) },
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
      return {
        content: [{ type: "text", text: `--- Bash view (hashline anchors) ---\n${preview.text}` }],
      };
    } catch (error) {
      // SAFETY: every failure returns undefined so the original bash output reaches
      // SAFETY: the model untouched — interception must never break a view.
      console.error("Bash view interception failed:", error);
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
   * WHY: (item 10) the shared multi-file / recursive serve seam. Every named file must resolve
   * INTO the admitted set (explicit operands or the walked set), every row's bytes must equal
   * the disk line at that number, and the total row count must fit `SEARCH_MAX_MATCHES` — all
   * verified BEFORE the first lease, so a refusal grants nothing (invariant 2) and an over-cap
   * search passes through raw instead of truncating (invariant 3). Sections render in operand /
   * first-seen order with the triple's own spelling, so coordinates are stable.
   */
  async function serveMatchTriples(
    event: ToolResultEvent,
    ctx: ToolContext,
    input: { effCwd: string; admitted: ReadonlyMap<string, string> },
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    const stdoutText = singleTextBlock(event);
    if (stdoutText === undefined) return undefined;
    const parsed = parseTripleStdout(toLF(stripBOM(stdoutText).text));
    if (parsed === undefined || parsed.length === 0) return undefined;
    if (parsed.length > SEARCH_MAX_MATCHES) return undefined;
    const grouped = new Map<string, Array<{ line: number; content: string }>>();
    for (const row of parsed) {
      const resolved = await deps.resolveTarget(deps.toCwd(row.file, input.effCwd));
      // WHY: a triple may only name a file this command could have read — `../` escapes, alias
      // WHY: spellings that resolve outside the set, and unwalked subtrees all fail closed.
      if (!input.admitted.has(resolved)) return undefined;
      const rows = grouped.get(resolved) ?? [];
      if (!rows.some((existing) => existing.line === row.line)) {
        rows.push({ line: row.line, content: row.content });
      }
      grouped.set(resolved, rows);
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
      content: [
        { type: "text", text: `--- Bash search (hashline anchors) ---\n${blocks.join("\n")}` },
      ],
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
      content: [{ type: "text", text: `--- Bash file list (no anchors) ---\n${lines.join("\n")}` }],
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
    },
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    const { applyViewOps } = await import("../bash-classifier.js");
    // WHY: exactly one text block, the same attribution rule every other seam applies.
    const stdoutBlock = Array.isArray(event.content) ? event.content : undefined;
    const stdoutText =
      stdoutBlock?.length === 1 && stdoutBlock[0]?.type === "text"
        ? stdoutBlock[0].text
        : undefined;
    if (typeof stdoutText !== "string") return undefined;
    const observedText = toLF(stripBOM(stdoutText).text);
    const survivors = applyViewOps(
      input.ops,
      input.allLines.map((text, index) => ({ line: index + 1, text })),
    );
    const joined = survivors.map((entry) => entry.text).join("\n");
    if (observedText !== joined && observedText !== `${joined}\n`) return undefined;
    if (survivors.length === 0 || survivors.length > SEARCH_MAX_MATCHES) return undefined;
    const servedRows: ServedRow[] = [];
    for (const entry of survivors) {
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
          text: `--- Bash view (hashline anchors) ---\n[${input.filePath} (${count} ${count === 1 ? "line" : "lines"})]\n${fmtServedRows(servedRows, input.allLines)}`,
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
  async function handleBashSearch(
    event: ToolResultEvent,
    ctx: ToolContext,
    search: BashSearch,
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
    const stdoutText = singleTextBlock(event);
    if (stdoutText === undefined) return undefined;
    const matches = parseSearchStdout(toLF(stripBOM(stdoutText).text));
    if (matches === undefined || matches.length === 0) return undefined;
    if (matches.length > SEARCH_MAX_MATCHES) return undefined;
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
    for (const { line, content } of matches) {
      // WHY: [ADR-0033 D9] byte equality per matched line — the witness that the anchored row is the
      // WHY: line bash printed. A stale/forged/stdout-only line fails closed with no lease.
      if (diskLines[line - 1] !== content) return undefined;
      const hash = fileHashes[line - 1];
      if (hash === undefined) return undefined;
      servedRows.push({ position: line - 1, hash });
    }
    const sessionKey = deps.sessionKeyFor(ctx);
    await recordServesBestEffort({
      sessionKey,
      path: absolutePath,
      servedRows,
      contentHash: snapshotHashFor(normalized),
    });
    notifyServedSpans({
      filePath: absolutePath,
      spans: servedRowsToSpans(servedRows),
      source: "auto-read",
      content: normalized,
    });
    // WHY: the header is frozen (spec §3.4): the same `--- Bash search (hashline anchors) ---` literal
    // WHY: names the interception seam, and the bracketed count uses the singular for one match.
    const count = servedRows.length;
    const header = `--- Bash search (hashline anchors) ---\n[${search.filePath} (${count} ${count === 1 ? "match" : "matches"})]`;
    notifyBashViewOnce(ctx, sessionKey);
    return {
      content: [{ type: "text", text: `${header}\n${fmtServedRows(servedRows, diskLines)}` }],
    };
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
