import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline";
import { regEdit } from "./src/edit";
import { regEditUndo, clearUndo } from "./src/edit-undo";
import { regRead, fmtReadPreview } from "./src/read";
import type { RMetrics } from "./src/edit-response";
import { extractWarnings } from "./src/edit-render";
import { MAX_HASH_LINES } from "./src/hashline";
import { AUTO_READ_MAX } from "./src/constants";
import { readConfig, toggleAutoRead } from "./src/config";
import {
	loadHashStore,
	pruneMissing,
} from "./src/hash-store";
import { recordServed, wipeServedState } from "./src/served-state";
import type { ServedRow } from "./src/hashline/served";
import { readNormFile } from "./src/file-reader";
import { loadFileKindAndText } from "./src/file-kind";
import { toCwd } from "./src/paths";
import { resolveTarget } from "./src/fs-write";
import { valAccess } from "./src/validation";

export default function (pi: ExtensionAPI): void {
	regRead(pi);

	regEdit(pi);
	regEditUndo(pi);

	let autoRead = true;

	pi.on("session_start", async (_event, ctx) => {
		await initHasher();
		try {
			const store = await loadHashStore();
			await wipeServedState();
			await pruneMissing(store);
		} catch (err) {
			console.error("Failed to load or prune hash store:", err);
		}
		const config = await readConfig();
		autoRead = config.autoRead;
		const debugValue = process.env.PI_HASHLINE_DEBUG;
		if (debugValue === "1" || debugValue === "true") {
			ctx.ui.notify(`Hashline Edit mode active`, "info");
		}
	});

	pi.registerCommand("toggle-auto-read", {
		description:
			"Toggle automatic hashline anchors after write and post-edit diffs after edit and undo_last_edit operations",
		handler: async (_args, ctx) => {
			autoRead = await toggleAutoRead();
			const state = autoRead ? "enabled" : "disabled";
			ctx.ui.notify(
				`Auto-read anchors (write) and post-edit diffs (edit/undo): ${state}`,
				"info",
			);
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
				await recordServed(absolutePath, preview.served);
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
		if (!autoRead) return;

		const metrics = (event.details as { metrics?: RMetrics } | undefined)
			?.metrics;
		if (metrics?.classification === "noop") return;

		const diff = (event.details as { diff?: string } | undefined)?.diff;
		if (!diff) return;

		const servedRows = (
			event.details as { servedRows?: ServedRow[] } | undefined
		)?.servedRows;
		if (servedRows && servedRows.length > 0) {
			try {
				const rawPath = (event.input as Record<string, unknown> | undefined)
					?.path;
				if (typeof rawPath === "string") {
					const resolvedPath = await resolveTarget(toCwd(rawPath, ctx.cwd));
					await recordServed(resolvedPath, servedRows);
				}
			} catch (error) {
				console.error(
					"Failed to record served rows from post-edit diff:",
					error,
				);
			}
		}

		const rendered = (event.content ?? [])
			.filter(
				(entry): entry is { type: "text"; text: string } =>
					entry.type === "text" && typeof entry.text === "string",
			)
			.map((entry) => entry.text)
			.join("\n");
		const driftNotice = (event.details as { driftNotice?: string } | undefined)
			?.driftNotice;
		const warnings = extractWarnings(rendered, driftNotice);
		const base = warnings ? `${diff}\n\n${warnings}` : diff;
		return {
			content: [
				{
					type: "text",
					text: driftNotice ? `${base}\n\n${driftNotice}` : base,
				},
			],
		};
	});
}
