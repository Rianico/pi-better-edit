import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline";
import { regReplace } from "./src/replace";
import { regReplaceUndo, clearUndo } from "./src/replace-undo";
import { regRead, fmtReadPreview } from "./src/read";
import type { RMetrics } from "./src/replace-response";
import { extractWarnings } from "./src/replace-render";
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
    regReplace(pi, { autoRead });
    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify(`Hashline Edit mode active`, "info");
    }
  });

  pi.registerCommand("toggle-auto-read", {
    description: "Toggle automatic hashline anchors after write and post-edit diffs after replace and undo_last_replace operations",
    handler: async (_args, ctx) => {
      autoRead = await toggleAutoRead();
      regReplace(pi, { autoRead });
      const state = autoRead ? "enabled" : "disabled";
      ctx.ui.notify(`Auto-read anchors (write) and post-edit diffs (replace/undo): ${state}`, "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    if (event.toolName === "write") {
      const writtenPath = (event.input as Record<string, unknown>)?.path;
      if (typeof writtenPath === "string") {
        try {
          await clearUndo(await resolveTarget(toCwd(writtenPath, ctx.cwd)));
        } catch (error) {
          console.error("Failed to clear undo after write:", error);
        }
      }
      if (!autoRead) return;
      if (typeof writtenPath !== "string") return;
      try {
        const { normalized, fileHashes, absolutePath } = await readNormFile(
          writtenPath, ctx.cwd, { maxLines: MAX_HASH_LINES },
        );
        const preview = await fmtReadPreview(
          normalized,
          {},
          fileHashes,
          absolutePath,
          DEFAULT_MAX_BYTES,
        );
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}` },
          ],
        };
      } catch (error) {
        console.error("Auto-read after write failed:", error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read failed: ${message} ---` },
          ],
        };
      }
    }

    if (
      event.toolName !== "replace" &&
      event.toolName !== "undo_last_replace"
    ) return;
    if (!autoRead) return;

    const metrics = (event.details as { metrics?: RMetrics } | undefined)?.metrics;
    if (metrics?.classification === "noop") return;

    const diff = (event.details as { diff?: string } | undefined)?.diff;
    if (!diff) return;

    const rendered = (event.content ?? [])
      .filter(
        (entry): entry is { type: "text"; text: string } =>
          entry.type === "text" && typeof entry.text === "string",
      )
      .map((entry) => entry.text)
      .join("\n");
    const warnings = extractWarnings(rendered);
    return {
      content: [
        {
          type: "text",
          text: warnings ? `${diff}\n\n${warnings}` : diff,
        },
      ],
    };
  });
}
