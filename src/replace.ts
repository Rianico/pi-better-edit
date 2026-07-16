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
import { normReq, normalizeFilePath } from "./replace-normalize";
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
    "literal replacement file content, one string per line. Must not include the HASH│ prefix from read output.",
});

const hashRangeInclSchema = Type.Array(
  Type.String({ description: "anchor (3-char HASH)" }),
  {
    description: "inclusive hash range to replace [start_hash, end_hash]. Each element must be the 3-character hash anchor only; do not include the │ separator or line content.",
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
    changes: Type.Array(changeItemSchema, { description: "changes over $path" }),
    path: Type.String({ description: "path" }),
  },
  { additionalProperties: false },
);

export const flatEditToolSchema = Type.Object(
  {
    content_lines: contentLinesSchema,
    hash_range_inclusive: hashRangeInclSchema,
    path: Type.String({ description: "path" }),
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
}

const ROOT_KS = new Set(["path", "changes"]);

export function assertReq(
  request: unknown,
): asserts request is ReqParams {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }

  for (const legacyKey of ["oldText", "newText", "old_text", "new_text", "old_range", "start", "end", "lines"]) {
    if (has(request, legacyKey)) {
      throw new Error(
        `[E_LEGACY_SHAPE] "${legacyKey}" is not supported. Use {content_lines: [...], hash_range_inclusive: ["<START>", "<END>"]}.`
      );
    }
  }

  rejectUnknownFields(request, ROOT_KS, "Edit request");

  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
  }

  if (!Array.isArray(request.changes)) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a "changes" array. Each change is { content_lines: [...], hash_range_inclusive: ["<START>", "<END>"] }.');
  }
}

export async function execPipeline(
  params: ReqParams,
  cwd: string,
  accessMode: number,
  signal?: AbortSignal,
  store?: HashStore,
): Promise<PipelineResult> {

  const path = params.path;
  const toolEdits = Array.isArray(params.changes)
    ? (params.changes as HTEdit[])
    : [];

  if (toolEdits.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "changes" array.');
  }

  const hashStore = store ?? await loadHashStore();

  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors } = await readNormFile(
    path, cwd, signal, accessMode, undefined, MAX_HASH_LINES, hashStore,
  );

  const absolutePath = toCwd(path, cwd);
  const resolvedPath = await resolveTarget(absolutePath);
  const resolved = resEdits(toolEdits);
  const anchorResult = applyEdits(
    originalNormalized,
    resolved,
    signal,
    originalHashes,
    path,
  );

  const result = anchorResult.content;

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

  const resultHashes = await lineHashes(result, resolvedPath, {
    content: originalNormalized,
    hashes: originalHashes,
    removedHashes,
  }, hashStore);

  const warnings = [...(anchorResult.warnings ?? [])];
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
  };
}

