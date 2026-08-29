import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline/index.js";
import { regEdit } from "./src/edit.js";
import { regEditUndo, clearUndo } from "./src/edit-undo.js";
import { regRead } from "./src/read.js";
import { regReadSkill } from "./src/read-skill.js";
import { finalizeToolResult, type EditDetails } from "./src/edit-response.js";
import { pruneMissingAll } from "./src/snapshot-store.js";
import { sessionFromContext } from "./src/served-session/index.js";
import { registerWriteHook } from "./src/write-hook.js";
import { prepareFile } from "./src/file-content/index.js";
import { visLines } from "./src/utils.js";
import { toCwd } from "./src/paths.js";
import { resolveTarget } from "./src/fs-write.js";

export default function (pi: ExtensionAPI): void {
	regRead(pi);
	regReadSkill(pi);

	regEdit(pi);
	regEditUndo(pi);
	registerWriteHook(pi);

	pi.on("session_start", async (_event, ctx) => {
		await initHasher();
		try {
			await pruneMissingAll();
		} catch (err) {
			// SAFETY: best-effort startup cleanup — pruneMissingAll failures are ignored; hash store remains usable and stale entries will be retried next startup, no user data loss.
			console.error("Failed to load or prune hash store:", err);
		}
		const debugValue = process.env.PI_HASHLINE_DEBUG;
		if (debugValue === "1" || debugValue === "true") {
			ctx.ui.notify(`Hashline Edit mode active`, "info");
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		if (event.toolName === "write") {
			const writtenPath = (event.input as Record<string, unknown>)?.path;
			if (typeof writtenPath === "string") {
				try {
					await clearUndo(await resolveTarget(toCwd(writtenPath, ctx.cwd)));
				} catch (error) {
					// SAFETY: best-effort undo cleanup after write — clearUndo failures are ignored; stale undo history will be overwritten on next edit or pruned, no data loss.
					console.error("Failed to clear undo after write:", error);
				}
			}
			if (typeof writtenPath !== "string") return;
			try {
				const prepared = await prepareFile(writtenPath, ctx.cwd, {});
				if (prepared.kind !== "text") return;
				const session = sessionFromContext(
					ctx as { sessionManager?: { getSessionId(): string } },
					prepared.absolutePath,
				);
				await session.recordDiff(prepared.served, {
					resultLineCount: visLines(prepared.normalized).length,
				});
				return {
					content: [
						...(event.content ?? []),
						{
							type: "text",
							text: `\n\n--- Auto-read (hashline anchors) ---\n${prepared.preview}`,
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

		if (event.toolName !== "edit" && event.toolName !== "undo_last_edit") return;

		const details = event.details as EditDetails | undefined;
		if (details?.metrics?.classification === "noop") return;
		if (!details?.diff) return;

		const { content, servedRows } = finalizeToolResult(details);
		if (details.servedByPath && details.servedByPath.length > 0) {
			for (const entry of details.servedByPath) {
				if (entry.servedRows.length === 0) continue;
				try {
					const resolvedPath = await resolveTarget(toCwd(entry.path, ctx.cwd));
					const session = sessionFromContext(
						ctx as { sessionManager?: { getSessionId(): string } },
						resolvedPath,
					);
					await session.recordDiff(entry.servedRows, {
						resultLineCount: entry.resultLineCount,
						firstChangedLine: entry.firstChangedLine,
					});
				} catch (error) {
					// SAFETY: best-effort serve recording after edit — failures are ignored; file edit already succeeded and next read will re-establish serves, no data loss.
					console.error("Failed to record served rows from edit diff:", error);
				}
			}
		} else if (servedRows && servedRows.length > 0) {
			try {
				const rawPath = (event.input as Record<string, unknown> | undefined)?.path;
				if (typeof rawPath === "string") {
					const resolvedPath = await resolveTarget(toCwd(rawPath, ctx.cwd));
					const session = sessionFromContext(
						ctx as { sessionManager?: { getSessionId(): string } },
						resolvedPath,
					);
					await session.recordDiff(servedRows, {
						resultLineCount: details.resultLineCount,
						firstChangedLine: details.firstChangedLine,
					});
				}
			} catch (error) {
				// SAFETY: best-effort serve recording after edit — failures are ignored; file edit already succeeded and next read will re-establish serves, no data loss.
				console.error("Failed to record served rows from post-edit diff:", error);
			}
		}

		return { content };
	});
}
