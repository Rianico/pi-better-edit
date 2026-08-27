import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline";
import { regEdit } from "./src/edit";
import { regEditUndo, clearUndo } from "./src/edit-undo";
import { regRead, fmtReadPreview } from "./src/read";
import { regReadSkill } from "./src/read-skill";
import { finalizeToolResult, type EditDetails } from "./src/edit-response";
import { MAX_HASH_LINES } from "./src/hashline";
import { AUTO_READ_MAX } from "./src/constants";
import { pruneMissingAll } from "./src/snapshot-store";
import { recordDiffServes, sessionKeyFor } from "./src/served-state";
import { registerWriteHook } from "./src/write-hook";
import { readNormFile } from "./src/file-reader";
import { loadFileKindAndText } from "./src/file-kind";
import { toCwd } from "./src/paths";
import { resolveTarget } from "./src/fs-write";
import { valAccess } from "./src/validation";
import { visLines } from "./src/utils";

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
					console.error("Failed to clear undo after write:", error);
				}
			}
			if (typeof writtenPath !== "string") return;
			try {
				const resolvedPath = await resolveTarget(toCwd(writtenPath, ctx.cwd));
				await valAccess(resolvedPath, writtenPath);
				const file = await loadFileKindAndText(resolvedPath, {
					maxLines: MAX_HASH_LINES,
					displayPath: writtenPath,
				});
				if (file.kind !== "text") return;
				const { normalized, fileHashes, absolutePath } = await readNormFile(
					writtenPath,
					ctx.cwd,
					{ maxLines: MAX_HASH_LINES, preloadedFile: file },
				);
				const preview = await fmtReadPreview(
					normalized,
					{},
					fileHashes,
					absolutePath,
					DEFAULT_MAX_BYTES,
					AUTO_READ_MAX,
				);
				await recordDiffServes({
					sessionKey: sessionKeyFor(ctx),
					path: absolutePath,
					servedRows: preview.served,
					resultLineCount: visLines(normalized).length,
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

		if (event.toolName !== "edit" && event.toolName !== "undo_last_edit")
			return;

		const details = event.details as EditDetails | undefined;
		if (details?.metrics?.classification === "noop") return;
		if (!details?.diff) return;

		const { content, servedRows } = finalizeToolResult(details);
		if (details.servedByPath && details.servedByPath.length > 0) {
			for (const entry of details.servedByPath) {
				if (entry.servedRows.length === 0) continue;
				try {
					const resolvedPath = await resolveTarget(
						toCwd(entry.path, ctx.cwd),
					);
					await recordDiffServes({
						sessionKey: sessionKeyFor(ctx),
						path: resolvedPath,
						servedRows: entry.servedRows,
						resultLineCount: entry.resultLineCount,
						firstChangedLine: entry.firstChangedLine,
					});
				} catch (error) {
					console.error(
						"Failed to record served rows from edit diff:",
						error,
					);
				}
			}
		} else if (servedRows && servedRows.length > 0) {
			try {
				const rawPath = (
					event.input as Record<string, unknown> | undefined
				)?.path;
				if (typeof rawPath === "string") {
					const resolvedPath = await resolveTarget(
						toCwd(rawPath, ctx.cwd),
					);
					await recordDiffServes({
						sessionKey: sessionKeyFor(ctx),
						path: resolvedPath,
						servedRows,
						resultLineCount: details.resultLineCount,
						firstChangedLine: details.firstChangedLine,
					});
				}
			} catch (error) {
				console.error(
					"Failed to record served rows from post-edit diff:",
					error,
				);
			}
		}

		return { content };
	});
}
