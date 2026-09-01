import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readUndo, writeUndo, removeUndo, type UndoRecord } from "./undo-store.js";
import { upsertSnapshotFor } from "./snapshot-store.js";
import { contentChecksum } from "./hashline/hasher.js";
import { resolveTarget, writeAtomic } from "./fs-write.js";
import { toCwd } from "./paths.js";
import {
	toLF,
	stripBOM,
	genDiff,
	restoreEndings,
	type LineEnding,
} from "./edit-diff.js";
import {
	cntDiff,
	visLines,
	splitLines,
	errCode,
	isRec,
	normalizeFilePath,
} from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import { buildMetrics, type EditDetails } from "./edit-response.js";
import { changedRange, lineHashes } from "./hashline/index.js";
export interface UndoEntry {
	content: string;
	bom: string;
	originalEnding: LineEnding;
	hashes: string[];
	resultContent: string;
}

export async function saveUndo(
	path: string,
	entry: UndoEntry,
): Promise<{ persisted: boolean; restore: () => Promise<void> }> {
	let previous: UndoRecord | undefined;
	try {
		previous = await readUndo(path);
		await writeUndo(path, {
			content: entry.content,
			bom: entry.bom,
			ending: entry.originalEnding,
			hashes: entry.hashes,
			resultContent: entry.resultContent,
		});
	} catch (error) {
		// SAFETY: typed error handling — persist failure returns { persisted: false } and caller throws E_UNDO_UNAVAILABLE; logging preserves cause, not silent undefined, downstream handles rejection.
		console.error("Failed to persist undo entry:", error);
		return { persisted: false, restore: async () => undefined };
	}
	return {
		persisted: true,
		restore: async () => {
			try {
				if (previous) await writeUndo(path, previous);
				else await removeUndo(path);
			} catch (error) {
				// SAFETY: best-effort undo restore — failures to restore previous undo entry after persist failure are ignored; edit already failed and will report E_UNDO_UNAVAILABLE, stale undo state is recoverable on next edit.
				console.error("Failed to restore previous undo entry:", error);
			}
		},
	};
}

export async function getUndo(path: string): Promise<UndoEntry | undefined> {
	try {
		const record = await readUndo(path);
		if (!record) return undefined;
		const originalEnding = record.ending;
		if (
			originalEnding !== "\r\n" &&
			originalEnding !== "\n" &&
			originalEnding !== "\r"
		) {
			await removeUndo(path);
			return undefined;
		}
		return {
			content: record.content,
			bom: record.bom,
			originalEnding,
			hashes: record.hashes,
			resultContent: record.resultContent,
		};
	} catch (error) {
		// SAFETY: best-effort undo load — failures return undefined (no history) and caller reports "No undo history"; stale or corrupt store is recoverable on next edit, not silent undefined without log.
		console.error("Failed to load undo entry:", error);
		return undefined;
	}
}

export async function clearUndo(path: string): Promise<void> {
	try {
		await removeUndo(path);
	} catch (error) {
		// SAFETY: best-effort undo cleanup — clearUndo failures are ignored; stale undo entry will be overwritten on next edit or pruned, file content already correct.
		console.error("Failed to clear undo entry:", error);
	}
}

