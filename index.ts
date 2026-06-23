import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "fs/promises";
import { join, isAbsolute } from "path";
import { lineHashes, initHasher, fmtRegion } from "./src/hashline";
import { regReplace } from "./src/replace";
import { regRead } from "./src/read";
import { toLF } from "./src/replace-diff";
import { visLines } from "./src/utils";
import { AUTO_READ_MAX } from "./src/constants";

export default function (pi: ExtensionAPI): void {
  regRead(pi);
  regReplace(pi);

  pi.on("session_start", async (_event, ctx) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "edit"));
    await initHasher();
  });

  const autoReadValue = process.env.PI_HASHLINE_AUTO_READ;
  let autoRead = autoReadValue === "1" || autoReadValue === "true";

  pi.registerCommand("toggle-auto-read", {
    description: "Toggle automatic hashline anchors after write operations",
    handler: async (_args, ctx) => {
      autoRead = !autoRead;
      const state = autoRead ? "enabled" : "disabled";
      ctx.ui.notify(`Auto-read after write: ${state}`, "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!autoRead) return;
    if (event.toolName !== "write" || event.isError) return;

    const filePath = (event.input as Record<string, unknown>)?.path;
    if (typeof filePath !== "string") return;

    try {
      const absolutePath = isAbsolute(filePath) ? filePath : join(ctx.cwd, filePath);
      const content = await readFile(absolutePath, "utf-8");

      const normalized = toLF(content);
      const visibleLines = visLines(normalized);

      if (visibleLines.length === 0) return;

      const truncated = visibleLines.length > AUTO_READ_MAX;
      const displayLines = truncated ? visibleLines.slice(0, AUTO_READ_MAX) : visibleLines;

      const hashes = lineHashes(normalized);
      const selectedHashes = hashes.slice(0, displayLines.length);
      const hashlineOutput = fmtRegion(selectedHashes, displayLines);

      const paginationHint = truncated
        ? `\n\n[Showing lines 1-${AUTO_READ_MAX} of ${visibleLines.length}. Use offset=${AUTO_READ_MAX + 1} to continue.]`
        : "";

      if (hashlineOutput) {
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${hashlineOutput}${paginationHint}` },
          ],
        };
      }
    } catch {
    }
  });

  const debugValue = process.env.PI_HASHLINE_DEBUG;
  if (debugValue === "1" || debugValue === "true") {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Hashline Edit mode active", "info");
    });
  }
}
