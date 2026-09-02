/**
 * Guard + auto-read seam around `write`: the `tool_call` listener rejects
 * copied hashline preview rows before they can reach disk.
 * Ported from dsh@0.4.1 `src/write-hook.ts` adapted to pi's FileIO/session view.
 * @module pi-better-edit/write-hook
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HASH_SEP } from "./hashline/hash-identity.js";
import { abortIf, splitLines } from "./utils.js";
import { resolveTarget } from "./fs-write.js";
import { toCwd } from "./paths.js";
import { createSessionHandle, sessionKeyFor } from "./served-session/session.js";

export interface ServedHashEcho {
	/** One-based candidate line carrying the copied anchor. */
	line: number;
	/** The exact anchor served for this session, path, and line. */
	hash: string;
}

export interface WriteHookIO {
	resolve(path: string, cwd: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Find a copied hashline prefix without treating arbitrary `3-char│` text as
 * metadata. A match requires the exact hash currently recorded at the same
 * line position for this session and canonical path.
 */
export function findServedHashEcho(
	content: string,
	served: readonly (string | null)[],
): ServedHashEcho | undefined {
	const lines = splitLines(content);
	const compared = Math.min(lines.length, served.length);
	for (let index = 0; index < compared; index += 1) {
		const hash = served[index];
		if (hash !== null && lines[index]!.startsWith(`${hash}${HASH_SEP}`)) {
			return { line: index + 1, hash };
		}
	}
	return undefined;
}

/**
 * Inspect one validated-looking built-in write request against session-scoped
 * served state. Returns a pre-dispatch denial reason only for an exact
 * same-session / same-canonical-path / same-line anchor echo.
 */
export async function servedHashEchoDenial(
	io: WriteHookIO | null | undefined,
	rawPath: string,
	content: string,
	cwd: string,
	sessionKey: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	abortIf(signal);
	let absolutePath: string;
	if (io && typeof (io as WriteHookIO).resolve === "function") {
		absolutePath = await (io as WriteHookIO).resolve(rawPath, cwd, signal);
	} else {
		absolutePath = await resolveTarget(toCwd(rawPath, cwd));
	}
	abortIf(signal);
	const handle = createSessionHandle(sessionKey, absolutePath);
	const served = await handle.load();
	const match = findServedHashEcho(content, served);
	if (!match) return undefined;
	return (
		`[E_WRITE_HASH_ECHO] Refused write to ${rawPath}: line ${match.line} begins with ` +
		`the exact ${match.hash}${HASH_SEP} anchor served for this session, path, and line. ` +
		`HASH${HASH_SEP} anchors are tool output, not file content. ` +
		"Retry with file content only (remove the entire copied anchor chain). Nothing was written."
	);
}

/**
 * Register the pre-write echo guard on the calling extension's scope.
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

		const cwd = ctx.cwd;
		// SAFETY: ExtensionAPI ctx carries sessionManager at runtime; cast narrows to sessionKeyFor's expected shape which is validated by sessionKeyFor's internal guards.
		const sessionKey = sessionKeyFor(ctx as unknown as { sessionManager?: { getSessionId(): string } });
		const signal = ctx.signal;
		try {
			const io: WriteHookIO = {
				resolve: async (p: string, c: string, sig?: AbortSignal) => {
					abortIf(sig);
					return resolveTarget(toCwd(p, c));
				},
			};
			const reason = await servedHashEchoDenial(io, rawPath, content, cwd, sessionKey, signal);
			if (reason !== undefined) {
				return { block: true, reason };
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			console.error(
				`pi-better-edit: pre-write hash-echo guard failed open: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return;
	});
}
