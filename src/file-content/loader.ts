import { constants } from "node:fs";
import { stat } from "node:fs/promises";
import { defaultHashIdentity } from "../hashline/hash-identity.js";
import { loadFileKindAndText, type LFile } from "./detection.js";
import { resolveTarget } from "../fs-write.js";
import { toCwd } from "../paths.js";
import { detectEnding, toLF, stripBOM } from "../edit-diff.js";
import { abortIf } from "../utils.js";
import { valKind, valAccess } from "../validation.js";
import { visLines } from "../utils.js";
import { loadHashStore, type HashStore } from "../hash-store.js";
import { snapshotIOFor } from "../snapshot-store.js";
import type { NormFile } from "./types.js";

export type { NormFile } from "./types.js";

export type SnapInfo = {
	snapshotId: string;
	ino: number;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
};

function fmtSnapId(
	canonicalPath: string,
	info: { ino: number; mtimeMs: number; ctimeMs: number; size: number },
	checksum?: string,
): string {
	return `v2|${canonicalPath}|${info.ino}|${info.mtimeMs}|${info.ctimeMs}|${info.size}${checksum ? `|${checksum}` : ""}`;
}

export async function fileSnap(absolutePath: string, checksum?: string): Promise<SnapInfo> {
	const canonicalPath = await resolveTarget(absolutePath);
	const stats = await stat(canonicalPath);
	// P1: include content checksum in snapshotId for stronger epoch (ADR-0013)
	// Checksum is optional for backward compat; when provided, epoch distinguishes same-size whitespace changes.
	const effectiveChecksum = checksum ?? undefined;
	return {
		snapshotId: fmtSnapId(canonicalPath, stats, effectiveChecksum),
		ino: stats.ino,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		size: stats.size,
	};
}

export interface ReadNormOptions {
	signal?: AbortSignal;
	accessMode?: number;
	preloadedFile?: LFile;
	maxLines?: number;
	store?: HashStore;
	noPersist?: boolean;
}

export async function readNormFile(
	path: string,
	cwd: string,
	options?: ReadNormOptions,
): Promise<NormFile> {
	const absolutePath = toCwd(path, cwd);
	const resolvedPath = await resolveTarget(absolutePath);
	const signal = options?.signal;
	const accessMode = options?.accessMode ?? constants.R_OK;

	abortIf(signal);
	await valAccess(resolvedPath, path, accessMode);

	abortIf(signal);
	const file =
		options?.preloadedFile ??
		(await loadFileKindAndText(resolvedPath, {
			maxLines: options?.maxLines,
			displayPath: path,
		}));
	valKind(file, path);
	abortIf(signal);
	const { bom, text: rawContent } = stripBOM(file.text);
	const originalEnding = detectEnding(rawContent);
	const normalized = toLF(rawContent);

	if (options?.maxLines !== undefined) {
		const lineCount = visLines(normalized).length;
		if (lineCount > options.maxLines) {
			throw new Error(
				`[E_FILE_TOO_LARGE] ${path} has ${lineCount} lines, exceeding the ${options.maxLines}-line edit limit. Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.`,
			);
		}
	}

	const hashStore = options?.store ?? (await loadHashStore());
	const fileHashes = await defaultHashIdentity.hashesFor(normalized, {
		path: resolvedPath,
		persist: options?.noPersist !== true,
		snapshotIO: snapshotIOFor(hashStore),
	});
	return {
		absolutePath: resolvedPath,
		normalized,
		bom,
		originalEnding,
		fileHashes,
		hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
	};
}
