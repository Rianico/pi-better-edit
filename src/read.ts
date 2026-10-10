import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_READ_FILES,
  MAX_READ_WINDOWS,
  MAX_READ_WINDOWS_MESSAGE,
  SERVED_MAX_LINES,
} from "./constants.js";
import { HASH_LEN } from "./hashline/alphabet.js";
import type { ServedRow } from "./hashline/served.js";
import { loadHashStore } from "./hash-store.js";
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
import { leaseSpanSource } from "./mutation-engine/edit-source.js";
import { resolveLineIdentity } from "./hashline/resolve.js";
import { toCwd } from "./paths.js";
import { DomainError } from "./domain-errors.js";
import { notifyServedSpans, servedRowsToSpans } from "./served-spans.js";
import { fileSnap } from "./file-reader.js";
import { snapshotHashFor, upsertSnapshotsFor } from "./snapshot-store";
// WHY: Facade re-export for callers still importing preview directly
export { fmtReadPreview } from "./file-content/preview.js";

const R_DESC = loadP("../prompts/read.md");
const R_SNIPPET = loadP("../prompts/read-snippet.md");

/** The `limit` a legacy `{ file, offset }` call folds into (spec §4.2) — and an omitted window limit. */
const LEGACY_WINDOW_LIMIT = 50;
/** `radius` default for `around_anchor` (spec §4.1/§4.3). */
const DEFAULT_ANCHOR_RADIUS = 10;

function readGuide(): string[] {
  return loadGuide("../prompts/read-guidelines.md");
}

// WHY: the builtin renderers read `file_path ?? path`; our payload is `file`, but a legacy
// WHY: `path` caller must still render, so the seam accepts either key.
type ReadRenderArgs = { file?: string; path?: string };

/** Render mode of one file: `served` (anchored rows) or `verbatim` (plain text, no leases). */
export type RenderMode = "served" | "verbatim";

/** A line window of one file, in the reader's 1-indexed terms (spec §4.1). */
export interface OffsetWindow {
  offset: number;
  limit: number;
}

/** A window anchored to a line identity this session served (spec §4.1). */
export interface AnchorWindow {
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
        description: `Number of lines to read. Defaults to ${LEGACY_WINDOW_LIMIT} when \`offset\` is given.`,
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

const readFileTargetSchema = Type.Object({
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
      description: "Render mode for this file. Overrides the top-level `mode`.",
    }),
  ),
});