export function regEditUndo(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "undo_last_edit",
		label: "Undo Last Edit",
		description: loadP("../prompts/undo-last-edit.md"),
		promptSnippet: loadP("../prompts/undo-last-edit-snippet.md"),
		promptGuidelines: loadGuide("../prompts/undo-last-edit-guidelines.md"),
		prepareArguments: (args: unknown) => {
			if (!isRec(args)) return args as any;
			const record = { ...args };
			normalizeFilePath(record);
			return record;
		},
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file to undo",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const path = params.path;
			const absolutePath = toCwd(path, ctx.cwd);
			const mutationTargetPath = await resolveTarget(absolutePath);

			const undo = await getUndo(mutationTargetPath);
			if (!undo) {
				return {
					content: [
						{
							type: "text",
							text: `No undo history for ${path}. There is no previous edit to revert.`,
						},
					],
					isError: true,
					details: {},
				};
			}

			return withFileMutationQueue(mutationTargetPath, async () => {
				let currentRaw: string | undefined;
				try {
					currentRaw = await readFile(mutationTargetPath, "utf-8");
				} catch (error) {
					if (errCode(error) !== "ENOENT") throw error;
				}

				if (currentRaw === undefined) {
					await clearUndo(mutationTargetPath);
					return {
						content: [
							{
								type: "text",
								text: `[E_UNDO_STALE] cannot undo on ${path}: file no longer exists.`,
							},
						],
						isError: true,
						details: {},
					};
				}
				if (
					currentRaw !==
					undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)
				) {
					await clearUndo(mutationTargetPath);
					return {
						content: [
							{
								type: "text",
								text: `[E_UNDO_STALE] cannot undo on ${path}: file modified after edit — undo would overwrite changes.`,
							},
						],
						isError: true,
						details: {},
					};
				}

				const { text: currentStripped } = stripBOM(currentRaw);
				const currentNormalized = toLF(currentStripped);
				const sessionKeyForUndo = (ctx as unknown as { sessionManager?: { getSessionId(): string } })?.sessionManager?.getSessionId?.() ?? "unknown-session";
				let tombstoneForUndo: ReadonlySet<string> = new Set();
				try {
					const handle = (await import("./served-session/session.js")).createSessionHandle(sessionKeyForUndo, mutationTargetPath) as unknown as { getTombstone?: () => Promise<Set<string>> };
					if (handle.getTombstone) tombstoneForUndo = await handle.getTombstone();
				} catch {}
				const currentHashes = await lineHashes(
					currentNormalized,
					mutationTargetPath,
				);
				const diffResult = genDiff(
					undo.content,
					currentNormalized,
					0,
					undefined,
					undo.hashes,
				);
				const linesAddedByEdit = cntDiff(diffResult.diff, "+");
				const linesRemovedByEdit = cntDiff(diffResult.diff, "-");
				const restoredRange = changedRange(currentNormalized, undo.content);
				const undoDiffResult = genDiff(
					currentNormalized,
					undo.content,
					1,
					undo.hashes,
					currentHashes,
				);
				const undoDiff = undoDiffResult.diff;
				let restoredHashes = undo.hashes;
				try {
					const blocked = new Set<string>(tombstoneForUndo);
					for (const h of currentHashes) blocked.add(h);
					const retiredOriginal = new Set<string>(undo.hashes.filter((h) => (tombstoneForUndo as Set<string>).has(h)));
					restoredHashes = await lineHashes(
						undo.content,
						mutationTargetPath,
						{ content: undo.content, hashes: undo.hashes, removedHashes: retiredOriginal },
						undefined,
						false,
					) as unknown as string[];
				} catch {}
				const undoDenseRows: typeof undoDiffResult.servedRows = [];
				for (let i = 0; i < restoredHashes.length; i++) {
					undoDenseRows.push({ position: i, hash: restoredHashes[i]! });
				}
				try {
					const curSet = new Set(currentHashes);
					const restoredSet = new Set(restoredHashes);
					const toRetire = [...curSet].filter((h) => !restoredSet.has(h));
					if (toRetire.length > 0) {
						const handle = (await import("./served-session/session.js")).createSessionHandle(sessionKeyForUndo, mutationTargetPath) as unknown as { retireAnchors?: (hs: Iterable<string>) => Promise<void> };
						if (handle.retireAnchors) await handle.retireAnchors(toRetire);
					}
				} catch {}

				await writeAtomic(
					mutationTargetPath,
					undo.bom + restoreEndings(undo.content, undo.originalEnding),
				);

				try {
					await upsertSnapshotFor(
						mutationTargetPath,
						contentChecksum(undo.content),
						splitLines(undo.content).length,
						restoredHashes,
					);
				} catch (error) {
					// SAFETY: best-effort snapshot restore after undo — hash snapshot failures are ignored; file content already restored and hashes will be recomputed on next read, no data loss.
					console.error("Failed to restore hash store snapshot after undo:", error);
				}

				await clearUndo(mutationTargetPath);

				const parts: string[] = [`Undone last edit on ${path}.`];
				if (linesAddedByEdit > 0 || linesRemovedByEdit > 0) {
					parts.push(
						`Removed ${linesAddedByEdit} line(s) that were added and restored ${linesRemovedByEdit} line(s) that were removed.`,
					);
				}
				parts.push(
					"File reverted; diff rows carry fresh anchors for follow-up edits.",
				);

				const details: EditDetails = {
					diff: undoDiff,
					firstChangedLine:
						restoredRange?.firstChangedLine ?? undoDiffResult.firstChangedLine,
					resultLineCount: visLines(undo.content).length,
					servedRows: undoDenseRows,
					metrics: buildMetrics({
						classification: "applied",
						editsAttempted: 1,
						noopEditsCount: 0,
						warningsCount: 0,
						firstChangedLine: restoredRange?.firstChangedLine,
						lastChangedLine: restoredRange?.lastChangedLine,
						addedLines: linesRemovedByEdit,
						removedLines: linesAddedByEdit,
					}),
				};
				return {
					content: [
						{
							type: "text",
							text: parts.join("\n"),
						},
					],
					details,
				};
			});
		},
	});
}
