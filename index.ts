import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline";
import { regReplace } from "./src/replace";
import { regReplaceUndo, clearUndo } from "./src/replace-undo";
import { regRead, fmtReadPreview } from "./src/read";
import type { RMetrics } from "./src/replace-response";
import { AUTO_READ_MAX } from "./src/constants";
import { MAX_HASH_LINES } from "./src/hashline";
import {
  readConfig,
  toggleAutoRead,
} from "./src/config";
import { loadHashStore, pruneMissing } from "./src/hash-store";
import { readNormFile } from "./src/file-reader";
import { toCwd } from "./src/paths";
import { resolveTarget } from "./src/fs-write";

export default function (pi: ExtensionAPI): void {
  regRead(pi);

  regReplace(pi);
  regReplaceUndo(pi);

  const debugValue = process.env.PI_HASHLINE_DEBUG;
  let autoRead = true;

  pi.on("session_start", async (_event, ctx) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "edit"));
    await initHasher();
    try {
      const store = await loadHashStore();
      await pruneMissing(store);
    } catch (err) {
      console.error("Failed to load or prune hash store:", err);
    }
    const config = await readConfig();
    autoRead = config.autoRead;

    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify(`Hashline Edit mode active`, "info");
    }
  });

  pi.registerCommand("toggle-auto-read", {
    description: "Toggle automatic hashline anchors after write and replace operations",
    handler: async (_args, ctx) => {
      autoRead = await toggleAutoRead();
      const state = autoRead ? "enabled" : "disabled";
      ctx.ui.notify(`Auto-read after write/replace: ${state}`, "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName === "write") {
      const writtenPath = (event.input as Record<string, unknown>)?.path;
      if (typeof writtenPath === "string") {
        try {
          clearUndo(await resolveTarget(toCwd(writtenPath, ctx.cwd)));
        } catch (error) {
          console.error("Failed to clear undo after write:", error);
        }
      }
    }
    if (!autoRead) return;
    if (
      event.toolName !== "write" &&
      event.toolName !== "replace" &&
      event.toolName !== "undo_last_replace"
    ) return;
    const filePath = (event.input as Record<string, unknown>)?.path;
    if (typeof filePath !== "string") return;

    const metrics = (event.details as { metrics?: RMetrics } | undefined)?.metrics;
    if (event.toolName !== "write" && metrics?.classification === "noop") return;

    try {
      const { normalized, fileHashes, absolutePath } = await readNormFile(
        filePath, ctx.cwd, { maxLines: MAX_HASH_LINES },
      );

      const changedLines =
        event.toolName === "replace" || event.toolName === "undo_last_replace"
          ? metrics?.changed_lines
          : undefined;
      let offset: number | undefined;
      let limit = AUTO_READ_MAX;
      if (changedLines) {
        offset = Math.max(1, changedLines.first - 2);
        limit = Math.min(changedLines.last + 2 - offset + 1, AUTO_READ_MAX);
      }

      const preview = await fmtReadPreview(
        normalized,
        { offset, limit },
        fileHashes,
        absolutePath,
      );

      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}` },
        ],
      };
    } catch (error) {
      console.error("Auto-read after write/replace failed:", error);
    }
  });
}
