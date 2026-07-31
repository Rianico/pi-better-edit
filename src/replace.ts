import { Markdown, Text } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "fs";
import {
  genDiff,
  restoreEndings,
} from "./replace-diff";
import { readNormFile } from "./file-reader";
import { normReq, normalizeFilePath, tryParseContentLines } from "./replace-normalize";
import { isRec, has, rejectUnknownFields, abortIf } from "./utils";
import { MAX_HASH_LINES } from "./constants";
import { resolveTarget, writeAtomic } from "./fs-write";
import {
  applyEdits,
  lineHashes,
  resEdits,
  type HTEdit,
} from "./hashline";
import { toCwd } from "./paths";
import { fileSnap } from "./file-reader";
import {
  buildChanged,
  buildNoop,
  type RMeta,
  type RMetrics,
} from "./replace-response";
import {
  buildAppliedText,
  mkMdTheme,
  fmtCall,
  fmtResultMd,
  getPreviewInput,
  getResultText,
  isApplied,
  type RPreview,
  type RRState,
} from "./replace-render";
import { loadP, loadGuide } from "./prompts";
import { saveUndo } from "./replace-undo";
import { loadHashStore, type HashStore } from "./hash-store";

const contentLinesSchema = Type.Array(Type.String(), {
  description:
    "Literal file content, one string per line."
});

const hashRangeInclSchema = Type.Array(
  Type.String({ description: "A 3-char HASH from read output" }),
  {
    description: "Inclusive [start_hash, end_hash] — pair of 3-char hashes from read output.",
    minItems: 2,
    maxItems: 2,
  },
);

const changeItemSchema = Type.Object(
  {
    content_lines: contentLinesSchema,
    hash_range_inclusive: hashRangeInclSchema,
  },
  { additionalProperties: false },
);

export const editToolSchema = Type.Object(
  {
    changes: Type.Array(changeItemSchema, { description: "Array of edits. Each edit pairs content_lines (literal file content, one string per line) with hash_range_inclusive (inclusive [start_hash, end_hash] — pair of 3-char hashes from read output)." }),
    path: Type.String({ description: "Path to edit" }),
  },
  { additionalProperties: false },
);

export const flatEditToolSchema = Type.Object(
  {
    content_lines: contentLinesSchema,
    hash_range_inclusive: hashRangeInclSchema,
    path: Type.String({ description: "Path to edit" }),
  },
  { additionalProperties: false },
);

export type ReqParams = {
  path: string;
  changes: HTEdit[];
};

export type ReplaceDetails = {
  diff: string;
  firstChangedLine?: number;
  snapshotId?: string;
  classification?: "noop";
  structureOutline?: string[];
  metrics?: RMetrics;
};

interface PipelineResult {
  path: string;
  toolEdits: HTEdit[];
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: "\r\n" | "\n";
  hadUtf8DecodeErrors: boolean;
  warnings: string[];
  noopEdits?: { editIndex: number; loc: string; currentContent: string }[];
  firstChangedLine?: number;
  lastChangedLine?: number;
  originalHashes: string[];
  resultHashes: string[];
  totalAddedLines: number;
  totalRemovedLines: number;
}

const ROOT_KS = new Set(["path", "changes", "content_lines", "hash_range_inclusive"]);

const LEGACY_KS = ["oldText", "newText", "old_text", "new_text", "old_range", "start", "end", "lines"];

export function assertNoLegacyKeys(request: unknown): void {
  if (!isRec(request)) return;
  for (const legacyKey of LEGACY_KS) {
    if (has(request, legacyKey)) {
      throw new Error(
        `[E_LEGACY_SHAPE] "${legacyKey}" is not supported. Use {content_lines: [...], hash_range_inclusive: ["<START>", "<END>"]}.`
      );
    }
  }
}

export function assertReq(
  request: unknown,
  flat?: boolean
): asserts request is ReqParams {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }

  assertNoLegacyKeys(request);

  rejectUnknownFields(request, ROOT_KS, "Edit request");

  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
  }

  if (!Array.isArray(request.changes)) {
    if (flat) {
      throw new Error(
        '[E_BAD_SHAPE] Edit request requires both "content_lines" and "hash_range_inclusive" at the top level.',
      );
    }
    throw new Error('[E_BAD_SHAPE] Edit request requires a "changes" array. Each change is { content_lines: [...], hash_range_inclusive: ["<START>", "<END>"] }.');
  }
}

export interface ExecPipelineOptions {
  accessMode?: number;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
}

