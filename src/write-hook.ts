/**
 * SAFETY: Guard + auto-read seam around `write`: the `tool_call` listener refuses
 * reproduced served rows before they can reach disk.
 * Ported from dsh@0.4.1 `src/write-hook.ts` adapted to pi's FileIO/session view.
 * @module pi-better-edit/write-hook
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HASH_SEP } from "./hashline/hash-identity.js";
import { abortIf, splitLines } from "./utils.js";
import { resolveTarget } from "./fs-write.js";
import { toCwd } from "./paths.js";
import { createSessionHandle, sessionKeyFor } from "./served-session/session.js";
import {
  findServedHashEcho,
  buildServedWriteMessage,
  trackServedWriteRefusal,
  type ServedHashEchoMatch,
} from "./hashline/served-guard.js";

void HASH_SEP;

export interface ServedHashEcho {
  /** SAFETY: One-based candidate line carrying the reproduced served row. */
  line: number;
  /** SAFETY: The exact anchor served for this session, path, and served line. */
  hash: string;
  /** SAFETY: 1-based served position whose content the candidate reproduces. */
  servedLine: number;
}

export { findServedHashEcho, type ServedHashEchoMatch };

export interface WriteHookIO {
  resolve(path: string, cwd: string, signal?: AbortSignal): Promise<string>;
}

/**
 * SAFETY: Inspect one validated-looking built-in write request against session-scoped
 * served state. Returns a pre-dispatch denial reason only with evidence: the
 * candidate begins with a served anchor at any position AND reproduces the
 * served content for that anchor (CONTEXT.md served hash echo). No canon data
 * means no evidence, so the check stays silent — never a shape refusal.
 */
export async function servedHashEchoDenial(
  io: WriteHookIO | null | undefined,
  rawPath: string,
  content: string,
  cwd: string,
  sessionKey: string,
  signal?: AbortSignal,
  mode: "general" | "literal" = "general",
): Promise<string | undefined> {
  abortIf(signal);
  if (mode === "literal") return undefined;
  let absolutePath: string;
  if (io && typeof (io as WriteHookIO).resolve === "function") {
    absolutePath = await (io as WriteHookIO).resolve(rawPath, cwd, signal);
  } else {
    absolutePath = await resolveTarget(toCwd(rawPath, cwd));
  }
  abortIf(signal);
  const handle = createSessionHandle(sessionKey, absolutePath);
  const served = await handle.load();
  let canons: (string | null)[] = [];
  try {
    canons = await handle.loadCanons();
  } catch (error) {
    console.error("Failed to load served canons for write:", error);
    canons = [];
  }
  const lines = splitLines(content);
  const reproduction = findServedHashEcho(lines, served, canons, 1);
  if (!reproduction) return undefined;
  const offendingLine = lines[reproduction.k - 1] ?? "";
  const count = trackServedWriteRefusal(absolutePath, offendingLine);
  return buildServedWriteMessage({
    path: rawPath,
    line: reproduction.line,
    hash: reproduction.hash,
    servedLine: reproduction.servedLine,
    count,
  });
}

/**
 * SAFETY: Register the pre-write served hash echo guard on the calling extension's scope.
 * The guard denies before dispatch; infrastructure failures fail open so the
 * plugin never breaks an otherwise valid write.
 */
export function registerWriteHook(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return;
    const input = event.input as Record<string, unknown> | undefined;
    const rawPath = (input?.path ?? input?.file_path) as unknown;
    const content = input?.content as unknown;
    if (typeof rawPath !== "string" || typeof content !== "string") return;
    // WHY: pi's builtin `write` schema tolerates the extra top-level `mode` field
    // WHY: (verified with TypeBox `Compile`: an additional `mode?: "general" | "literal"`
    // WHY: property passes `additionalProperties` handling on the builtin schema, so the
    // WHY: literal declaration rides the same input object with no schema change).
    const modeValue = (input as Record<string, unknown>)?.mode;
    const mode: "general" | "literal" = modeValue === "literal" ? "literal" : "general";

    const cwd = ctx.cwd;
    // SAFETY: ExtensionAPI ctx carries sessionManager at runtime; cast narrows to sessionKeyFor's expected shape which is validated by sessionKeyFor's internal guards.
    const sessionKey = sessionKeyFor(
      ctx as unknown as { sessionManager?: { getSessionId(): string } },
    );
    const signal = ctx.signal;
    try {
      const io: WriteHookIO = {
        resolve: async (p: string, c: string, sig?: AbortSignal) => {
          abortIf(sig);
          return resolveTarget(toCwd(p, c));
        },
      };
      const reason = await servedHashEchoDenial(
        io,
        rawPath,
        content,
        cwd,
        sessionKey,
        signal,
        mode,
      );
      if (reason !== undefined) {
        return { block: true, reason };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error(
        `pi-better-edit: pre-write served hash guard failed open: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  });
}
