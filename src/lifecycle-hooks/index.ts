import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initHasher as defaultInitHasher } from "../hashline/index.js";
import { pruneMissingAll as defaultPruneMissingAll } from "../snapshot-store.js";
import { clearUndo as defaultClearUndo } from "../edit-undo.js";
import { createSessionHandle, sessionKeyFor as defaultSessionKeyFor } from "../served-session/session.js";

async function defaultRecordDiffServes(input: { sessionKey: string; path: string; servedRows: import("../hashline/served.js").ServedRow[]; resultLineCount?: number; firstChangedLine?: number }): Promise<void> {
  await createSessionHandle(input.sessionKey, input.path).recordDiff(input.servedRows, { resultLineCount: input.resultLineCount, firstChangedLine: input.firstChangedLine });
}
import { readNormFile as defaultReadNormFile } from "../file-reader.js";
import { loadFileKindAndText as defaultLoadFileKindAndText } from "../file-kind.js";
import { toCwd as defaultToCwd } from "../paths.js";
import { resolveTarget as defaultResolveTarget } from "../fs-write.js";
import { valAccess as defaultValAccess } from "../validation.js";
import { visLines as defaultVisLines } from "../utils.js";
import { fmtReadPreview as defaultFmtReadPreview } from "../read.js";
import { finalizeToolResult as defaultFinalizeToolResult } from "../edit-response.js";
import { MAX_HASH_LINES } from "../hashline/index.js";
import { AUTO_READ_MAX } from "../constants.js";
import type { LifecycleDeps, ToolContext, ToolResultEvent } from "./types.js";

export type { ToolContext, ToolResultEvent, LifecycleDeps } from "./types.js";

function defaultDeps(): LifecycleDeps {
  return {
    initHasher: defaultInitHasher,
    pruneMissingAll: defaultPruneMissingAll,
    clearUndo: defaultClearUndo,
    resolveTarget: defaultResolveTarget,
    toCwd: defaultToCwd,
    valAccess: defaultValAccess,
    loadFileKindAndText: defaultLoadFileKindAndText,
    readNormFile: defaultReadNormFile,
    fmtReadPreview: defaultFmtReadPreview,
    recordDiffServes: defaultRecordDiffServes,
    sessionKeyFor: defaultSessionKeyFor,
    finalizeToolResult: defaultFinalizeToolResult,
    visLines: defaultVisLines,
  };
}

