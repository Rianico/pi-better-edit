import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { MAX_READ_WINDOWS, SERVED_MAX_LINES } from "./constants.js";
import { HASH_LEN } from "./hashline/alphabet.js";
import type { ServedRow } from "./served-session/serve-render.js";
import { loadHashStore, type HashStore } from "./hash-store.js";
import { sessionFromContext, sessionKeyFor } from "./served-session/index.js";
import { contentChecksum } from "./hashline/hasher.js";
import { abortIf } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import {
  decodeNormText,
  loadFileKindAndText,
  prepareFile,
  type LFile,
  type NormText,
  type PrepareResult,
} from "./file-content/index.js";
import {
  DEFAULT_ANCHOR_RADIUS,
  DEFAULT_WINDOW_LIMIT,
  OUTLINE_IGNORED_WINDOWS_WARNING,
  admitReadRequest,
  normalizeReadPayload,
  planWindows,
  type AdmittedRequest,
  type AnchorResolver,
  type RawReadParams,
  type RenderMode,
  type WindowPlan,
} from "./file-content/admission.js";
import { formatPageHeader } from "./file-content/served-header.js";
import { toCwd } from "./paths.js";
import { DomainError, withPayloadSubject } from "./domain-errors.js";
import { notifyServedSpans, servedRowsToSpans } from "./served-spans.js";
import { fileSnap } from "./file-reader.js";
import {
  adoptStatSnapshotFor,
  snapshotHashFor,
  snapshotIOFor,
  upsertSnapshotsFor,
} from "./snapshot-store";
import { lineHashes } from "./hashline/hash-identity.js";
import { reportDiagnostic, reportWarning } from "./diagnostics.js";
import { visibleLineTotal, walkLines } from "./file-content/line-walker.js";
import type { SpanProvider } from "./read-expansion/provider-contract.js";
import type { OutlineFoldRange } from "./hashline/resolve.js";

/**
 * Gaps between served single-line outline windows: the 1-based closed line intervals no outline
 * row covers. The edit seam refuses a multi-line replacement whose strict interior covers one of
 * these lines while it is still unserved (tranche 3 fold-gate), so an outline fold can never be
 * silently erased. Sorted ascending; empty when every served line is adjacent.
 */
function outlineFoldRanges(servedLines: readonly number[]): OutlineFoldRange[] {
  const folds: OutlineFoldRange[] = [];
  for (let i = 1; i < servedLines.length; i++) {
    const startLine = servedLines[i - 1]! + 1;
    const endLine = servedLines[i]! - 1;
    if (startLine <= endLine) folds.push({ startLine, endLine });
  }
  return folds;
}
import type { OutlineSymbol } from "./read-expansion/ast-provider.js";
import { selectionRangeNote } from "./read-expansion/selection-range-note.js";
import { recordProviderFailure } from "./read-expansion/audit.js";
import {
  resolveSelectionRangeMode,
  resolveSelectionRangeModeWithSource,
} from "./selection-range-config.js";
// WHY: re-exported so callers that import the preview formatter through this module keep working.
export { fmtReadPreview } from "./file-content/preview.js";

const R_DESC = loadP("../prompts/read.md");
const R_SNIPPET = loadP("../prompts/read-snippet.md");

function readGuide(): string[] {
  return loadGuide("../prompts/read-guidelines.md");
}

const OUTLINE_MODE_DESCRIPTION = `Render mode: "served" (default) returns each line as a ${HASH_LEN}-char anchor plus content; "verbatim" returns plain text with no anchor prefix; "outline" serves only symbol declaration lines as anchors (caller windows are ignored).`;
const readOffsetWindowSchema = Type.Object(
  {
    offset: Type.Optional(
      Type.Integer({ minimum: 1, description: "Start line number (1-indexed). Defaults to 1." }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: `Number of lines to read. Defaults to ${DEFAULT_WINDOW_LIMIT} when \`offset\` is given.`,
      }),
    ),
  },
  // WHY: the union's two members must stay disjoint: both offset properties are optional, so an
  // WHY: `{ around_anchor }` window would satisfy the offset member and skip the anchor's length check.
  { additionalProperties: false },
);

