import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MAX_READ_WINDOWS, MAX_READ_WINDOWS_MESSAGE, SERVED_MAX_LINES } from "./constants.js";
import { HASH_LEN } from "./hashline/alphabet.js";
import type { ServedRow } from "./hashline/served.js";
import { loadHashStore, type HashStore } from "./hash-store.js";
import { sessionFromContext } from "./served-session/index.js";
import { contentChecksum } from "./hashline/hasher.js";
import { abortIf, assertNever } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import {
  decodeNormText,
  loadFileKindAndText,
  prepareFile,
  type LFile,
  type PrepareResult,
} from "./file-content/index.js";
import { visibleLineTotal, walkLines } from "./file-content/line-walker.js";
import { formatRangedServedHeader } from "./file-content/served-header.js";
import { leaseSpanSource } from "./mutation-engine/edit-source.js";
import { resolveLineIdentity } from "./hashline/resolve.js";
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
import { reportDiagnostic } from "./diagnostics.js";
// WHY: Facade re-export for callers still importing preview directly
export { fmtReadPreview } from "./file-content/preview.js";

const R_DESC = loadP("../prompts/read.md");
const R_SNIPPET = loadP("../prompts/read-snippet.md");

/** Default `limit` for an `{ offset }` window that names none. */
const DEFAULT_WINDOW_LIMIT = 50;
/** `radius` default for `around_anchor` (spec §4.1/§4.3). */
const DEFAULT_ANCHOR_RADIUS = 10;

function readGuide(): string[] {
  return loadGuide("../prompts/read-guidelines.md");
}

// WHY: the builtin renderers key on `file_path ?? path` plus `offset`/`limit`; our payload
// WHY: field is `file` (ADR-0041 D1/D4), but recorded history (`files`-shaped per ADR-0040, or a
// WHY: legacy `file`/`path` caller per ADR-0040 D3) must still render, so the seam accepts every
// WHY: key. The D5 fallback order is exactly `file ?? path ?? files?.[0]?.file`.
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

/** Render mode of one file: `served` (anchored rows) or `verbatim` (plain text, no leases). */
type RenderMode = "served" | "verbatim";

/** A line window of one file, in the reader's 1-indexed terms (spec §4.1). */
interface OffsetWindow {
  offset: number;
  limit: number;
}

/** A window anchored to a line identity this session served (spec §4.1). */
interface AnchorWindow {
  /** The anchor this window centres on, `${HASH_LEN}` characters wide. */
  anchor: string;
  /** Lines before and after the anchor's line. */
  radius: number;
}

const renderModeSchema = Type.Union([Type.Literal("served"), Type.Literal("verbatim")], {
  description: `Render mode: "served" (default) returns each line as a ${HASH_LEN}-char anchor plus content; "verbatim" returns plain text with no anchor prefix.`,
});

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
  // WHY: the union's two members must stay disjoint: both offset properties are optional, so without
  // WHY: this an `{ around_anchor }` window would also satisfy the offset member and slip past the
  // WHY: anchor's own length check at the seam.
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

// WHY: one file per call (ADR-0041 D1): `file` names it, `windows` scopes it, `mode` renders
// WHY: it. Parallel reads are parallel tool calls — there is no outer array and no per-file mode.
// WHY: A payload without `file` fails validation before admission runs.
export const readToolSchema = Type.Object({
  file: Type.String({ description: "Path to the file to read (relative or absolute)." }),
  windows: Type.Optional(
    Type.Array(readWindowSchema, {
      maxItems: MAX_READ_WINDOWS,
      description:
        "One or more line ranges in this file, each either { offset, limit } or { around_anchor, radius }; in the default `served` mode every window's rows are served, so anchors from all of them work in a single `edit`",
    }),
  ),
  mode: Type.Optional(renderModeSchema),
});

type RawReadParams = Record<string, unknown>;

/** One admitted window: an offset window, or an anchor window not yet resolved to one. */
type AdmittedWindow =
  | { kind: "offset"; offset: number; limit: number }
  | { kind: "anchor"; anchor: string; radius: number };

