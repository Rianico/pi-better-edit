/**
 * SAFETY: FileContent — deep module owning "prepare file content" seam.
 *
 * One concept scattered across file-kind + file-reader + read preview:
 * kind detection (magic+ext, BOM/UTF-32/16), decode (UTF-8, hadUtf8DecodeErrors,
 * newline counting, maxLines), normalization (BOM strip, CRLF→LF, ending),
 * hashing (snapshot cache, stable hashes), preview (offset/limit, oversize,
 * truncation). Callers cross one seam: prepare().
 */

import { constants } from "node:fs";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { AUTO_READ_MAX } from "../constants.js";
import { MAX_HASH_LINES } from "../hashline/index.js";
import { resolveTarget } from "../fs-write.js";
import { toCwd } from "../paths.js";
import { valAccess } from "../validation.js";
import { abortIf } from "../utils.js";
import { visLines } from "../utils.js";
import { loadFileKindAndText, type LFile } from "./detection.js";
import { readNormFile, fileSnap } from "./loader.js";
import { fmtReadPreview } from "./preview.js";
import type { ServedRow } from "../hashline/served.js";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export type { LFile, LoadFileOptions } from "./detection.js";
export { loadFileKindAndText } from "./detection.js";
export { readNormFile, fileSnap, type NormFile, type SnapInfo, type ReadNormOptions } from "./loader.js";
export { fmtReadPreview } from "./preview.js";

export interface PrepareResult {
	kind: LFile["kind"];
	normalized: string;
	absolutePath: string;
	bom: string;
	fileHashes: string[];
	hadUtf8DecodeErrors: boolean;
	preview: string;
	served: ServedRow[];
	truncation?: TruncationResult;
	nextOffset?: number;
	description?: string;
	mimeType?: string;
}

export interface PrepareOptions {
	signal?: AbortSignal;
	offset?: number;
	limit?: number;
	maxLines?: number;
	accessMode?: number;
	maxLineBytes?: number;
	maxTruncLines?: number;
	store?: import("../hash-store.js").HashStore;
	noPersist?: boolean;
	preloadedFile?: LFile;
}

export async function prepareFile(
	path: string,
	cwd: string,
	options?: PrepareOptions,
): Promise<PrepareResult> {
	const absolutePath = toCwd(path, cwd);
	const signal = options?.signal;
	abortIf(signal);
	await valAccess(absolutePath, path, options?.accessMode ?? constants.R_OK);
	abortIf(signal);
	const file =
		options?.preloadedFile ??
		(await loadFileKindAndText(absolutePath, {
			maxLines: options?.maxLines ?? MAX_HASH_LINES,
			displayPath: path,
		}));
	if (file.kind !== "text") {
		const resolved = await resolveTarget(absolutePath).catch(() => absolutePath);
		if (file.kind === "binary") {
			return {
				kind: "binary",
				normalized: "",
				absolutePath: resolved,
				bom: "",
				fileHashes: [],
				hadUtf8DecodeErrors: false,
				preview: "",
				served: [],
				description: file.description,
			};
		}
		if (file.kind === "image") {
			return {
				kind: "image",
				normalized: "",
				absolutePath: resolved,
				bom: "",
				fileHashes: [],
				hadUtf8DecodeErrors: false,
				preview: "",
				served: [],
				mimeType: file.mimeType,
			};
		}
		return {
			kind: "directory",
			normalized: "",
			absolutePath: resolved,
			bom: "",
			fileHashes: [],
			hadUtf8DecodeErrors: false,
			preview: "",
			served: [],
		};
	}

	const norm = await readNormFile(path, cwd, {
		signal,
		accessMode: options?.accessMode,
		maxLines: options?.maxLines ?? MAX_HASH_LINES,
		store: options?.store,
		noPersist: options?.noPersist,
		preloadedFile: file,
	});

	const preview = await fmtReadPreview(
		norm.normalized,
		{ offset: options?.offset, limit: options?.limit },
		norm.fileHashes,
		norm.absolutePath,
		options?.maxLineBytes ?? DEFAULT_MAX_BYTES,
		options?.maxTruncLines ?? AUTO_READ_MAX,
	);

	const previewText = norm.hadUtf8DecodeErrors
		? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
		: preview.text;

	return {
		kind: "text",
		normalized: norm.normalized,
		absolutePath: norm.absolutePath,
		bom: norm.bom,
		fileHashes: norm.fileHashes,
		hadUtf8DecodeErrors: norm.hadUtf8DecodeErrors,
		preview: previewText,
		served: preview.served,
		...(preview.truncation ? { truncation: preview.truncation } : {}),
		...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
	};
}

export async function snapIdFor(absolutePath: string): Promise<string | undefined> {
	try {
		return (await fileSnap(absolutePath)).snapshotId;
	} catch {
		return undefined;
	}
}

export { visLines };