// WHY: `files` is optional rather than required so the legacy single-file shape (`file`/`offset`/
// WHY: `limit`/`windows`, spec §4.2) still satisfies the registered schema; admission enforces that
// WHY: one of `files` and `file` is present, which TypeBox cannot express without losing the old shape.
export const readToolSchema = Type.Object({
  files: Type.Optional(
    Type.Array(readFileTargetSchema, {
      minItems: 1,
      maxItems: MAX_READ_FILES,
      description: "Files to read in one call; each carries its own windows and render mode.",
    }),
  ),
  mode: Type.Optional(renderModeSchema),
  file: Type.Optional(
    Type.String({ description: "Path to the file to read (legacy; prefer `files`)." }),
  ),
  path: Type.Optional(
    Type.String({ description: "Legacy alias of `file`; the §4.2 fold accepts either key." }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Legacy: line number to start reading from (1-indexed); folds into a window.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Legacy: maximum number of lines to read." }),
  ),
  windows: Type.Optional(
    Type.Array(
      Type.Object({
        offset: Type.Integer({
          minimum: 1,
          description: "Line number to start reading from (1-indexed)",
        }),
        limit: Type.Integer({
          minimum: 1,
          description: "Maximum number of lines to read",
        }),
      }),
      {
        maxItems: MAX_READ_WINDOWS,
        description:
          "Batch several ranges in one `read` call; in the default `served` mode every window's rows are served, so anchors from all of them work in a single `edit`",
      },
    ),
  ),
});

type RawReadParams = Record<string, unknown>;

/** One admitted window: an offset window, or an anchor window not yet resolved to one. */
type AdmittedWindow =
  | { kind: "offset"; offset: number; limit: number }
  | { kind: "anchor"; anchor: string; radius: number };

interface AdmittedTarget {
  file: string;
  /** Absent when the request named no windows (`undefined` and `[]` both read from line 1). */
  windows?: AdmittedWindow[];
  /**
   * The legacy single-file page ask (`{ file, offset, limit }`, spec §4.2), kept alongside the folded
   * window so the file still renders as ONE page with today's chrome.
   *
   * WHY: the fold above is for admission — caps, limits and one code path for the rows — while §4.4's
   * page header/footer (a §4.4 served read names `windows: [{ offset }]` to continue) belongs to the
   * next stage. Rendering the folded window with the window sub-banner now would change every legacy
   * page's output, re-pointing byte-exact goldens and integration probes for chrome the next stage
   * replaces; the legacy page keeps its contract until that lands. Absent on every `files`-shaped call.
   */
  legacyPage?: { offset?: number; limit?: number };
  mode?: RenderMode;
}

interface AdmittedRequest {
  files: AdmittedTarget[];
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
  // WHY: an offset with no limit is the legacy `{ file, offset }` ask, so it takes the same window
  // WHY: size the §4.2 fold gives that shape instead of inventing a third default.
  const limit =
    raw.limit === undefined ? LEGACY_WINDOW_LIMIT : positiveInt(raw.limit, `${label}.limit`);
  return { kind: "offset", offset, limit };
}

/**
 * Tolerant runtime admission (spec §4.2): folds the legacy single-file shape into `files` exactly as
 * the specification's block does, then validates every file and window and the call-wide window cap.
 *
 * Runs on a copy — the registered payload the caller passed is never mutated, and the renderers read
 * the original `args` object.
 */
function admitReadRequest(params: RawReadParams): AdmittedRequest {
  const normalized: RawReadParams = { ...params };
  // WHY: `path` is `file`'s legacy alias and §4.2's own fold snippet reads `legacy.file ?? legacy.path`,
  // WHY: so the gate keys on the PAIR. Gating on `file` alone published `path` and then refused it.
  const legacyFilePath = params.file ?? params.path;
  if (legacyFilePath && !params.files) {
    // WHY: the §4.2 fold, on a copy. `limit` without `offset` still names a window (from line 1):
    // WHY: dropping it would read the whole file for a caller who asked for a page.
    const legacy = normalized;
    const hasWindow = legacy.offset !== undefined || legacy.limit !== undefined;
    normalized.files = [
      {
        file: legacyFilePath as string,
        windows: hasWindow
          ? [{ offset: legacy.offset ?? 1, limit: legacy.limit ?? LEGACY_WINDOW_LIMIT }]
          : legacy.windows,
      },
    ];
  }
  // WHY: the legacy page ask survives the fold for the RENDER path (see `AdmittedTarget.legacyPage`).
  const legacyPage =
    !params.files && legacyFilePath && (params.offset !== undefined || params.limit !== undefined)
      ? {
          ...(params.offset !== undefined ? { offset: params.offset as number } : {}),
          ...(params.limit !== undefined ? { limit: params.limit as number } : {}),
        }
      : undefined;

  const mode = admitMode(normalized.mode) ?? "served";
  const files = normalized.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw badPayload("Read request needs at least one file: pass `files` (or a legacy `file`).");
  }
  if (files.length > MAX_READ_FILES) {
    throw badPayload(`Read request accepts at most ${MAX_READ_FILES} files.`);
  }
  let windowTotal = 0;
  const targets = files.map((entry, index): AdmittedTarget => {
    if (entry === null || typeof entry !== "object") {
      throw badPayload(`Read request field "files[${index}]" must be an object.`);
    }
    const target = entry as RawReadParams;
    const file = target.file;
    if (typeof file !== "string" || file === "") {
      throw badPayload(`Read request field "files[${index}].file" must be a non-empty path.`);
    }
    const rawWindows = target.windows;
    if (rawWindows !== undefined && !Array.isArray(rawWindows)) {
      throw badPayload(`Read request field "files[${index}].windows" must be an array.`);
    }
    const windows =
      rawWindows === undefined || rawWindows.length === 0
        ? undefined
        : rawWindows.map((window, windowIndex) =>
            admitWindow(window, `files[${index}].windows[${windowIndex}]`),
          );
    windowTotal += windows?.length ?? 0;
    const entryMode = admitMode(target.mode);
    return {
      file,
      ...(windows !== undefined ? { windows } : {}),
      ...(entryMode !== undefined ? { mode: entryMode } : {}),
      ...(index === 0 && legacyPage !== undefined ? { legacyPage } : {}),
    };
  });
  // WHY: the per-file `maxItems` cannot see a multi-file call, so the call-wide cap is enforced here —
  // WHY: window count is what multiplies the auto-read budget, no matter how the windows are split.
  if (windowTotal > MAX_READ_WINDOWS) {
    throw badPayload(MAX_READ_WINDOWS_MESSAGE);
  }
  return { files: targets, mode };
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
function planWindows(target: AdmittedTarget, resolver: AnchorResolver | undefined): WindowPlan {
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
  snapshotId?: string;
}

/** The `E_UNSUPPORTED_FILE` a non-text file owes, shaped exactly like the single-file read's. */
function unsupportedFile(target: AdmittedTarget, prepared: PrepareResult): DomainError {
  if (prepared.kind === "directory") {
    return new DomainError("E_UNSUPPORTED_FILE", { path: target.file, kind: "directory" });
  }
  if (prepared.kind === "binary") {
    return new DomainError("E_UNSUPPORTED_FILE", {
      path: target.file,
      kind: "binary",
      description: prepared.description,
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

/**
 * The message one failed file contributes. WHY: every `DomainError` format already names its path
 * ("File not found: x."), and it is byte-identical to what a lone failing read throws — inventing a
 * second wording here would make the same refusal read two ways. A non-domain throw carries no such
 * contract, so the file is prefixed onto it.
 */
function failureMessage(file: string, error: unknown): string {
  if (error instanceof DomainError) return error.message;
  return `${file}: ${error instanceof Error ? error.message : String(error)}`;
}

/** The per-file header (spec §4.4): names the file and, per mode, what its rows carry. */
function fileHeader(entry: PreparedTarget): string {
  const lines = entry.prepared.lineTotals.visible;
  return entry.mode === "verbatim"
    ? `[${entry.file} (verbatim, ${lines} lines, no anchors)]`
    : `[${entry.file} (${lines} lines total)]`;
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

/** One file's rows for the served-state channels: nothing when the file rendered no page. */
function servedRowsOf(entry: PreparedTarget): ServedRow[] {
  return entry.plan.omittedAll ? [] : entry.prepared.served;
}

export function regRead(pi: ExtensionAPI): void {
  // WHY: pi falls back to the builtin `read` renderer by tool name, but that renderer reads
  // WHY: `file_path ?? path`. Our payload field is `file`, so re-map it for rendering only —
  // WHY: the call line and expanded output keep the filename, and `args` is never mutated.
  const builtinReadDef = createReadToolDefinition("");
  const builtinRenderCall = builtinReadDef.renderCall as any;
  const builtinRenderResult = builtinReadDef.renderResult as any;
  pi.registerTool({
    name: "read",
    label: "Read",
    description: R_DESC,
    promptSnippet: R_SNIPPET,
    promptGuidelines: readGuide(),
    // SAFETY: the builtin renderers are keyed on `file_path ?? path`; the spread re-maps our
    // SAFETY: `file` payload onto `path` for rendering without mutating the caller's `args`.
    renderCall: (args: ReadRenderArgs, theme, context) =>
      builtinRenderCall({ ...args, path: args?.file ?? args?.path }, theme, context),
    renderResult: (result, options, theme, context) => {
      // SAFETY: renderers receive raw call args, not the validated payload, so `context.args` may
      // SAFETY: carry a legacy `path` that `Static<TParams>` does not model; this cast reads only
      // SAFETY: `file`/`path`, both of which the renderers below already key on.
      const args = context.args as ReadRenderArgs;
      return builtinRenderResult(result, options, theme, {
        ...context,
        args: { ...args, path: args?.file ?? args?.path },
      });
    },
    parameters: readToolSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = admitReadRequest(params as RawReadParams);
      const cwd = ctx.cwd as string;
      const sessionCtx = ctx as { sessionManager?: { getSessionId(): string } };
      abortIf(signal);
      // WHY: spec §4.3 resolves `around_anchor` against the target file's active lineage for the
      // WHY: session and carries NO mode qualifier, so the store opens for an anchor window whether or
      // WHY: not that target serves rows. Gating it on "some target is served" made one target's output
      // WHY: depend on a sibling's mode. A call naming neither a served target nor an anchor window
      // WHY: still opens nothing, so the read that serves nothing pays nothing.
      const needsStore = request.files.some(
        (target) =>
          (target.mode ?? request.mode) === "served" ||
          target.windows?.some((window) => window.kind === "anchor") === true,
      );
      const store = needsStore ? await loadHashStore() : undefined;
      const results: FileResult[] = [];
      // WHY: spec §4.2 — the budget is CALL-WIDE: every served file draws on the same 200,000 lines,
      // WHY: so the file that cannot afford what is left is refused inline instead of every prepared
      // WHY: file's anchors, normalized text and hashes staying alive until the return.
      let remainingServedLines = SERVED_MAX_LINES;

      for (const target of request.files) {
        abortIf(signal);
        try {
          const mode = target.mode ?? request.mode;
          // WHY: the served cap bounds the anchor space a read materializes; a verbatim file serves no
          // WHY: anchors, so it carries no cap here (the decode gate is the served path's). The served
          // WHY: file is admitted against what the earlier files of this call left of the shared budget.
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
              signal,
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
          // WHY: Deep seam: one call handles kind detection, decode, normalize, hash, preview.
          // WHY: `noPersist` defers the authoritative materialization until the served windows are
          // WHY: known, so the snapshots + lineage + retirement + lease grants below commit as the ONE
          // WHY: transaction spec §3.1.2 mandates instead of materializing first and leasing later.
          const prepared = await prepareFile(target.file, cwd, {
            signal,
            ...(target.legacyPage !== undefined
              ? {
                  ...(target.legacyPage.offset !== undefined
                    ? { offset: target.legacyPage.offset }
                    : {}),
                  ...(target.legacyPage.limit !== undefined
                    ? { limit: target.legacyPage.limit }
                    : {}),
                }
              : { windows: plan.windows }),
            // WHY: the served cap stays the served budget (independent of the anchor space): the paged
            // WHY: walk still retains one anchor per hashed line (see `src/constants.ts`), so the budget
            // WHY: survives paging — while verbatim skips the cap and the store (no anchors to bound).
            maxLines: remainingServedLines,
            store: mode === "served" ? store : undefined,
            noPersist: true,
            render: mode,
            ...(preloaded === undefined ? {} : { preloadedFile: preloaded }),
          });
          if (prepared.kind !== "text") throw unsupportedFile(target, prepared);
          results.push({
            file: target.file,
            mode,
            plan,
            prepared,
            ...(plan.omittedAll
              ? {}
              : {
                  ...(prepared.truncation !== undefined ? { truncation: prepared.truncation } : {}),
                  ...(prepared.nextOffset !== undefined ? { nextOffset: prepared.nextOffset } : {}),
                }),
          });
          // WHY: a served file draws the WHOLE file's line count off the shared budget, not its page —
          // WHY: the paged walk retained one anchor per hashed line, which is what the budget bounds.
          // WHY: A verbatim file takes no cap and so draws nothing, and a refused file draws nothing.
          if (mode === "served") remainingServedLines -= prepared.lineTotals.split;
        } catch (error) {
          // WHY: one file's failure must never abort its siblings (spec §4.4): the refusal becomes
          // WHY: that file's own section and every other file still renders. A LONE file has no
          // WHY: sibling to render for, so its failure stays the call's failure — byte-identical to
          // WHY: the refusal the single-file contract pins. An abort is never a per-file error.
          if (request.files.length === 1 || signal?.aborted) throw error;
          results.push({ file: target.file, message: failureMessage(target.file, error) });
        }
      }
      const preparedFiles = results.filter(isPrepared);

      for (const entry of preparedFiles) {
        if (entry.mode !== "served" || entry.plan.omittedAll) continue;
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
      const content = [{ type: "text" as const, text: results.map(sectionText).join("\n\n") }];
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
              : { ...(firstTruncation !== undefined ? { truncation: firstTruncation } : {}), metrics },
        };
      }

      const sessionKey = sessionFromContext(
        sessionCtx,
        servedEntries[0]!.prepared.absolutePath,
      ).sessionKey;
      // WHY: the multi-file materialization (spec §3.1.2 steps 4-6, extended to N files): every
      // WHY: file's snapshot + lineage + retirement + served leases commit in ONE `BEGIN IMMEDIATE`,
      // WHY: so a multi-file read can never lease one file's anchors without the other's snapshot.
      // WHY: Best-effort — a store failure never fails the read; the next call re-materializes.
      try {
        await upsertSnapshotsFor(
          servedEntries.map((entry) => ({
            descriptor: {
              path: entry.prepared.absolutePath,
              snapshotHash: snapshotHashFor(entry.prepared.normalized),
              lineCount: entry.prepared.lineTotals.split,
              hashes: entry.prepared.fileHashes,
              content: entry.prepared.normalized,
            },
            options: {
              retireLeases: true,
              leases: { sessionKey, rows: servedRowsOf(entry) },
            },
          })),
        );
      } catch (error) {
        // SAFETY: best-effort post-read materialization — the preview rows are already computed
        // SAFETY: and the served mirror below still records them; a missed snapshot/lease degrades
        // SAFETY: to the fail-closed path the next edit would take anyway.
        console.error("Failed to commit read-path snapshot materialization:", error);
      }
      for (const entry of servedEntries) {
        const session = sessionFromContext(sessionCtx, entry.prepared.absolutePath);
        const isFullRead = entry.plan.windows === undefined && entry.truncation === undefined;
        // WHY: the mirror phase is best-effort PER FILE, exactly like the materialization phase
        // WHY: above: the leases already committed in the transaction, so a session write failing for
        // WHY: one file must not reject a call whose every row is already rendered (spec §4.4) — the
        // WHY: next edit degrades to the fail-closed path it would take anyway.
        try {
          // WHY: mirror-only — the leases already committed in the transaction above, so no
          // WHY: `contentHash` is passed and no third transaction remains on the read path. Canon
          // WHY: evidence needs no write at all: it is derived from those leases (#151).
          await session.recordEpoch({
            rows: servedRowsOf(entry),
            lineCount: entry.prepared.lineTotals.visible,
            fullReadHashes: entry.prepared.fileHashes,
            ...(isFullRead && entry.snapshotId !== undefined
              ? { snapshotId: entry.snapshotId }
              : {}),
            isFullRead,
          });
          if (isFullRead) await session.clearDrift();
        } catch (error) {
          // WHY: a LONE file has no sibling to render for, so its failure stays the call's failure,
          // WHY: exactly as the per-file admission catch above rules — the single-file contract pins it.
          if (request.files.length === 1) throw error;
          console.error(
            "Failed to mirror the served read into the session:",
            entry.prepared.absolutePath,
            error,
          );
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
          : { ...(firstTruncation !== undefined ? { truncation: firstTruncation } : {}), metrics },
      };
    },
  });
}
