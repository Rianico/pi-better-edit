import type { LineEnding } from "../edit-diff.js";
import type { LFile } from "./detection.js";

export type { LFile, LoadFileOptions } from "./detection.js";

export interface NormFile {
	absolutePath: string;
	normalized: string;
	bom: string;
	originalEnding: LineEnding;
	fileHashes: string[];
	hadUtf8DecodeErrors: boolean;
}

export interface FileContent {
	kind: LFile["kind"];
	normalized: string;
	bom: string;
	originalEnding: LineEnding;
	fileHashes: string[];
	hadUtf8DecodeErrors: boolean;
	absolutePath: string;
	/** Present for image/binary/directory */
	description?: string;
	mimeType?: string;
	textSnippet?: string;
}

export interface PrepareOptions {
	signal?: AbortSignal;
	accessMode?: number;
	maxLines?: number;
	store?: import("../hash-store.js").HashStore;
	noPersist?: boolean;
	preloadedFile?: LFile;
}

export interface PreviewOptions {
	offset?: number;
	limit?: number;
	maxLineBytes?: number;
	maxTruncLines?: number;
}

export interface PreparedPreview {
	preview: string;
	served: import("../hashline/served.js").ServedRow[];
	truncation?: import("@earendil-works/pi-coding-agent").TruncationResult;
	nextOffset?: number;
}