function collectRemovedHashes(
  resolved: { hash_range_inclusive: [{ hash: string }, { hash: string }] }[],
  originalHashes: string[],
): Set<string> {
  const removedHashes = new Set<string>();
  for (const edit of resolved) {
    const startHash = edit.hash_range_inclusive[0].hash;
    const endHash = edit.hash_range_inclusive[1].hash;
    const startLine = originalHashes.indexOf(startHash);
    const endLine = originalHashes.indexOf(endHash);
    if (startLine >= 0 && endLine >= 0) {
      for (let i = startLine; i <= endLine; i++) {
        removedHashes.add(originalHashes[i]!);
      }
    }
  }
  return removedHashes;
}

function countLineChanges(
  resolved: { hash_range_inclusive: [{ hash: string }, { hash: string }]; content_lines: string[] }[],
  originalHashes: string[],
  noopEdits: { editIndex: number }[] | undefined,
): { totalAddedLines: number; totalRemovedLines: number } {
  let totalAddedLines = 0;
  let totalRemovedLines = 0;
  const noopIndices = new Set(noopEdits?.map((n) => n.editIndex) ?? []);
  for (let i = 0; i < resolved.length; i++) {
    if (noopIndices.has(i)) continue;
    const edit = resolved[i]!;
    const startLine = originalHashes.indexOf(edit.hash_range_inclusive[0].hash);
    const endLine = originalHashes.indexOf(edit.hash_range_inclusive[1].hash);
    if (startLine >= 0 && endLine >= 0) {
      totalRemovedLines += endLine - startLine + 1;
    }
    totalAddedLines += edit.content_lines.length;
  }
  return { totalAddedLines, totalRemovedLines };
}

export async function execPipeline(
  params: ReqParams,
  cwd: string,
  options?: ExecPipelineOptions,
): Promise<PipelineResult> {

  const path = params.path;
  const toolEdits = Array.isArray(params.changes)
    ? (params.changes as HTEdit[])
    : [];

  if (toolEdits.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "changes" array.');
  }

  const hashStore = options?.store ?? await loadHashStore();

  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath } = await readNormFile(
    path, cwd, { signal: options?.signal, accessMode: options?.accessMode, maxLines: MAX_HASH_LINES, store: hashStore },
  );

  const resolved = resEdits(toolEdits);
  const anchorResult = applyEdits(
    originalNormalized,
    resolved,
    options?.signal,
    originalHashes,
    path,
  );

  const result = anchorResult.content;

  const removedHashes = collectRemovedHashes(resolved, originalHashes);

  const noPersist = options?.noPersist;
  const resultHashes = await lineHashes(result, absolutePath, {
    content: originalNormalized,
    hashes: originalHashes,
    removedHashes,
  }, hashStore, noPersist !== true);

  const warnings = [...(anchorResult.warnings ?? [])];

  const { totalAddedLines, totalRemovedLines } = countLineChanges(
    resolved, originalHashes, anchorResult.noopEdits,
  );

  return {
    path,
    toolEdits,
    originalNormalized,
    result,
    bom,
    originalEnding,
    hadUtf8DecodeErrors,
    warnings,
    noopEdits: anchorResult.noopEdits,
    firstChangedLine: anchorResult.firstChangedLine,
    lastChangedLine: anchorResult.lastChangedLine,
    resultHashes,
    originalHashes,
    totalAddedLines,
    totalRemovedLines,
  };
}

