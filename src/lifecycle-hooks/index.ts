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
  MAX_READ_WINDOWS,
  SEARCH_MAX_MATCHES,
  SERVED_MAX_LINES,
} from "../constants.js";
import type { BashSearch } from "../bash-classifier.js";
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

/** `grep -n`/`rg --line-number` stdout row: a 1-indexed line number, a colon, the matched text. */
const SEARCH_STDOUT_LINE = /^(\d+):([\s\S]*)$/;

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
      const { filePath, baseDir, ops } = classification.view;
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
      const intervals = applySliceOps(ops, deps.visLines(normalized).length);
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
      const allLines = deps.visLines(normalized);
      const sliceLines: string[] = [];
      for (const iv of intervals) sliceLines.push(...allLines.slice(iv.lo - 1, iv.hi));
      const joinedSlice = sliceLines.join("\n");
      // D1/D9, amended 2026-10-09 (commit 7b78278): See ADR-0033. This site
      // WHY: implements D9's symmetric CRLF/BOM normalization here; D1's
      // WHY: `;`-chain gate lives in the classifier.
      const observedText = toLF(stripBOM(stdoutText).text);
      if (observedText !== joinedSlice && observedText !== `${joinedSlice}\n`) return undefined;
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
    // WHY: exactly one text block, the same attribution rule the view path applies — a search whose
    // WHY: stdout is split or non-text cannot be proven to be this command's output.
    const stdoutBlock = Array.isArray(event.content) ? event.content : undefined;
    const stdoutText =
      stdoutBlock?.length === 1 && stdoutBlock[0]?.type === "text"
        ? stdoutBlock[0].text
        : undefined;
    if (typeof stdoutText !== "string") return undefined;
    const matches = parseSearchStdout(toLF(stripBOM(stdoutText).text));
    if (matches === undefined || matches.length === 0) return undefined;
    if (matches.length > SEARCH_MAX_MATCHES) return undefined;
    // WHY: the single pre-search literal `cd` re-bases relative resolution under the same rule as a
    // WHY: view (ADR-0033 D1); multi-`cd` and post-search-`cd` chains never reach here.
    const effCwd = search.baseDir === undefined ? ctx.cwd : deps.toCwd(search.baseDir, ctx.cwd);
    const resolvedPath = await deps.resolveTarget(deps.toCwd(search.filePath, effCwd));
    await deps.valAccess(resolvedPath, search.filePath);
    // WHY: the pure classifier cannot see the filesystem, so the single-operand target is re-checked
    // WHY: here: a directory (or anything not decodable text) fails closed instead of being anchored.
    const file = await deps.loadFileKindAndText(resolvedPath, {
      maxLines: SERVED_MAX_LINES,
      displayPath: search.filePath,
    });
    if (file.kind !== "text") return undefined;
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