export function createLifecycleHooks(overrides: Partial<LifecycleDeps> = {}): {
  onSessionStart: (event: unknown, ctx: ToolContext) => Promise<void>;
  onToolResult: (
    event: ToolResultEvent,
    ctx: ToolContext,
  ) => Promise<{ content: Array<{ type: string; text: string }> } | undefined>;
  onWrite: (
    event: ToolResultEvent,
    ctx: ToolContext,
  ) => Promise<{ content: Array<{ type: string; text: string }> } | undefined>;
  onEdit: (
    event: ToolResultEvent,
    ctx: ToolContext,
  ) => Promise<{ content: Array<{ type: string; text: string }> } | undefined>;
} {
  const deps: LifecycleDeps = { ...defaultDeps(), ...overrides };

  async function recordServesBestEffort(input: {
    sessionKey: string;
    path: string;
    servedRows: import("../hashline/served.js").ServedRow[];
    resultLineCount?: number;
    firstChangedLine?: number;
  }): Promise<void> {
    if (input.servedRows.length === 0) return;
    try {
      await deps.recordDiffServes(input);
    } catch (error) {
      // SAFETY: best-effort serve recording — failures are ignored; file edit already succeeded and next read will re-establish serves, no data loss.
      console.error("Failed to record served rows:", error);
    }
  }

  async function handleSessionStart(
    _event: unknown,
    ctx: ToolContext,
  ): Promise<void> {
    await deps.initHasher();
    try {
      await deps.pruneMissingAll();
    } catch (err) {
      // SAFETY: best-effort startup cleanup — pruneMissingAll failures are ignored; hash store remains usable and stale entries will be retried next startup, no user data loss.
      console.error("Failed to load or prune hash store:", err);
    }
    const debugValue = process.env.PI_HASHLINE_DEBUG;
    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify("Hashline Edit mode active", "info");
    }
  }

  async function handleWrite(
    event: ToolResultEvent,
    ctx: ToolContext,
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    const rawInput = event.input as Record<string, unknown> | undefined;
    const writtenPath = rawInput?.path ?? rawInput?.file_path;
    if (typeof writtenPath === "string") {
      try {
        await deps.clearUndo(
          await deps.resolveTarget(deps.toCwd(writtenPath, ctx.cwd)),
        );
      } catch (error) {
        // SAFETY: best-effort undo cleanup after write — clearUndo failures are ignored; stale undo history will be overwritten on next edit or pruned, no data loss.
        console.error("Failed to clear undo after write:", error);
      }
    }
    if (typeof writtenPath !== "string") return undefined;
    try {
      const resolvedPath = await deps.resolveTarget(
        deps.toCwd(writtenPath, ctx.cwd),
      );
      await deps.valAccess(resolvedPath, writtenPath);
      const file = await deps.loadFileKindAndText(resolvedPath, {
        maxLines: MAX_HASH_LINES,
        displayPath: writtenPath,
      });
      if (file.kind !== "text") return undefined;
      const { normalized, fileHashes, absolutePath } = await deps.readNormFile(
        writtenPath,
        ctx.cwd,
        {
          maxLines: MAX_HASH_LINES,
          preloadedFile: file,
        },
      );
      const preview = await deps.fmtReadPreview(
        normalized,
        {},
        fileHashes,
        absolutePath,
        DEFAULT_MAX_BYTES,
        AUTO_READ_MAX,
      );
      await recordServesBestEffort({
        sessionKey: deps.sessionKeyFor(ctx),
        path: absolutePath,
        servedRows: fileHashes.map((hash, position) => ({ position, hash })),
        resultLineCount: deps.visLines(normalized).length,
        firstChangedLine: 1,
      });
      return {
        content: [
          ...(event.content ?? []),
          {
            type: "text",
            text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}`,
          },
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

  async function handleEdit(
    event: ToolResultEvent,
    ctx: ToolContext,
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    if (event.toolName !== "edit" && event.toolName !== "undo_last_edit")
      return undefined;
    const details = event.details as
      | import("../edit-response.js").EditDetails
      | undefined;
    if (details?.metrics?.classification === "noop") return undefined;
    if (!details?.diff) return undefined;

    const { content, servedRows } = deps.finalizeToolResult(details);
    if (details.servedByPath && details.servedByPath.length > 0) {
      for (const entry of details.servedByPath) {
        if (entry.servedRows.length === 0) continue;
        const resolvedPath = await deps.resolveTarget(
          deps.toCwd(entry.path, ctx.cwd),
        );
        await recordServesBestEffort({
          sessionKey: deps.sessionKeyFor(ctx),
          path: resolvedPath,
          servedRows: entry.servedRows,
          resultLineCount: entry.resultLineCount,
          firstChangedLine: entry.firstChangedLine,
        });
      }
    } else if (servedRows && servedRows.length > 0) {
      const rawPath = (event.input as Record<string, unknown> | undefined)
        ?.path;
      if (typeof rawPath === "string") {
        const resolvedPath = await deps.resolveTarget(
          deps.toCwd(rawPath, ctx.cwd),
        );
        await recordServesBestEffort({
          sessionKey: deps.sessionKeyFor(ctx),
          path: resolvedPath,
          servedRows,
          resultLineCount: details.resultLineCount,
          firstChangedLine: details.firstChangedLine,
        });
      }
    }
    return { content };
  }

  async function handleToolResult(
    event: ToolResultEvent,
    ctx: ToolContext,
  ): Promise<{ content: Array<{ type: string; text: string }> } | undefined> {
    if (event.isError) return undefined;
    if (event.toolName === "write") {
      return handleWrite(event, ctx);
    }
    if (event.toolName === "edit" || event.toolName === "undo_last_edit") {
      return handleEdit(event, ctx);
    }
    return undefined;
  }

  return {
    onSessionStart: handleSessionStart,
    onToolResult: handleToolResult,
    onWrite: handleWrite,
    onEdit: handleEdit,
  };
}

export function registerLifecycleHooks(
  pi: ExtensionAPI,
  overrides: Partial<LifecycleDeps> = {},
): ReturnType<typeof createLifecycleHooks> {
  const hooks = createLifecycleHooks(overrides);
  // SAFETY: ExtensionAPI on() typed for known events — string-key widening validated by lifecycle hook contract
  (pi as unknown as { on: (e: string, h: unknown) => void }).on(
    // SAFETY: string-key widening for session_start
    "session_start",
    // SAFETY: onSessionStart handler tuple overload — cast to never validated by handleSessionStart signature
    hooks.onSessionStart as unknown as never,
  );
  // SAFETY: ExtensionAPI on() typed for known events — string-key widening for tool_result delegation
  (pi as unknown as { on: (e: string, h: unknown) => void }).on(
    "tool_result",
    // SAFETY: onToolResult handler tuple overload — cast to never validated by handleToolResult signature
    hooks.onToolResult as unknown as never,
  );
  return hooks;
}