interface AdmittedRequest {
  file: string;
  /** Absent when the request named no windows (`undefined` and `[]` both read from line 1). */
  windows?: AdmittedWindow[];
  mode: RenderMode;
}

function badPayload(message: string): DomainError {
  return new DomainError("E_BAD_PAYLOAD", { message });
}

function positiveInt(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw badPayload(`Read request field "${name}" must be a positive integer.`);
  }
  return value as number;
}

/**
 * Admits a render mode. An out-of-union mode fails closed HERE, not only in schema validation: the
 * tool's exhaustiveness guard (read verbatim's contract test) runs `execute` without a validator.
 */
function admitMode(value: unknown): RenderMode | undefined {
  if (value === undefined) return undefined;
  if (value === "served" || value === "verbatim") return value;
  // WHY: `assertNever` carries the union's exhaustiveness to runtime and keeps the wording the
  // WHY: schema rejection uses for the same payload.
  return assertNever(value as never);
}

function admitWindow(window: unknown, label: string): AdmittedWindow {
  if (window === null || typeof window !== "object") {
    throw badPayload(`Read request field "${label}" must be an object.`);
  }
  const raw = window as RawReadParams;
  if (raw.around_anchor !== undefined) {
    const anchor = raw.around_anchor;
    if (typeof anchor !== "string" || anchor.length !== HASH_LEN) {
      throw badPayload(
        `Read request field "${label}.around_anchor" must be a ${HASH_LEN}-character anchor.`,
      );
    }
    const radius = raw.radius === undefined ? DEFAULT_ANCHOR_RADIUS : raw.radius;
    return { kind: "anchor", anchor, radius: positiveInt(radius, `${label}.radius`) };
  }
  const offset = positiveInt(raw.offset, `${label}.offset`);
  // WHY: an offset with no limit still names a window, so it takes the canonical default size
  const limit =
    raw.limit === undefined ? DEFAULT_WINDOW_LIMIT : positiveInt(raw.limit, `${label}.limit`);
  return { kind: "offset", offset, limit };
}

/**
 * Admission for the flat single-file shape (ADR-0041 D1): validates the file, every window,
 * and the window cap. A payload without `file` was already rejected by the schema; the check
 * below is the safety net for callers that bypass validation.
 */
function admitReadRequest(params: RawReadParams): AdmittedRequest {
  const mode = admitMode(params.mode) ?? "served";
  const file = params.file;
  if (typeof file !== "string" || file === "") {
    throw badPayload('Read request field "file" must be a non-empty path.');
  }
  const rawWindows = params.windows;
  if (rawWindows !== undefined && !Array.isArray(rawWindows)) {
    throw badPayload('Read request field "windows" must be an array.');
  }
  const windows =
    rawWindows === undefined || rawWindows.length === 0
      ? undefined
      : rawWindows.map((window, windowIndex) => admitWindow(window, `windows[${windowIndex}]`));
  // WHY: the schema's `maxItems` and this guard enforce the same cap for validated and
  // WHY: unvalidated callers alike — window count is what multiplies the auto-read budget.
  if ((windows?.length ?? 0) > MAX_READ_WINDOWS) {
    throw badPayload(MAX_READ_WINDOWS_MESSAGE);
  }
  return { file, ...(windows !== undefined ? { windows } : {}), mode };
}

/** The inline warning one unresolvable anchor window leaves behind (spec §4.3). */
function anchorWarning(anchor: string): string {
  return `[Window warning: Anchor '${anchor}' not found; window omitted]`;
}

/** What one file's requested windows became: the windows to walk, the warnings, and the flags. */
interface WindowPlan {
  /** The offset windows the preview walks, or `undefined` for a file that named no windows. */
  windows: OffsetWindow[] | undefined;
  /** One warning per unresolvable anchor window, in request order. */
  warnings: string[];
  /** The request named windows but none survived: the file renders its warnings alone. */
  omittedAll: boolean;
}

