import { readFile } from "fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadHashStore, upsertSnapshot } from "./hash-store";
import { contentChecksum } from "./hashline/hasher";
import { resolveTarget, writeAtomic } from "./fs-write";
import { toCwd } from "./paths";
import { toLF, stripBOM, genDiff, restoreEndings } from "./replace-diff";
import { cntDiff } from "./utils";
import { loadP, loadGuide } from "./prompts";
export interface UndoEntry {
  content: string;
  bom: string;
  originalEnding: "\r\n" | "\n";
  hashes: string[];
}

const undoMap = new Map<string, UndoEntry>();

export function saveUndo(path: string, entry: UndoEntry): void {
  undoMap.set(path, entry);
}

export function getUndo(path: string): UndoEntry | undefined {
  return undoMap.get(path);
}

export function clearUndo(path: string): void {
  undoMap.delete(path);
}


export function regReplaceUndo(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "undo_last_replace",
    label: "Undo Last Replace",
    description: loadP("../prompts/undo-last-replace.md"),
    promptSnippet: loadP("../prompts/undo-last-replace-snippet.md"),
    promptGuidelines: loadGuide("../prompts/undo-last-replace-guidelines.md"),
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to undo the last replace on",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = params.path;
      const absolutePath = toCwd(path, ctx.cwd);
      const mutationTargetPath = await resolveTarget(absolutePath);

      const undo = getUndo(mutationTargetPath);
      if (!undo) {
        return {
          content: [
            {
              type: "text",
              text: `No undo history for ${path}. There is no previous replace to revert.`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      return withFileMutationQueue(mutationTargetPath, async () => {
        let currentNormalized = "";
        try {
          const currentRaw = await readFile(mutationTargetPath, "utf-8");
          const { text: currentStripped } = stripBOM(currentRaw);
          currentNormalized = toLF(currentStripped);
        } catch {
          currentNormalized = "";
        }

        const diffResult = genDiff(undo.content, currentNormalized, 0);
        const linesAddedByReplace = cntDiff(diffResult.diff, "+");
        const linesRemovedByReplace = cntDiff(diffResult.diff, "-");

        await writeAtomic(
          mutationTargetPath,
          undo.bom + restoreEndings(undo.content, undo.originalEnding),
        );

        const store = await loadHashStore();
        upsertSnapshot(store, mutationTargetPath, contentChecksum(undo.content), undo.content.split("\n").length, undo.hashes);

        clearUndo(mutationTargetPath);

        const parts: string[] = [
          `Undone last replace on ${path}.`,
        ];
        if (linesAddedByReplace > 0 || linesRemovedByReplace > 0) {
          parts.push(
            `Removed ${linesAddedByReplace} line(s) that were added and restored ${linesRemovedByReplace} line(s) that were removed.`,
          );
        }
        parts.push(
          "File reverted to previous state. Call `read` to get fresh anchors for follow-up edits.",
        );

        return {
          content: [
            {
              type: "text",
              text: parts.join("\n"),
            },
          ],
          details: {
            metrics: {
              added_lines: linesRemovedByReplace,
              removed_lines: linesAddedByReplace,
              classification: "applied" as const,
            },
          },
        };
      });
    },
  });
}
