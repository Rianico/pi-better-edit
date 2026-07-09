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
import { normReq, normalizeFilePath, tryParseField } from "./replace-normalize";
import { isRec, has, rejectUnknownFields } from "./utils";
import { MAX_HASH_LINES } from "./constants";
import { resolveTarget, writeAtomic } from "./fs-write";
import {
  applyEdits,
  lineHashes,
  fmtBoundaryWarning,
  resEdits,
  type HTEdit,
} from "./hashline";
import { toCwd } from "./path-utils";
import { abortIf } from "./runtime";
import { fileSnap } from "./snapshot";
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
import { readAutoReadSync } from "./config";
import { saveUndo } from "./undo-store";

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
    hash_range_inclusive: hashRangeInclSchema,
    content_lines: contentLinesSchema,
  },
  { additionalProperties: false },
);

export const editToolSchema = Type.Object(
  {
    path: Type.String({ description: "path" }),
    changes: Type.Array(changeItemSchema, { description: "changes over $path" }),
  },
  { additionalProperties: false },
);

export const flatEditToolSchema = Type.Object(
  {
    path: Type.String({ description: "path" }),
    hash_range_inclusive: hashRangeInclSchema,
    content_lines: contentLinesSchema,
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
        `[E_LEGACY_SHAPE] "${legacyKey}" is not supported. Use {hash_range_inclusive: ["<START>", "<END>"], content_lines: [...]}.`
      );
    }
  }

  rejectUnknownFields(request, ROOT_KS, "Edit request");

  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
  }

  if (!Array.isArray(request.changes)) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a "changes" array. Each change is { hash_range_inclusive: ["<START>", "<END>"], content_lines: [...] }.');
  }
}

export async function execPipeline(
  params: ReqParams,
  cwd: string,
  accessMode: number,
  signal?: AbortSignal,
): Promise<PipelineResult> {

  const path = params.path;
  const toolEdits = Array.isArray(params.changes)
    ? (params.changes as HTEdit[])
    : [];

  if (toolEdits.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "changes" array.');
  }

  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors } = await readNormFile(
    path, cwd, signal, accessMode, undefined, MAX_HASH_LINES,
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
  });

  const resultLines = result.split("\n");
  const warnings = [...(anchorResult.warnings ?? [])];
  for (const bw of anchorResult.boundaryWarnings ?? []) {
    let seen = 0;
    let matchIndex = -1;
    for (let i = 0; i < resultLines.length; i++) {
      if (resultLines[i] === bw.survivingLineContent) {
        if (seen === bw.occurrence) { matchIndex = i; break; }
        seen++;
      }
    }
    if (matchIndex >= 0) {
      warnings.push(
        fmtBoundaryWarning({
          kind: bw.kind,
          survivingContent: bw.survivingLineContent,
          matchIndex,
          resultLines,
          resultHashes,
        }),
      );
    }
  }

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

export function buildToolDef(opts: { flat: boolean }): ToolDef {
  const autoRead = readAutoReadSync();
  const readGuidance = autoRead
    ? "Anchors are provided automatically after write and replace operations when auto-read is enabled."
    : "Call `read` to get fresh anchors for follow-up edits.";

  const E_DESC = loadP(opts.flat ? "../prompts/replace-flat.md" : "../prompts/replace-bulk.md", {
    AUTO_READ_GUIDANCE: readGuidance,
  });
  const E_SNIPPET = loadP(opts.flat ? "../prompts/replace-flat-snippet.md" : "../prompts/replace-bulk-snippet.md");
  const E_GUIDE = loadGuide(opts.flat ? "../prompts/replace-flat-guidelines.md" : "../prompts/replace-bulk-guidelines.md", {
    AUTO_READ_GUIDANCE: readGuidance,
  });

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
          if (!isRec(args)) return args as any;
          const record = { ...args };
          normalizeFilePath(record);
          tryParseField(record, "hash_range_inclusive");
          tryParseField(record, "content_lines");
          return record as any;
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
      const canonical = opts.flat
        ? normReq({
            path: (params as any).path,
            changes: [{
              hash_range_inclusive: (params as any).hash_range_inclusive,
              content_lines: (params as any).content_lines,
            }],
          })
        : normReq(params);
      const normWarnings = (canonical as Record<string, unknown>)._normWarnings as string[] | undefined;
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

        if (normWarnings) {
          warnings.push(...normWarnings);
        }

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

export function regReplace(pi: ExtensionAPI): void {
  pi.registerTool(buildToolDef({ flat: false }));
}