export async function compPreview(
  request: unknown,
  cwd: string,
): Promise<RPreview> {
  try {
    const normalized = normReq(request);
    assertReq(normalized);
    const { path, originalNormalized, originalHashes, result, resultHashes } = await execPipeline(
      normalized,
      cwd,
      constants.R_OK,
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

export function buildToolDef(opts: { flat: boolean; autoRead?: boolean }): ToolDef {
  const autoRead = opts.autoRead ?? false;
  const readGuidance = autoRead
    ? "Anchors are provided automatically after write and replace operations when auto-read is enabled."
    : "Call `read` to get fresh anchors for follow-up edits.";

  const modeDesc = opts.flat
    ? " Only one edit per call (no bulk `changes` array \u2014 `hash_range_inclusive` and `content_lines` sit at the top level)."
    : "\n\nPut all operations on one file in a single `replace` call. Stack every region into the `changes` array, even when they are far apart. Anchors within one call must all come from the same pre-edit read; the runtime applies them atomically against that one snapshot.";

  const modeExamples = opts.flat
    ? [
        "", "1. Single line replace:", "```json", "{ \"content_lines\": [\"const x = 1;\"], \"hash_range_inclusive\": [\"MQX\", \"MQX\"], \"path\": \"src/main.ts\" }", "```", "", "2. Range replace (3 lines \u2192 3 new lines):", "```json", "{ \"content_lines\": [", "    \"function greet(name) {\",", "    \"  return `Hello, ${name}`;\",", "    \"}\"", "  ], \"hash_range_inclusive\": [\"ZPM\", \"VRW\"], \"path\": \"src/main.ts\" }", "```", "", "3. Delete a range:", "```json", "{ \"content_lines\": [], \"hash_range_inclusive\": [\"aB3\", \"xY7\"], \"path\": \"src/server.ts\" }", "```", "", "4. Append after the last line (include the old last line so the new line is added after it):", "```json", "{ \"content_lines\": [\"old last line\", \"new line\"], \"hash_range_inclusive\": [\"ZPM\", \"ZPM\"], \"path\": \"src/main.ts\" }", "```",
      ].join("\n")
    : [
        "", "1. Single line replace:", "```json", "{ \"changes\": [", "  { \"content_lines\": [\"const x = 1;\"], \"hash_range_inclusive\": [\"MQX\", \"MQX\"] }", "], \"path\": \"src/main.ts\" }", "```", "", "2. Range replace (3 lines \u2192 3 new lines):", "```json", "{ \"changes\": [", "  { \"content_lines\": [", "    \"function greet(name) {\",", "    \"  return `Hello, ${name}`;\",", "    \"}\"", "  ], \"hash_range_inclusive\": [\"ZPM\", \"VRW\"] }", "], \"path\": \"src/main.ts\" }", "```", "", "3. Multiple regions in one call (delete two non-adjacent ranges):", "```json", "{ \"changes\": [", "  { \"content_lines\": [], \"hash_range_inclusive\": [\"aB3\", \"xY7\"] },", "  { \"content_lines\": [], \"hash_range_inclusive\": [\"MQX\", \"ZPM\"] }", "], \"path\": \"src/server.ts\" }", "```", "", "4. Append after the last line (include the old last line so the new line is added after it):", "```json", "{ \"changes\": [", "  { \"content_lines\": [\"old last line\", \"new line\"], \"hash_range_inclusive\": [\"ZPM\", \"ZPM\"] }", "], \"path\": \"src/main.ts\" }", "```",
      ].join("\n")

  const modeRulesMid1 = opts.flat
    ? ""
    : "- `changes`, `hash_range_inclusive`, and `content_lines` must be native JSON values, not JSON strings. Do not serialize them \u2014 pass them as proper arrays and strings."

  const modeRulesMid2 = opts.flat
    ? ""
    : "- All changes in one call must be non-conflicting. The runtime rejects with `[E_EDIT_CONFLICT]` if two ranges overlap."

  const modeRulesEnd = opts.flat
    ? [
        "- The `hash_range_inclusive` is inclusive \u2014 the entire span from the first anchor through the second anchor is deleted and replaced with `content_lines`. The old lines in that span are gone. If your replacement content includes lines that already exist in the file (e.g. closing brackets), make sure those lines are within your range, otherwise they will appear twice.",
        "- `hash_range_inclusive` and `content_lines` must be native JSON values, not JSON strings. Do not serialize them \u2014 pass them as a proper array and array of strings respectively.",
      ].join("\n") + "\n"
    : ""

  const clSerializeWrong = opts.flat
    ? '{ "content_lines": "[\\"line1\\", \\"line2\\"]", "hash_range_inclusive": ["F4T", "F4T"], "path": "src/main.ts" }'
    : '{ "changes": [{ "content_lines": "[\\"line1\\", \\"line2\\"]", "hash_range_inclusive": ["F4T", "F4T"] }], "path": "src/main.ts" }'

  const clSerializeRight = opts.flat
    ? '{ "content_lines": ["line1", "line2"], "hash_range_inclusive": ["F4T", "F4T"], "path": "src/main.ts" }'
    : '{ "changes": [{ "content_lines": ["line1", "line2"], "hash_range_inclusive": ["F4T", "F4T"] }], "path": "src/main.ts" }'

  const modePrefix = opts.flat
    ? "one edit per call (flat mode)"
    : "batching all changes to a file in one call"

  const modeGuidePrefix = opts.flat
    ? "- Use `replace` with HASH anchors for all file changes. Only one edit per call (flat mode \u2014 no `changes` array)."
    : "- Use `replace` with HASH anchors for all file changes; batch every change to one file into a single `replace` call."

  const E_DESC = loadP("../prompts/replace.md", {
    MODE_DESCRIPTION: modeDesc,
    MODE_EXAMPLES: modeExamples,
    MODE_RULES_MID1: modeRulesMid1,
    MODE_RULES_MID2: modeRulesMid2,
    MODE_RULES_END: modeRulesEnd,
    CL_SERIALIZE_WRONG: clSerializeWrong,
    CL_SERIALIZE_RIGHT: clSerializeRight,
    AUTO_READ_GUIDANCE: readGuidance,
  });
  const E_SNIPPET = loadP("../prompts/replace-snippet.md", {
    MODE_PREFIX: modePrefix,
  });
  const E_GUIDE = loadGuide("../prompts/replace-guidelines.md", {
    MODE_PREFIX: modeGuidePrefix,
    AUTO_READ_GUIDANCE: readGuidance,
  });

  const parameters = editToolSchema;

  return {
    name: "replace",
    label: "Replace",
    description: E_DESC,
    parameters,
    promptSnippet: E_SNIPPET,
    promptGuidelines: E_GUIDE,
    prepareArguments: opts.flat
      ? (args: unknown) => {
          if (!isRec(args)) return args as any;
          const record = { ...args };
          normalizeFilePath(record);
          return normReq(record) as any;
        }
      : (args: unknown) =>
          normReq(args) as ReqParams,
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
          compPreview(previewInput, context.cwd)
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
        } = await execPipeline(
          normalizedParams,
          ctx.cwd,
          constants.R_OK | constants.W_OK,
          signal,
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
