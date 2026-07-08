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
import { normReq } from "./replace-normalize";
import { isRec } from "./utils";
import { MAX_HASH_LINES } from "./constants";
import { resolveTarget, writeAtomic } from "./fs-write";
import {
  applyEdits,
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
import { execPipeline, compPreview, type ReplaceDetails } from "./replace";
import { readAutoReadSync } from "./config";

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

/**
 * Flat-mode schema: hash_range_inclusive and content_lines are at the top
 * level instead of inside a "changes" array. Only a single edit is supported
 * per call (no bulk changes).
 */
export const flatEditToolSchema = Type.Object(
  {
    path: Type.String({ description: "path" }),
    hash_range_inclusive: hashRangeInclSchema,
    content_lines: contentLinesSchema,
  },
  { additionalProperties: false },
);

type ToolDef = ToolDefinition<
  typeof flatEditToolSchema,
  ReplaceDetails,
  RRState
> & { renderShell?: "default" | "self" };

function reuseText(context: any, content: string): Text {
  const t = context.lastComponent instanceof Text
    ? context.lastComponent
    : new Text("", 0, 0);
  t.setText(content);
  return t;
}

function reuseMarkdown(context: any, content: string, theme: any): Markdown {
  const m = context.lastComponent instanceof Markdown
    ? context.lastComponent
    : new Markdown("", 0, 0, mkMdTheme(theme));
  m.setText(content);
  return m;
}

export function buildToolDef(): ToolDef {
  const autoRead = readAutoReadSync();
  const readGuidance = autoRead
    ? "Anchors are provided automatically after write operations when auto-read is enabled."
    : "Call `read` to get fresh anchors for follow-up edits.";

  const E_DESC = loadP("../prompts/replace-flat.md", {
    AUTO_READ_GUIDANCE: readGuidance,
  });
  const E_SNIPPET = loadP("../prompts/replace-flat-snippet.md");
  const E_GUIDE = loadGuide("../prompts/replace-flat-guidelines.md", {
    AUTO_READ_GUIDANCE: readGuidance,
  });

  return {
    name: "replace",
    label: "Replace",
    description: E_DESC,
    parameters: flatEditToolSchema,
    promptSnippet: E_SNIPPET,
    promptGuidelines: E_GUIDE,
    prepareArguments: (args: unknown) => {
      // Minimal normalization: file_path → path, JSON string parsing.
      // The flat-to-canonical conversion happens in execute().
      if (!isRec(args)) return args as any;
      const record = { ...args };
      if (typeof record.path !== "string" && typeof record.file_path === "string") {
        record.path = record.file_path;
        delete record.file_path;
      }
      if (typeof record.hash_range_inclusive === "string") {
        try { record.hash_range_inclusive = JSON.parse(record.hash_range_inclusive as string); } catch { /* keep as-is */ }
      }
      if (typeof record.content_lines === "string") {
        try { record.content_lines = JSON.parse(record.content_lines as string); } catch { /* keep as-is */ }
      }
      return record as any;
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
      // Wrap flat params into canonical shape for the pipeline
      const canonical = normReq({
        path: params.path,
        changes: [{
          hash_range_inclusive: params.hash_range_inclusive,
          content_lines: params.content_lines,
        }],
      });
      const normalizedParams = canonical as { path: string; changes: HTEdit[] };
      const path = normalizedParams.path;
      const absolutePath = toCwd(path, ctx.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);
      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(signal);

        const {
          originalNormalized,
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

        const editsAttempted = 1; // flat mode: exactly one edit per call

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

export function regReplaceFlat(pi: ExtensionAPI): void {
  pi.registerTool(buildToolDef());
}