const readAnchorWindowSchema = Type.Object(
  {
    around_anchor: Type.String({
      minLength: HASH_LEN,
      maxLength: HASH_LEN,
      description: `A ${HASH_LEN}-character anchor this session served: the window centres on its line.`,
    }),
    radius: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: DEFAULT_ANCHOR_RADIUS,
        description: `Lines before and after the anchor (default ${DEFAULT_ANCHOR_RADIUS}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

const readWindowSchema = Type.Union([readAnchorWindowSchema, readOffsetWindowSchema]);

// WHY: one file per call — parallel reads are parallel tool calls, so the payload carries no outer
// WHY: array and no per-file mode.
// Ref: docs/.archive_adrs/0041-read-payload-flat-file-target-with-windows-and-top-level-mode.md
export const readToolSchema = Type.Union(
  [
    Type.Object({
      file: Type.String({ description: "Path to the file to read (relative or absolute)." }),
      windows: Type.Optional(
        Type.Array(readWindowSchema, {
          description:
            "One or more line ranges in this file, each either { offset, limit } or { around_anchor, radius }; ignored in outline mode, which serves only symbol declaration lines",
        }),
      ),
      mode: Type.Literal("outline", { description: OUTLINE_MODE_DESCRIPTION }),
    }),
    Type.Object({
      file: Type.String({ description: "Path to the file to read (relative or absolute)." }),
      windows: Type.Optional(
        Type.Array(readWindowSchema, {
          maxItems: MAX_READ_WINDOWS,
          description:
            "One or more line ranges in this file, each either { offset, limit } or { around_anchor, radius }; in the default `served` mode every window's rows are served, so anchors from all of them work in a single `edit`",
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("served"), Type.Literal("verbatim")], {
          description: OUTLINE_MODE_DESCRIPTION,
        }),
      ),
    }),
  ],
  { description: OUTLINE_MODE_DESCRIPTION },
);

// WHY: this type accepts every recorded-history key — permanent tolerance for transcripts, not dead code.
// Ref: docs/.archive_adrs/0041-read-payload-flat-file-target-with-windows-and-top-level-mode.md
// Ref: docs/.archive_adrs/0040-read-payload-single-shape.md
type ReadRenderWindowTarget = {
  offset?: number;
  limit?: number;
  around_anchor?: string;
  radius?: number;
};
type ReadRenderArgs = {
  file?: string;
  path?: string;
  windows?: ReadonlyArray<ReadRenderWindowTarget>;
  mode?: string;
  /** Retired outer shape (ADR-0040): history tolerance only, never produced anymore. */
  files?: ReadonlyArray<{ file?: string }>;
};
/** Project the flat single-file payload onto the builtin renderer's keys (ADR-0041 D4/D5).
 * Path is the call's own `file`, falling back through recorded-history shapes for rendering
 * only. A range is derived only from exactly one simple `{ offset, limit }` window; anything
 * else (multi-window, `around_anchor`) leaves the range absent rather than fabricating one.
 * A multi-window call additionally reports its window count, which the caller appends to the
 * call line. The result is a new object — `context.args` is never mutated. */
function projectReadRenderArgs(args: ReadRenderArgs | undefined): {
  path: string | undefined;
  offset?: number;
  limit?: number;
  windowsCount?: number;
} {
  const windowCount = args?.windows?.length ?? 0;
  const only = windowCount === 1 ? args!.windows![0] : undefined;
  const ranged =
    typeof only?.offset === "number" && typeof only?.limit === "number" ? only : undefined;
  return {
    path: args?.file ?? args?.path ?? args?.files?.[0]?.file,
    ...(ranged !== undefined ? { offset: ranged.offset, limit: ranged.limit } : {}),
    ...(windowCount >= 2 ? { windowsCount: windowCount } : {}),
  };
}

interface PreparedTarget {
  /** The path the caller named: the page header is the only chrome, and it names the file with this. */
  file: string;
  mode: RenderMode;
  plan: WindowPlan;
  prepared: PrepareResult;
  /** The page's truncation, or `undefined` when the file rendered no page at all. */
  truncation?: TruncationResult;
  nextOffset?: number;
  snapshotId?: string | undefined;
  /** The finished selection-range clause this page's header carries, absent when it has none. */
  noteClause?: string;
}

/** The `E_UNSUPPORTED_FILE` a non-text file owes, shaped exactly like the single-file read's. */
function unsupportedFile(target: AdmittedRequest, prepared: PrepareResult): DomainError {
  if (prepared.kind === "directory") {
    return new DomainError("E_UNSUPPORTED_FILE", { path: target.file, kind: "directory" });
  }
  if (prepared.kind === "binary") {
    return new DomainError("E_UNSUPPORTED_FILE", {
      path: target.file,
      kind: "binary",
      ...(prepared.description !== undefined ? { description: prepared.description } : {}),
    });
  }
  return new DomainError("E_UNSUPPORTED_FILE", { path: target.file, kind: "image" });
}

/** A file the read could not prepare at all (missing, unreadable, over budget, not text). */
interface FailedTarget {
  file: string;
  /** The refusal text: a `DomainError`'s own message, or `file: message` for a foreign throw. */
  message: string;
}

/** One entry of the result, in request order: a rendered file, or the failure that replaced it. */
type FileResult = PreparedTarget | FailedTarget;

function isPrepared(result: FileResult): result is PreparedTarget {
  return "prepared" in result;
}

/** An image block the builtin read owns: this repo routes it, never decodes it. */
interface DelegatedImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/** One entry of the call's `content` array: rendered text, or a routed image block. */
type RoutedContent = { type: "text"; text: string } | DelegatedImageBlock;

/** One target's outcome in request order: a rendered file (or its refusal), or routed image blocks. */
type OrderedOutcome =
  | { kind: "file"; entry: FileResult }
  | { kind: "image"; blocks: RoutedContent[] };
/**
 * WHY: the page header names the range this read actually rendered (#149, read-chrome): the shown
 * WHY: range, the file's total, and — when the byte budget cut the page — where it stopped. A page
 * WHY: covering the whole file states the count alone, because a range would only restate it.
 */
function fileHeader(entry: PreparedTarget): string {
  const shown = entry.prepared.shownRange;
  return formatPageHeader({
    file: entry.file,
    totalLines: entry.prepared.lineTotals.visible,
    ...(shown !== undefined ? { shownRange: shown } : {}),
    ...(entry.mode === "verbatim" ? { verbatim: true } : {}),
    ...(entry.truncation?.truncatedBy === "bytes" && shown !== undefined
      ? { stoppedAtBytes: entry.truncation.maxBytes }
      : {}),
    ...(entry.noteClause !== undefined ? { clause: entry.noteClause } : {}),
  });
}

/** One prepared file's section: its header, inline warnings, then its rows. */
function preparedSection(entry: PreparedTarget): string {
  const lead = fileHeader(entry);
  if (entry.plan.omittedAll) return `${lead}\n${entry.plan.warnings.join("\n")}`;
  if (entry.plan.warnings.length === 0) return `${lead}\n${entry.prepared.preview}`;
  return `${lead}\n${entry.plan.warnings.join("\n")}\n\n${entry.prepared.preview}`;
}

/** One file's section: its rows when it prepared, its refusal when it did not. */
function sectionText(entry: FileResult): string {
  return isPrepared(entry) ? preparedSection(entry) : entry.message;
}

/**
 * The call's `content` array when an image is present: consecutive text sections stay joined as
 * one text block, and the builtin's own note-plus-image blocks land in request order between them.
 */
function routedContent(ordered: OrderedOutcome[]): RoutedContent[] {
  const blocks: RoutedContent[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length > 0) {
      blocks.push({ type: "text", text: pending.join("\n\n") });
      pending = [];
    }
  };
  for (const outcome of ordered) {
    if (outcome.kind === "image") {
      flush();
      blocks.push(...outcome.blocks);
      continue;
    }
    pending.push(sectionText(outcome.entry));
  }
  flush();
  return blocks;
}
/** One file's rows for the served-state channels: nothing when the file rendered no page. */
function servedRowsOf(entry: PreparedTarget): ServedRow[] {
  return entry.plan.omittedAll ? [] : entry.prepared.served;
}

/**
 * The whole file's anchors for a content-hash materialization (ADR-0043).
 *
 * A stat-adopted page resolved only the anchors it served, so an entry that must fall back to content
 * hashing re-derives the rest through the usual cache path. That is the rare race — its snapshot lost
 * to a concurrent vacuum or re-stamp between the lookup and the adoption — never the common read.
 */
async function fullHashesFor(
  entry: PreparedTarget,
  store: HashStore | undefined,
): Promise<string[]> {
  const prepared = entry.prepared;
  if (prepared.fileHashes.length === prepared.lineTotals.split) return prepared.fileHashes;
  const hashStore = store ?? (await loadHashStore());
  // WHY: these hashes are not persisted here — the caller's single batch transaction is the only
  // WHY: writer allowed to materialize this read (spec §3.1.2); a pre-write would split snapshot from leases.
  return lineHashes(
    prepared.normalized,
    prepared.absolutePath,
    undefined,
    snapshotIOFor(hashStore),
    false,
  );
}

// WHY: the provider is optional so the shipped entry point performs no expansion, and a null answer
// WHY: leaves the read exactly as it would be without one.
export function regRead(pi: ExtensionAPI, options?: { spanProvider?: SpanProvider }): void {
  const spanProvider = options?.spanProvider;
  // WHY: session_start warms the grammars off the read path; a read still waits only its budget.
  pi.on?.("session_start", (_event, ctx) => {
    if (ctx.cwd === undefined || resolveSelectionRangeMode(ctx.cwd) === "off") return;
    void spanProvider?.prefetch?.(ctx.cwd);
  });
  // WHY: Pi reuses lastComponent; its builtin needs the Text behind our wrapper.
  const readCallBases = new WeakMap<Component, Component>();
  const builtinReadDef = createReadToolDefinition("");
  const builtinRenderCall = builtinReadDef.renderCall as any;
  const builtinRenderResult = builtinReadDef.renderResult as any;
  pi.registerTool({
    name: "read",
    label: "Read",
    description: R_DESC,
    promptSnippet: R_SNIPPET,
    promptGuidelines: readGuide(),
    renderCall: (args: ReadRenderArgs, theme, context) => {
      const projected = projectReadRenderArgs(args);
      const lastComponent = context.lastComponent;
      const call: Component = builtinRenderCall({ ...args, ...projected }, theme, {
        ...context,
        lastComponent: lastComponent
          ? (readCallBases.get(lastComponent) ?? lastComponent)
          : lastComponent,
      });
      // WHY: 1:1 honesty — the builtin renders `read <path>[:start-end]` but has no multi-window
      // WHY: chrome, so the call line carries the count itself.
      // Ref: docs/.archive_adrs/0041-read-payload-flat-file-target-with-windows-and-top-level-mode.md
      if (projected.windowsCount === undefined) return call;
      const suffix = ` (${projected.windowsCount} windows)`;
      const suffixWidth = visibleWidth(suffix);
      const wrapped: Component = {
        invalidate: () => call.invalidate(),
        render: (width: number): string[] => {
          if (width <= 0) return [];
          if (width <= suffixWidth) return [truncateToWidth(suffix.trimStart(), width)];
          const budget = width - suffixWidth;
          return call
            .render(budget)
            .map((line, index) => truncateToWidth(line, budget) + (index === 0 ? suffix : ""));
        },
      };
      readCallBases.set(wrapped, call);
      return wrapped;
    },
    renderResult: (result, options, theme, context) => {
      // SAFETY: renderers receive raw call args, not the validated payload, so `context.args` may
      // SAFETY: carry a retired shape that `Static<TParams>` does not model; the projection keys on
      // SAFETY: `file`/`path`/`windows`/`files`, so history still renders (ADR-0041 D5).
      const args = context.args as ReadRenderArgs;
      return builtinRenderResult(result, options, theme, {
        ...context,
        args: { ...args, ...projectReadRenderArgs(args) },
      });
    },
    parameters: readToolSchema,
    // WHY: recorded flat payloads (`path`/`offset`/`limit`) reach execute through replay, and the
    // WHY: model-facing schema deliberately stays the canonical `{ file, windows, mode }` shape.
    // SAFETY: the normalizer returns the canonical shape when it can; an invalid legacy payload
    // SAFETY: falls through to schema validation, which is exactly where it must be refused.
    prepareArguments: (args: unknown) =>
      normalizeReadPayload(args as RawReadParams) as unknown as Static<typeof readToolSchema>,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const request = admitReadRequest(params as RawReadParams);
        const cwd = ctx.cwd as string;
        const sessionCtx = ctx as { sessionManager?: { getSessionId(): string } };
        abortIf(signal);
        // WHY: spec §4.3 resolves `around_anchor` against the target's active lineage whatever the mode,
        // WHY: so a verbatim call naming an anchor window still opens the store, while a call naming
        // WHY: neither a served target nor an anchor window opens nothing — it pays nothing.
        const needsStore =
          request.mode !== "verbatim" ||
          request.windows?.some((window) => window.kind === "anchor") === true;
        const store = needsStore ? await loadHashStore() : undefined;
        const ordered: OrderedOutcome[] = [];
        // WHY: delegation, not reimplementation — the builtin owns image bytes, so this repo only routes
        // WHY: them. Built lazily so a text-only call pays nothing and its path stays untouched.
        let builtinImageRead: ReturnType<typeof createReadTool> | undefined;
        const readImageViaBuiltin = async (absolutePath: string) => {
          builtinImageRead ??= createReadTool(cwd);
          return builtinImageRead.execute(_toolCallId, { path: absolutePath }, signal);
        };
        // WHY: spec §4.2 — the read draws on the call's 200,000-line served budget, so a file that cannot
        // WHY: afford what is left is refused inline instead of keeping every anchor, text and hash alive.
        let remainingServedLines = SERVED_MAX_LINES;

        {
          const target = request;
          abortIf(signal);
          const mode = request.mode;
          // WHY: outline mode derives its own window set from the tranche-1 AST seam — one single-line
          // WHY: window per declaration line — so the serve seam below leases declaration lines only (ADR-0004).
          let outlineOffsets: Array<{ kind: "offset"; offset: number; limit: number }> | undefined;
          if (mode === "outline") {
            const outlineOf = (
              spanProvider as
                | { outline?: (file: string) => Promise<readonly OutlineSymbol[]> }
                | undefined
            )?.outline;
            const symbols = (await outlineOf?.(toCwd(target.file, cwd))) ?? [];
            const lines = [
              ...new Set(
                symbols
                  .map((symbol) => symbol.line)
                  .filter((line) => Number.isInteger(line) && line >= 1),
              ),
            ].sort((a, b) => a - b);
            outlineOffsets = lines.map((line) => ({
              kind: "offset" as const,
              offset: line,
              limit: 1,
            }));
          }
          const requested = outlineOffsets ?? target.windows;
          // WHY: the served cap bounds the anchor space this read materializes; verbatim serves no anchors.
          const cap = mode !== "verbatim" ? { maxLines: remainingServedLines } : {};
          // WHY: an anchor window must resolve BEFORE the file is prepared (its offset is not known
          // WHY: yet), so the file is read once here and handed to the seam below — never twice.
          const wantsAnchor =
            outlineOffsets === undefined &&
            target.windows?.some((window) => window.kind === "anchor") === true;
          let preloaded: LFile | undefined = wantsAnchor
            ? await loadFileKindAndText(toCwd(target.file, cwd), {
                ...cap,
                displayPath: target.file,
              })
            : undefined;
          // WHY: decode once and share it — an anchor window resolves against these bytes and an
          // WHY: expansion measures its span against the same visible line count.
          let resolvedText: NormText | undefined;
          if (preloaded !== undefined && preloaded.kind === "text") {
            resolvedText = await decodeNormText(target.file, cwd, {
              ...(signal !== undefined ? { signal } : {}),
              ...cap,
              preloadedFile: preloaded,
            });
          }
          let resolver: AnchorResolver | undefined;
          // WHY: resolution is lineage-scoped, not mode-scoped (spec §4.3), so the store opens for an
          // WHY: anchor window of a verbatim target too; this guard is the safety net for a window whose file
          // WHY: could not be loaded as text — it falls through to the same §4.3 "not found" warning.
          if (store !== undefined && resolvedText !== undefined) {
            resolver = {
              sessionKey: sessionFromContext(sessionCtx, resolvedText.absolutePath).sessionKey,
              absolutePath: resolvedText.absolutePath,
              normalized: resolvedText.normalized,
              store,
            };
          }
          // WHY: an empty outline is the anchor-omitted precedent: it prepares for its header counts but
          // WHY: serves no rows, naming the miss in one warning line.
          const plan: WindowPlan =
            outlineOffsets !== undefined
              ? {
                  windows: outlineOffsets.map(({ offset, limit }) => ({ offset, limit })),
                  warnings: [
                    // WHY: caller windows are ignored in outline mode, so a non-empty caller list is named in
                    // WHY: one `[Window warning: ...]` line — the anchor-miss shape — instead of dropping silently.
                    ...(target.windows !== undefined && target.windows.length > 0
                      ? [OUTLINE_IGNORED_WINDOWS_WARNING]
                      : []),
                    ...(outlineOffsets.length === 0 ? ["[No symbols found.]"] : []),
                  ],
                  omittedAll: outlineOffsets.length === 0,
                }
              : planWindows(target, resolver);
          // WHY: expansion is mode-independent (D11/D19), so its setting resolves before the file is
          // WHY: prepared and the lookup runs after, where the served window and total are known.
          const noteMode =
            spanProvider !== undefined && plan.windows !== undefined && plan.windows.length > 0
              ? resolveSelectionRangeModeWithSource(cwd, (reason) =>
                  reportWarning("read-expansion", reason),
                )
              : undefined;
          // WHY: a single-window read renders as one §4.4 page — a header, no sub-banner, no continuation
          // WHY: token — while multi-window reads keep their per-section headers.
          const singlePage =
            requested?.length === 1 && requested[0]?.kind === "offset"
              ? { offset: requested[0].offset, limit: requested[0].limit }
              : undefined;
          // WHY: `noPersist` defers the authoritative materialization until the served windows are known,
          // WHY: so the snapshots + lineage + retirement + lease grants below commit as the ONE transaction
          // WHY: spec §3.1.2 mandates, instead of materializing first and leasing later.
          const noteWanted =
            noteMode?.value === "on" &&
            spanProvider !== undefined &&
            plan.windows !== undefined &&
            plan.windows.length > 0;
          if (noteWanted) {
            preloaded ??= await loadFileKindAndText(toCwd(target.file, cwd), {
              ...cap,
              displayPath: target.file,
            });
            if (preloaded.kind === "text") {
              resolvedText ??= await decodeNormText(target.file, cwd, {
                ...(signal !== undefined ? { signal } : {}),
                ...cap,
                preloadedFile: preloaded,
              });
            }
          }
          const note =
            noteWanted && resolvedText !== undefined
              ? await selectionRangeNote({
                  file: toCwd(target.file, cwd),
                  windows: plan.windows,
                  totalLines: visibleLineTotal(
                    resolvedText.normalized,
                    walkLines(resolvedText.normalized).total,
                  ),
                  provider: spanProvider,
                  enabled: true,
                })
              : undefined;
          // WHY: a failed lookup owes exactly one row — file, source, refusal reason — never one per window.
          if (note?.failure !== undefined && noteMode !== undefined) {
            recordProviderFailure(
              {
                file: target.file,
                mode,
                source: note.failure.source,
                reason: note.failure.reason,
                ...(plan.windows === undefined
                  ? {}
                  : {
                      requested: plan.windows.map((window) => ({
                        startLine: window.offset,
                        endLine: window.offset + window.limit - 1,
                      })),
                    }),
              },
              sessionKeyFor(sessionCtx),
              noteMode.source,
            );
          }
          const prepared = await prepareFile(target.file, cwd, {
            ...(signal !== undefined ? { signal } : {}),
            ...(singlePage !== undefined
              ? { offset: singlePage.offset, limit: singlePage.limit }
              : plan.windows !== undefined
                ? { windows: plan.windows }
                : {}),
            // WHY: the served cap stays the served budget (independent of the anchor space): the paged walk
            // WHY: retains one anchor per hashed line (see `src/constants.ts`), so the budget survives paging.
            maxLines: remainingServedLines,
            ...(plan.windows !== undefined && plan.windows.length > 1 && note !== undefined
              ? { noteClauses: note.clauses }
              : {}),
            ...(mode !== "verbatim" && store !== undefined ? { store } : {}),
            noPersist: true,
            render: mode === "verbatim" ? "verbatim" : "served",
            // WHY: outline windows are server-derived single-line rows, not caller fan-out, so the
            // WHY: caller-window count cap does not apply (the shared byte/line budgets still do).
            ...(outlineOffsets !== undefined ? { derivedWindows: true } : {}),
          });
          if (prepared.kind === "image") {
            // WHY: the interception point — the image never becomes a `results` entry, so no image content
            // WHY: enters the served / hash / snapshot / lease paths below; it delegates and returns its block.
            const imageResult = await readImageViaBuiltin(prepared.absolutePath);
            return imageResult;
          }
          if (prepared.kind !== "text") throw unsupportedFile(target, prepared);
          ordered.push({
            kind: "file",
            entry: {
              file: target.file,
              mode,
              plan,
              ...(plan.windows?.length === 1 && note?.clauses[0] !== undefined
                ? { noteClause: note.clauses[0] }
                : {}),
              prepared,
              ...(plan.omittedAll
                ? {}
                : {
                    ...(prepared.truncation !== undefined
                      ? { truncation: prepared.truncation }
                      : {}),
                    ...(prepared.nextOffset !== undefined
                      ? { nextOffset: prepared.nextOffset }
                      : {}),
                  }),
            },
          });
          // WHY: a served file draws the WHOLE file's line count off the call's budget, not its page: the
          // WHY: paged walk retained one anchor per hashed line, which is what the budget bounds; verbatim
          // WHY: takes no cap and so draws nothing.
          if (mode !== "verbatim") remainingServedLines -= prepared.lineTotals.split;
        }
        const results: FileResult[] = ordered.flatMap((outcome) =>
          outcome.kind === "file" ? [outcome.entry] : [],
        );
        const preparedFiles = results.filter(isPrepared);
        for (const entry of preparedFiles) {
          if (entry.mode === "verbatim" || entry.plan.omittedAll) continue;
          const adopted = entry.prepared.statAdoption;
          if (adopted !== undefined) {
            // WHY: the epoch names the same bytes `fileSnap` would describe — the checksum comes from the
            // WHY: stat-matched snapshot, so adoption never re-hashes content just to state the version.
            // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
            entry.snapshotId = adopted.snapshotId;
            continue;
          }
          try {
            entry.snapshotId = (
              await fileSnap(
                entry.prepared.absolutePath,
                contentChecksum(entry.prepared.normalized),
                entry.prepared.stats,
              )
            ).snapshotId;
          } catch {
            entry.snapshotId = undefined;
          }
        }

        const single = results.length === 1 ? preparedFiles[0] : undefined;
        const firstTruncation = preparedFiles.find(
          (entry) => entry.truncation !== undefined,
        )?.truncation;
        const anyTruncated = firstTruncation !== undefined;
        // WHY: a text-only call keeps the one joined text section byte-identical; with an image
        // WHY: present the blocks aggregate in request order around the builtin's own blocks.
        const content: RoutedContent[] = ordered.every((outcome) => outcome.kind === "file")
          ? [{ type: "text", text: results.map(sectionText).join("\n\n") }]
          : routedContent(ordered);
        const metrics = {
          truncated: anyTruncated,
          ...(single?.nextOffset !== undefined ? { next_offset: single.nextOffset } : {}),
        };

        const servedEntries = preparedFiles.filter(
          (entry) => entry.mode !== "verbatim" && !entry.plan.omittedAll,
        );
        // WHY: a verbatim-only call shares admission/normalization but must not touch served state —
        // WHY: no lease, snapshot, epoch, drift clear, or span notification. Return before any of it.
        if (servedEntries.length === 0) {
          // WHY: an empty outline records no folds, but it still clears the folds a previous outline read
          // WHY: left behind — a stale record could fail a later span closed on another snapshot's coordinates.
          // WHY: Best-effort: a missed clear degrades to the same fail-closed refusal the gate would give.
          const emptyOutline = preparedFiles.find(
            (entry) => entry.mode === "outline" && entry.plan.omittedAll,
          );
          if (emptyOutline !== undefined) {
            try {
              await sessionFromContext(
                sessionCtx,
                emptyOutline.prepared.absolutePath,
              ).recordOutlineFolds([]);
            } catch (error) {
              reportDiagnostic("read", "Failed to clear outline fold record:", error);
            }
          }
          return {
            content,
            details:
              single?.mode === "verbatim"
                ? {
                    ...(single.truncation !== undefined ? { truncation: single.truncation } : {}),
                    ...(single.nextOffset !== undefined ? { nextOffset: single.nextOffset } : {}),
                    metrics,
                  }
                : {
                    ...(firstTruncation !== undefined ? { truncation: firstTruncation } : {}),
                    metrics,
                  },
          };
        }

        const sessionKey = sessionFromContext(
          sessionCtx,
          servedEntries[0]!.prepared.absolutePath,
        ).sessionKey;
        // WHY: the materialization (spec §3.1.2 steps 4-6): snapshot + lineage + retirement + served
        // WHY: leases commit in ONE `BEGIN IMMEDIATE`, so a read can never lease anchors without its snapshot.
        // WHY: Best-effort — a store failure never fails the read; the next call re-materializes.
        try {
          // WHY: a stat-matched page already names a committed snapshot, so adopting it on the same identity
          // WHY: commits the leases and mirror a materialization owns without hashing or re-splitting the
          // WHY: content. A `false` (lost race with a vacuum or re-stamp) folds the entry back into the
          // WHY: content-hash batch below — the only writer allowed to decide this content's identity.
          // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
          const unmatched: PreparedTarget[] = [];
          for (const entry of servedEntries) {
            const adopted = entry.prepared.statAdoption;
            const statKey = entry.prepared.statKey;
            if (adopted === undefined || statKey === undefined) {
              unmatched.push(entry);
              continue;
            }
            const committed = await adoptStatSnapshotFor(
              {
                path: entry.prepared.absolutePath,
                statKey,
                snapshotHash: adopted.snapshotHash,
              },
              { retireLeases: true, leases: { sessionKey, rows: servedRowsOf(entry) } },
            );
            if (!committed) unmatched.push(entry);
          }
          if (unmatched.length > 0) {
            const enrollments = await Promise.all(
              unmatched.map(async (entry) => ({
                descriptor: {
                  path: entry.prepared.absolutePath,
                  snapshotHash: snapshotHashFor(entry.prepared.normalized),
                  lineCount: entry.prepared.lineTotals.split,
                  hashes: await fullHashesFor(entry, store),
                  content: entry.prepared.normalized,
                },
                options: {
                  retireLeases: true,
                  leases: { sessionKey, rows: servedRowsOf(entry) },
                  // WHY: stamp the version this read actually observed, so the next read of an
                  // WHY: unchanged file adopts on stat identity instead of content hashing again.
                  ...(entry.prepared.statKey !== undefined
                    ? { statKey: entry.prepared.statKey }
                    : {}),
                },
              })),
            );
            await upsertSnapshotsFor(enrollments);
          }
        } catch (error) {
          // WHY: best-effort post-read materialization — the preview rows are already computed and the
          // WHY: mirror below still records them; a miss degrades to the next edit's fail-closed path anyway.
          reportDiagnostic("read", "Failed to commit read-path snapshot materialization:", error);
        }
        for (const entry of servedEntries) {
          const session = sessionFromContext(sessionCtx, entry.prepared.absolutePath);
          const isFullRead = entry.plan.windows === undefined && entry.truncation === undefined;
          // WHY: one file per call, so a session-write failure for the lone file stays the call's failure.
          // WHY: mirror-only — the leases already committed in the transaction above, so no `contentHash` is
          // WHY: passed and no third transaction remains on the read path; canon evidence derives from those
          // WHY: leases and needs no write at all (#151).
          await session.recordEpoch({
            rows: servedRowsOf(entry),
            lineCount: entry.prepared.lineTotals.visible,
            // WHY: a stat-adopted page holds only the anchors it served, so `fullReadHashes` is whole only
            // WHY: for a full read (its one range is the whole file); a partial read never consumes them.
            // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
            ...(isFullRead ? { fullReadHashes: entry.prepared.fileHashes } : {}),
            ...(isFullRead && entry.snapshotId !== undefined
              ? { snapshotId: entry.snapshotId }
              : {}),
            isFullRead,
          });
          if (isFullRead) await session.clearDrift();
          // WHY: outline mode serves only declaration lines, so the gaps between served rows are unserved
          // WHY: folds the edit seam must not silently erase (tranche 3 fold-gate). They are recorded here
          // WHY: in the read snapshot's coordinates, so a later served read that fills them disarms the gate
          // WHY: via the mirror-null check; a full read clears the whole row through `clearDrift` instead.
          if (entry.mode === "outline") {
            const servedLines = servedRowsOf(entry)
              .map((row) => row.position + 1)
              .sort((a, b) => a - b);
            await session.recordOutlineFolds(outlineFoldRanges(servedLines));
          }
          // WHY: fire-and-forget by design — the seam snapshots its observers and isolates each one, so
          // WHY: this read's return value and timing are unchanged whether or not an observer is attached.
          notifyServedSpans({
            filePath: entry.prepared.absolutePath,
            spans: servedRowsToSpans(entry.prepared.served),
            source: "read",
            // WHY: the verbatim normalized bytes let the mirror hash caller evidence in memory instead
            // WHY: of re-reading the file; the anchored preview is never the source of a line hash.
            content: entry.prepared.normalized,
          });
        }
        return {
          content,
          details: single
            ? {
                ...(single.truncation !== undefined ? { truncation: single.truncation } : {}),
                ...(single.snapshotId !== undefined ? { snapshotId: single.snapshotId } : {}),
                ...(single.nextOffset !== undefined ? { nextOffset: single.nextOffset } : {}),
                metrics,
              }
            : {
                ...(firstTruncation !== undefined ? { truncation: firstTruncation } : {}),
                metrics,
              },
        };
      } catch (error) {
        throw withPayloadSubject(error, "read");
      }
    },
  });
}
