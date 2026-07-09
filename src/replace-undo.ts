import { readFile } from "fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getUndo, clearUndo } from "./undo-store";
import { loadHashStore, saveHashStore } from "./hash-store";
import { resolveTarget, writeAtomic } from "./fs-write";
import { toCwd } from "./path-utils";
import { toLF, stripBOM, genDiff, restoreEndings } from "./replace-diff";
import { cntDiff } from "./utils";


export function regReplaceUndo(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "last_replace_undo",
    label: "Undo Last Replace",
    description:
      "Undo the last replace operation on a file, reverting it to its previous state. " +
      "Use this when a replace produced incorrect results (e.g., wrong content, duplicated lines, broken syntax). " +
      "After undoing, call `read` to get fresh anchors for a corrected replace.",
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
        store.snapshots[mutationTargetPath] = {
          content: undo.content,
          hashes: undo.hashes,
        };
        await saveHashStore(store);

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
