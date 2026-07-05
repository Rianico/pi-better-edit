import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "fs/promises";
import { join, isAbsolute } from "path";
import { initHasher } from "./src/hashline";
import { regReplace } from "./src/replace";
import { regRead, fmtReadPreview } from "./src/read";
import { toLF, stripBOM } from "./src/replace-diff";
import { visLines } from "./src/utils";
import { AUTO_READ_MAX } from "./src/constants";

export default function (pi: ExtensionAPI): void {
  regRead(pi);
  regReplace(pi);

  const debugValue = process.env.PI_HASHLINE_DEBUG;

  pi.on("session_start", async (_event, ctx) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "edit"));
    await initHasher();
    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify("Hashline Edit mode active", "info");
    }
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
      const { text: rawContent } = stripBOM(content);
      const normalized = toLF(rawContent);

      if (visLines(normalized).length === 0) return;

      const preview = fmtReadPreview(normalized, { limit: AUTO_READ_MAX });
      if (!preview.text) return;

      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}` },
        ],
      };
    } catch (error) {
      console.error("Auto-read after write failed:", error);
    }
  });

}
