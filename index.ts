import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "fs/promises";
import { join, isAbsolute } from "path";
import { computeLineHashes, formatHashlineRegion } from "./src/hashline";
import { registerReplaceTool } from "./src/replace";
import { registerReadTool } from "./src/read";
import { normalizeToLF } from "./src/replace-diff";
import { getVisibleLines } from "./src/utils";
import { AUTO_READ_MAX_LINES } from "./src/constants";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerReplaceTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "edit"));
  });

  const autoReadValue = process.env.PI_HASHLINE_AUTO_READ;
  let autoReadEnabled = autoReadValue === "1" || autoReadValue === "true";

  pi.registerCommand("toggle-auto-read", {
    description: "Toggle automatic hashline anchors after write operations",
    handler: async (_args, ctx) => {
      autoReadEnabled = !autoReadEnabled;
      const state = autoReadEnabled ? "enabled" : "disabled";
      ctx.ui.notify(`Auto-read after write: ${state}`, "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!autoReadEnabled) return;
    if (event.toolName !== "write" || event.isError) return;

    const filePath = (event.input as Record<string, unknown>)?.path;
    if (typeof filePath !== "string") return;

    try {
      const absolutePath = isAbsolute(filePath) ? filePath : join(ctx.cwd, filePath);
      const content = await readFile(absolutePath, "utf-8");

      const normalized = normalizeToLF(content);
      const visibleLines = getVisibleLines(normalized);

      if (visibleLines.length === 0) return;

      const truncated = visibleLines.length > AUTO_READ_MAX_LINES;
      const displayLines = truncated ? visibleLines.slice(0, AUTO_READ_MAX_LINES) : visibleLines;

      const hashes = computeLineHashes(normalized);
      const selectedHashes = hashes.slice(0, displayLines.length);
      const hashlineOutput = formatHashlineRegion(selectedHashes, displayLines);

      const paginationHint = truncated
        ? `\n\n[Showing lines 1-${AUTO_READ_MAX_LINES} of ${visibleLines.length}. Use offset=${AUTO_READ_MAX_LINES + 1} to continue.]`
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