/** The identity seam an anchor window resolves against: the file's current content and its leases. */
interface AnchorResolver {
  sessionKey: string;
  absolutePath: string;
  normalized: string;
  store: import("./hash-store.js").HashStore;
}

/**
 * Resolves `around_anchor` against the file's ACTIVE lineage for the session (spec §4.3): a served
 * lease names a `line_id`, `resolveLineIdentity` says where that identity lives now, and the window
 * is `line ± radius` clamped to the file. Unknown, expired or foreign anchors all resolve to
 * `undefined` — the caller emits one warning and lets the remaining windows proceed.
 */
function resolveAnchorWindow(
  window: AnchorWindow,
  resolver: AnchorResolver,
): OffsetWindow | undefined {
  const source = leaseSpanSource({
    store: resolver.store,
    sessionKey: resolver.sessionKey,
    absolutePath: resolver.absolutePath,
    content: resolver.normalized,
  });
  const lease = source.leaseFor(window.anchor);
  // WHY: no lease for this file is the whole warning (spec §4.3): an unknown anchor, one this session
  // WHY: holds for another file, and a foreign-generation row all fail closed the same way, and the
  // WHY: specification pins one wording for all three — so no homes lookup is needed to say it.
  if (lease === undefined) return undefined;
  const decision = resolveLineIdentity(lease, source);
  if (decision.kind !== "line") return undefined;
  const totalLines = visibleLineTotal(resolver.normalized, walkLines(resolver.normalized).total);
  if (totalLines === 0) return undefined;
  const start = Math.max(1, decision.line - window.radius);
  const end = Math.min(totalLines, decision.line + window.radius);
  return { offset: start, limit: end - start + 1 };
}

/** Turns a file's requested windows into the offset windows to walk, resolving anchors along the way. */
function planWindows(target: AdmittedRequest, resolver: AnchorResolver | undefined): WindowPlan {
  const requested = target.windows;
  if (requested === undefined) return { windows: undefined, warnings: [], omittedAll: false };
  const windows: OffsetWindow[] = [];
  const warnings: string[] = [];
  for (const window of requested) {
    if (window.kind === "offset") {
      windows.push({ offset: window.offset, limit: window.limit });
      continue;
    }
    // WHY: an anchor window can only resolve against served lineage; a non-text or anchor-less load
    // WHY: leaves it unresolved, which is the same "not found" the model has to re-read past.
    const resolved = resolver === undefined ? undefined : resolveAnchorWindow(window, resolver);
    if (resolved === undefined) {
      warnings.push(anchorWarning(window.anchor));
      continue;
    }
    windows.push(resolved);
  }
  return { windows, warnings, omittedAll: windows.length === 0 && warnings.length > 0 };
}