export async function compPreview(
  request: unknown,
  cwd: string,
  flat?: boolean
): Promise<RPreview> {
  try {
    const normalized = normReq(request);
    if (flat && isRec(request) && Array.isArray(request.changes)) {
      return {
        error: `[E_BAD_SHAPE] Flat mode does not accept a "changes" array. Send content_lines and hash_range_inclusive at the top level (one edit per call), or use bulk mode for multiple edits per call.`
      };
    }
    assertReq(normalized, flat);
    const { path, originalNormalized, originalHashes, result, resultHashes } = await execPipeline(
      normalized,
      cwd,
      { accessMode: constants.R_OK, noPersist: true },
    );

    if (originalNormalized === result) {
      return {
        error: `No changes made to ${path}. The edits produced identical content.`,
      };
    }

    return { diff: genDiff(originalNormalized, result, 4, resultHashes, originalHashes).diff };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

type ToolDef = ToolDefinition<
  any,
  ReplaceDetails,
  RRState
> & { renderShell?: "default" | "self" };

export function reuseText(context: any, content: string): Text {
  const t = context.lastComponent instanceof Text
    ? context.lastComponent
    : new Text("", 0, 0);
  t.setText(content);
  return t;
}

export function reuseMarkdown(context: any, content: string, theme: any): Markdown {
  const m = context.lastComponent instanceof Markdown
    ? context.lastComponent
    : new Markdown("", 0, 0, mkMdTheme(theme));
  m.setText(content);
  return m;
}

const MODE_CFG = {
  flat: {
    desc: " Only one edit per call. The `hash_range_inclusive` and `content_lines` fields sit at the top level of the request object.",
    examples: [
      "", "Single line:", "{ \"content_lines\": [\"const x = 1;\"], \"hash_range_inclusive\": [\"MQX\", \"MQX\"], \"path\": \"src/main.ts\" }", "", "Range replace:", "{ \"content_lines\": [\"function greet() {\", \"  return 1;\", \"}\"], \"hash_range_inclusive\": [\"ZPM\", \"VRW\"], \"path\": \"src/main.ts\" }",
    ].join("\n"),
    rules: "",
    requestStructure: [
      "Flat mode:", "```json", "{ \"content_lines\": [...], \"hash_range_inclusive\": [\"aB3\", \"xY7\"], \"path\": \"...\" }", "```",
    ].join("\n"),
    prefix: "performing one edit per call",
  },
  bulk: {
    desc: "\n\nPut all operations on one file in a single `replace` call. Stack every region into the `changes` array, even when they are far apart. Anchors within one call must all come from the same pre-edit read; the runtime applies them atomically against that one snapshot.",
    examples: [
      "", "Single line:", "{ \"changes\": [{ \"content_lines\": [\"const x = 1;\"], \"hash_range_inclusive\": [\"MQX\", \"MQX\"] }], \"path\": \"src/main.ts\" }", "", "Range replace:", "{ \"changes\": [{ \"content_lines\": [\"function greet() {\", \"  return 1;\", \"}\"], \"hash_range_inclusive\": [\"ZPM\", \"VRW\"] }], \"path\": \"src/main.ts\" }",
    ].join("\n"),
    rules: "- Multiple edits in one call must not overlap. Overlapping ranges are rejected with [E_EDIT_CONFLICT].",
    requestStructure: [
      "Bulk mode (default):", "```json", "{ \"changes\": [{ \"content_lines\": [...], \"hash_range_inclusive\": [\"aB3\", \"xY7\"] }], \"path\": \"...\" }", "```",
    ].join("\n"),
    prefix: "batching all changes to a file in one call",
  },
} as const;

export function buildToolDef(opts: { flat: boolean; autoRead?: boolean }): ToolDef {
  const cfg = MODE_CFG[opts.flat ? "flat" : "bulk"];

  const E_DESC = loadP("../prompts/replace.md");
  const E_SNIPPET = loadP("../prompts/replace-snippet.md", {
    MODE_PREFIX: cfg.prefix,
  });
  const E_GUIDE = loadGuide("../prompts/replace-guidelines.md");

  const parameters = opts.flat ? flatEditToolSchema : editToolSchema;

  return {
    name: "replace",
    label: "Replace",
    description: E_DESC,
    parameters,
    promptSnippet: E_SNIPPET,
    promptGuidelines: E_GUIDE,
    prepareArguments: opts.flat
      ? (args: unknown) => {
          assertNoLegacyKeys(args);
          if (!isRec(args)) return args as any;
          const record = { ...args };
          normalizeFilePath(record);
          if (has(record, "content_lines") && typeof record.content_lines === "string") {
            tryParseContentLines(record, "content_lines");
          }
          return record;
        }
      : (args: unknown) => {
          assertNoLegacyKeys(args);
          return normReq(args) as ReqParams;
        },
    renderShell: "default",
    renderCall(args, theme, context) {
      const previewInput = getPreviewInput(args);
      if (context.executionStarted) {
        context.state.argsKey = undefined;
        context.state.preview = undefined;
        context.state.previewGeneration =
          (context.state.previewGeneration ?? 0) + 1;
      } else if (!context.argsComplete || !previewInput) {
        context.state.argsKey = undefined;
        context.state.preview = undefined;
        context.state.previewGeneration =
          (context.state.previewGeneration ?? 0) + 1;
      } else {
        const argsKey = JSON.stringify(previewInput);
        if (context.state.argsKey !== argsKey) {
          context.state.argsKey = argsKey;
          context.state.preview = undefined;
          const previewGeneration = (context.state.previewGeneration ?? 0) + 1;
          context.state.previewGeneration = previewGeneration;
          compPreview(previewInput, context.cwd, opts.flat)
            .then((preview) => {
              if (
                context.state.argsKey === argsKey &&
                context.state.previewGeneration === previewGeneration
              ) {
                context.state.preview = preview;
                context.invalidate();
              }
            })
            .catch((err: unknown) => {
              if (
                context.state.argsKey === argsKey &&
                context.state.previewGeneration === previewGeneration
              ) {
                context.state.preview = {
                  error: err instanceof Error ? err.message : String(err),
                };
                context.invalidate();
              }
            });
        }
      }
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        fmtCall(
          getPreviewInput(args) ?? undefined,
          context.state as RRState,
          context.expanded,
          theme,
        ),
      );
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) {
        return reuseText(context, theme.fg("warning", "Editing..."));
      }

      const typedResult = result as {
        content?: Array<{ type: string; text?: string }>;
        details?: ReplaceDetails;
      };
      const renderedText = getResultText(typedResult);

      const renderState = context.state as RRState | undefined;
      if (renderState) {
        renderState.preview = undefined;
        renderState.previewGeneration = (renderState.previewGeneration ?? 0) + 1;
      }

      if (context.isError) {
        return renderedText
          ? reuseText(context, `\n${theme.fg("error", renderedText)}`)
          : new Text("", 0, 0);
      }

      if (isApplied(typedResult.details)) {
        const appliedText = buildAppliedText(renderedText, typedResult.details, theme);
        return appliedText ? reuseText(context, appliedText) : new Text("", 0, 0);
      }

      if (!renderedText) return new Text("", 0, 0);
      return reuseMarkdown(context, fmtResultMd(renderedText), theme);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const canonical = normReq(params);

      const normalizedParams = canonical as { path: string; changes: HTEdit[] };
      const path = normalizedParams.path;
      const absolutePath = toCwd(path, ctx.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);
      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(signal);

        const {
          originalNormalized,
          originalHashes,
          result,
          bom,
          originalEnding,
          hadUtf8DecodeErrors,
          warnings,
          noopEdits,
          firstChangedLine,
          lastChangedLine,
          resultHashes,
          totalAddedLines,
          totalRemovedLines,
        } = await execPipeline(
          normalizedParams,
          ctx.cwd,
          { accessMode: constants.R_OK | constants.W_OK, signal },
        );

        const editsAttempted = opts.flat
          ? 1
          : Array.isArray(normalizedParams.changes)
            ? normalizedParams.changes.length
            : 0;

        if (originalNormalized === result) {
          const noopSnapshotId = (await fileSnap(absolutePath)).snapshotId;
          return buildNoop({
            path,
            noopEdits,
            snapshotId: noopSnapshotId,
            editMeta: {
              editsAttempted,
              noopEditsCount: noopEdits?.length ?? 0,
              addedLines: 0,
              removedLines: 0,
            },
            warnings,
          });
        }

        if (hadUtf8DecodeErrors) {
          warnings.push(
            "Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
          );
        }

        abortIf(signal);
        await writeAtomic(
          absolutePath,
          bom + restoreEndings(result, originalEnding),
        );
        saveUndo(mutationTargetPath, {
          content: originalNormalized,
          bom,
          originalEnding,
          hashes: originalHashes,
        });
        const updatedSnapshotId = (await fileSnap(absolutePath))
          .snapshotId;

        const editMeta: RMeta = {
          editsAttempted,
          noopEditsCount: noopEdits?.length ?? 0,
          firstChangedLine,
          lastChangedLine,
          addedLines: totalAddedLines,
          removedLines: totalRemovedLines,
        };

        const successInput = {
          path,
          originalNormalized,
          originalHashes,
          result,
          resultHashes,
          warnings,
          snapshotId: updatedSnapshotId,
          editMeta,
        };
        return buildChanged(successInput);
      });
    },
  };
}

export function regReplace(pi: ExtensionAPI, autoRead?: boolean): void {
  pi.registerTool(buildToolDef({ flat: false, autoRead }));
}

export function buildToolDefFlat(autoRead?: boolean) {
  return buildToolDef({ flat: true, autoRead });
}

export function regReplaceFlat(pi: ExtensionAPI, autoRead?: boolean): void {
  pi.registerTool(buildToolDef({ flat: true, autoRead }));
}