interface PreparedTarget {
  /** The path the caller named: the file header, and every footer, name the file with this. */
  file: string;
  mode: RenderMode;
  plan: WindowPlan;
  prepared: PrepareResult;
  /** The page's truncation, or `undefined` when the file rendered no page at all. */
  truncation?: TruncationResult;
  nextOffset?: number;
  snapshotId?: string | undefined;
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

/**
 * WHY: the served header names the shown range a single windowed read actually rendered (#149):
 * WHY: the footer's continuation range already does, and the bash view's own header does, so the
 * WHY: file header carries the same numbers. Whole-file and multi-window reads keep the bare total.
 */
function fileHeader(entry: PreparedTarget): string {
  const lines = entry.prepared.lineTotals.visible;
  if (entry.mode === "verbatim") return `[${entry.file} (verbatim, ${lines} lines, no anchors)]`;
  const shown = shownSingleWindow(entry);
  if (shown === undefined) return `[${entry.file} (${lines} lines total)]`;
  return formatRangedServedHeader(entry.file, shown.start, shown.end, lines);
}

/**
 * WHY: the header's range is the rows actually shown, not the rows asked for: truncation cuts the
 * WHY: tail, so the served rows' own positions are the honest range — the same numbers the footer
 * WHY: already carries. Exactly one walked window with at least one served row is a ranged header;
 * WHY: anything else (whole file, several windows, warnings alone, an empty page) keeps the total.
 */
function shownSingleWindow(entry: PreparedTarget): { start: number; end: number } | undefined {
  if (entry.plan.omittedAll || (entry.plan.windows?.length ?? 0) !== 1) return undefined;
  // WHY: an empty file's marker row carries a phantom position (0-based 0); ranging it would print
  // WHY: `lines 1-1 of 0` — a range beyond the total. Nothing was shown, so the total header stands.
  if (entry.prepared.lineTotals.visible === 0) return undefined;
  const served = entry.prepared.served;
  if (served.length === 0) return undefined;
  return { start: served[0]!.position + 1, end: served[served.length - 1]!.position + 1 };
}

/** One prepared file's section: its header, then any inline anchor warnings, then its rows. */
function preparedSection(entry: PreparedTarget): string {
  const header = fileHeader(entry);
  if (entry.plan.omittedAll) return `${header}\n${entry.plan.warnings.join("\n")}`;
  if (entry.plan.warnings.length === 0) return `${header}\n${entry.prepared.preview}`;
  return `${header}\n${entry.plan.warnings.join("\n")}\n\n${entry.prepared.preview}`;
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
  // WHY: not persisted here — the caller's single batch transaction is the only writer allowed to
  // WHY: materialize this read (spec §3.1.2); a pre-write would split the snapshot from its leases.
  return lineHashes(
    prepared.normalized,
    prepared.absolutePath,
    undefined,
    snapshotIOFor(hashStore),
    false,
  );
}

export function regRead(pi: ExtensionAPI): void {
  // WHY: pi falls back to the builtin `read` renderer by tool name, but that renderer keys on
  // WHY: `file_path ?? path` plus `offset`/`limit`. Our payload field is `file` (ADR-0041 D1), so
  // WHY: project it for rendering only — the call line shows the filename, and `args` is never
  // WHY: mutated. The `file ?? path ?? files?.[0]?.file` fallback is permanent tolerance for
  // WHY: recorded transcripts (ADR-0040 D3/D5), not dead code.
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
    // SAFETY: the builtin renderers are keyed on `file_path ?? path` plus `offset`/`limit`;
    // SAFETY: projectReadRenderArgs derives the path from the flat `file` (D4) and the range
    // SAFETY: from a single simple window, without mutating the caller's `args`. Multi-window reads
    // SAFETY: get their count appended below — the builtin has no chrome for them.
    renderCall: (args: ReadRenderArgs, theme, context) => {
      const projected = projectReadRenderArgs(args);
      const lastComponent = context.lastComponent;
      const call: Component = builtinRenderCall({ ...args, ...projected }, theme, {
        ...context,
        lastComponent: lastComponent
          ? (readCallBases.get(lastComponent) ?? lastComponent)
          : lastComponent,
      });
      // WHY: 1:1 honesty (ADR-0041 D4) — the builtin renders `read <path>[:start-end]` but has no
      // WHY: multi-window chrome, so the call line carries the count itself. Single anchor-window and
      // WHY: whole-file reads render the bare path (no range is ever fabricated).
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

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const request = admitReadRequest(params as RawReadParams);
        const cwd = ctx.cwd as string;
        const sessionCtx = ctx as { sessionManager?: { getSessionId(): string } };
        abortIf(signal);
        // WHY: spec §4.3 resolves `around_anchor` against the target file's active lineage for the
        // WHY: session and carries NO mode qualifier, so the store opens for an anchor window whether or
        // WHY: not the target serves rows. A call naming neither a served target nor an anchor window
        // WHY: still opens nothing, so the read that serves nothing pays nothing.
        const needsStore =
          request.mode === "served" ||
          request.windows?.some((window) => window.kind === "anchor") === true;
        const store = needsStore ? await loadHashStore() : undefined;
        const ordered: OrderedOutcome[] = [];
        // WHY: delegation, not reimplementation — the builtin owns image bytes, so this repo only
        // WHY: routes `prepared.kind === "image"` to it. Built lazily so a text-only call pays nothing
        // WHY: and its path stays untouched.
        let builtinImageRead: ReturnType<typeof createReadTool> | undefined;
        const readImageViaBuiltin = async (absolutePath: string) => {
          builtinImageRead ??= createReadTool(cwd);
          return builtinImageRead.execute(_toolCallId, { path: absolutePath }, signal);
        };
        // WHY: spec §4.2 — the read draws on the call's 200,000-line served budget, so a file that
        // WHY: cannot afford what is left is refused inline instead of every prepared anchor,
        // WHY: normalized text and hash staying alive until the return.
        let remainingServedLines = SERVED_MAX_LINES;

        // WHY: one file per call (ADR-0041 D1) — no fan-out loop, no sibling fallbacks: the single
        // WHY: target below is the call, so its outcome is the call's outcome.
        {
          const target = request;
          abortIf(signal);
          const mode = request.mode;
          // WHY: the served cap bounds the anchor space a read materializes; a verbatim file serves no
          // WHY: anchors, so it carries no cap here (the decode gate is the served path's).
          const cap = mode === "served" ? { maxLines: remainingServedLines } : {};
          // WHY: an anchor window must resolve BEFORE the file is prepared (its offset is not known
          // WHY: yet), so the file is read once here and handed to the seam below — never twice.
          const wantsAnchor = target.windows?.some((window) => window.kind === "anchor") === true;
          const preloaded: LFile | undefined = wantsAnchor
            ? await loadFileKindAndText(toCwd(target.file, cwd), {
                ...cap,
                displayPath: target.file,
              })
            : undefined;
          let resolver: AnchorResolver | undefined;
          // WHY: resolution is lineage-scoped, not mode-scoped (spec §4.3): the store now opens for an
          // WHY: anchor window of a verbatim target too, so this guard is the safety net for a window
          // WHY: whose file could not be loaded as text — that window falls through to the same §4.3
          // WHY: "not found" warning instead of dereferencing a store that is not there.
          if (store !== undefined && preloaded !== undefined && preloaded.kind === "text") {
            const norm = await decodeNormText(target.file, cwd, {
              ...(signal !== undefined ? { signal } : {}),
              ...cap,
              preloadedFile: preloaded,
            });
            resolver = {
              sessionKey: sessionFromContext(sessionCtx, norm.absolutePath).sessionKey,
              absolutePath: norm.absolutePath,
              normalized: norm.normalized,
              store,
            };
          }
          const plan = planWindows(target, resolver);
          // WHY: single-window reads render as one §4.4 page (header plus continuation footer,
          // WHY: no sub-banner): the flattening unifies the legacy page chrome onto the canonical
          // WHY: shape, a visible change for `files`-shaped singles that rendered the bounded-ask
          // WHY: sub-banner at base. Multi-window and anchor-window reads keep the sub-banners.
          const singlePage =
            target.windows?.length === 1 && target.windows[0]?.kind === "offset"
              ? { offset: target.windows[0].offset, limit: target.windows[0].limit }
              : undefined;
          // WHY: Deep seam: one call handles kind detection, decode, normalize, hash, preview.
          // WHY: `noPersist` defers the authoritative materialization until the served windows are
          // WHY: known, so the snapshots + lineage + retirement + lease grants below commit as the ONE
          // WHY: transaction spec §3.1.2 mandates instead of materializing first and leasing later.
          const prepared = await prepareFile(target.file, cwd, {
            ...(signal !== undefined ? { signal } : {}),
            ...(singlePage !== undefined
              ? { offset: singlePage.offset, limit: singlePage.limit }
              : plan.windows !== undefined
                ? { windows: plan.windows }
                : {}),
            // WHY: the served cap stays the served budget (independent of the anchor space): the paged
            // WHY: walk still retains one anchor per hashed line (see `src/constants.ts`), so the budget
            // WHY: survives paging — while verbatim skips the cap and the store (no anchors to bound).
            maxLines: remainingServedLines,
            ...(mode === "served" && store !== undefined ? { store } : {}),
            noPersist: true,
            render: mode,
            ...(preloaded === undefined ? {} : { preloadedFile: preloaded }),
          });
          if (prepared.kind === "image") {
            // WHY: the interception point — the image never becomes a `results` entry, so no image
            // WHY: content enters the served / hash / snapshot / lease paths below. The lone image
            // WHY: delegates directly to the builtin and returns its image block.
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
          // WHY: a served file draws the WHOLE file's line count off the call's budget, not its page —
          // WHY: the paged walk retained one anchor per hashed line, which is what the budget bounds.
          // WHY: A verbatim file takes no cap and so draws nothing.
          if (mode === "served") remainingServedLines -= prepared.lineTotals.split;
        }
        const results: FileResult[] = ordered.flatMap((outcome) =>
          outcome.kind === "file" ? [outcome.entry] : [],
        );
        const preparedFiles = results.filter(isPrepared);
        for (const entry of preparedFiles) {
          if (entry.mode !== "served" || entry.plan.omittedAll) continue;
          const adopted = entry.prepared.statAdoption;
          if (adopted !== undefined) {
            // WHY: (ADR-0043) the epoch names the same bytes `fileSnap` would describe — the checksum
            // WHY: comes from the stat-matched snapshot, so adoption does not re-hash the content just
            // WHY: to state which version it read.
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
          (entry) => entry.mode === "served" && !entry.plan.omittedAll,
        );
        // WHY: a verbatim-only call shares admission/normalization but must not touch served state —
        // WHY: no lease, snapshot, epoch, drift clear, or span notification. Return before any of it.
        if (servedEntries.length === 0) {
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
        // WHY: the materialization (spec §3.1.2 steps 4-6): the file's snapshot + lineage +
        // WHY: retirement + served leases commit in ONE `BEGIN IMMEDIATE`, so a read can never lease
        // WHY: anchors without its snapshot.
        // WHY: Best-effort — a store failure never fails the read; the next call re-materializes.
        try {
          // WHY: (ADR-0043) a stat-matched page already names a committed snapshot: adopting it on the
          // WHY: same identity commits the leases and mirror a materialization owns without hashing the
          // WHY: content or splitting its lines again. A `false` (the row lost a race with a vacuum or a
          // WHY: re-stamp) folds the entry back into the content-hash batch below, which is the only
          // WHY: writer allowed to decide what this content's identity is.
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
          // SAFETY: best-effort post-read materialization — the preview rows are already computed
          // SAFETY: and the served mirror below still records them; a missed snapshot/lease degrades
          // SAFETY: to the fail-closed path the next edit would take anyway.
          reportDiagnostic("read", "Failed to commit read-path snapshot materialization:", error);
        }
        for (const entry of servedEntries) {
          const session = sessionFromContext(sessionCtx, entry.prepared.absolutePath);
          const isFullRead = entry.plan.windows === undefined && entry.truncation === undefined;
          // WHY: one file per call, so a session-write failure for the lone file stays the call's
          // WHY: failure — the single-file contract pins it, exactly as the base multi-file code did
          // WHY: for lone reads.
          // WHY: mirror-only — the leases already committed in the transaction above, so no
          // WHY: `contentHash` is passed and no third transaction remains on the read path. Canon
          // WHY: evidence needs no write at all: it is derived from those leases (#151).
          await session.recordEpoch({
            rows: servedRowsOf(entry),
            lineCount: entry.prepared.lineTotals.visible,
            // WHY: (ADR-0043) a stat-adopted page holds only the anchors it served. A full read
            // WHY: resolved every line (its one range is the whole file), so the array is whole exactly
            // WHY: then; a partial read never consumes these hashes, so it passes none.
            ...(isFullRead ? { fullReadHashes: entry.prepared.fileHashes } : {}),
            ...(isFullRead && entry.snapshotId !== undefined
              ? { snapshotId: entry.snapshotId }
              : {}),
            isFullRead,
          });
          if (isFullRead) await session.clearDrift();
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
