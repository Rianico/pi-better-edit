import type { LineEnding } from "./edit-diff";
import { readNormFile } from "./file-reader";
import { abortIf } from "./utils";
import type { HashStore } from "./hash-store";
import { snapshotIOFor } from "./snapshot-store";
import {
	applyEdit,
	MAX_HASH_LINES,
	type AutoFix,
	type HEdit,
	type NEdit,
} from "./hashline";
import { defaultHashIdentity } from "./hashline/hash-identity";
import {
	AnchorMismatchError,
	ServedRejectionError,
	type ResolvedRange,
} from "./hashline/served";
import {
	loadServed,
	recordEchoServes,
	type ServeRecordPolicy,
} from "./served-state";

export function collectRemovedHashes(
	edit: HEdit,
	originalHashes: string[],
): Set<string> {
	const removedHashes = new Set<string>();
	const startHash = edit.hash_bounds[0].hash;
	const endHash = edit.hash_bounds[1].hash;
	const startLine = originalHashes.indexOf(startHash);
	const endLine = originalHashes.indexOf(endHash);
	if (startLine >= 0 && endLine >= 0) {
		const firstLine = Math.min(startLine, endLine);
		const lastLine = Math.max(startLine, endLine);
		for (let i = firstLine; i <= lastLine; i++) {
			removedHashes.add(originalHashes[i]!);
		}
	}
	return removedHashes;
}

export function countLineChanges(
	edit: HEdit,
	originalHashes: string[],
	isNoop: boolean,
	removedAutoFixes: number,
): { totalAddedLines: number; totalRemovedLines: number } {
	if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
	let totalRemovedLines = 0;
	const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash);
	const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash);
	if (startLine >= 0 && endLine >= 0) {
		totalRemovedLines = Math.abs(endLine - startLine) + 1;
	}
	return {
		totalAddedLines: Math.max(0, edit.content_lines.length - removedAutoFixes),
		totalRemovedLines,
	};
}

export interface EditFileSource {
	path: string;
	cwd: string;
	signal?: AbortSignal;
	accessMode?: number;
	sessionKey: string;
	store?: HashStore;
	noPersist?: boolean;
}

export interface LoadedEditFile {
	normalized: string;
	bom: string;
	originalEnding: LineEnding;
	fileHashes: string[];
	hadUtf8DecodeErrors: boolean;
	absolutePath: string;
	served: (string | null)[];
}

export async function loadEditFile(
	source: EditFileSource,
): Promise<LoadedEditFile> {
	const {
		normalized,
		bom,
		originalEnding,
		fileHashes,
		hadUtf8DecodeErrors,
		absolutePath,
	} = await readNormFile(source.path, source.cwd, {
		signal: source.signal,
		accessMode: source.accessMode,
		maxLines: MAX_HASH_LINES,
		store: source.store,
		noPersist: source.noPersist,
	});
	const served = await loadServed(source.sessionKey, absolutePath);
	return {
		normalized,
		bom,
		originalEnding,
		fileHashes,
		hadUtf8DecodeErrors,
		absolutePath,
		served,
	};
}

export interface ApplyOneEditInput {
	content: string;
	hashes: string[];
	edit: HEdit;
	signal?: AbortSignal;
	filePath: string;
	served: (string | null)[];
	sessionKey: string;
	absolutePath: string;
	store: HashStore;
	persistHashes: boolean;
	servePolicy: ServeRecordPolicy;
	onRejected: (
		error: AnchorMismatchError | ServedRejectionError,
	) => Promise<never>;
}

export type ApplyOneEditOutcome =
	| {
			kind: "applied";
			content: string;
			hashes: string[];
			removedHashes: Set<string>;
			range: ResolvedRange;
			firstChangedLine: number | undefined;
			lastChangedLine: number | undefined;
			autoFixes: AutoFix[] | undefined;
			anchorWarnings: string[] | undefined;
	  }
	| {
			kind: "noop";
			range: ResolvedRange;
			noopEdit: NEdit | undefined;
			anchorWarnings: string[] | undefined;
	  };

export async function applyOneEdit(
	input: ApplyOneEditInput,
): Promise<ApplyOneEditOutcome> {
	abortIf(input.signal);

	let anchorResult: ReturnType<typeof applyEdit>;
	try {
		anchorResult = applyEdit(
			input.content,
			input.edit,
			input.signal,
			input.hashes,
			input.filePath,
			input.served,
		);
	} catch (error) {
		if (
			error instanceof AnchorMismatchError ||
			error instanceof ServedRejectionError
		) {
			await recordEchoServes(
				input.sessionKey,
				input.absolutePath,
				error.servedRows,
				input.servePolicy,
				input.hashes.length,
			);
			return input.onRejected(error);
		}
		throw error;
	}

	const anchorWarnings = anchorResult.warnings;
	const nextContent = anchorResult.content;
	if (nextContent === input.content) {
		return {
			kind: "noop",
			range: anchorResult.range,
			noopEdit: anchorResult.noopEdit,
			anchorWarnings,
		};
	}

	if (!input.hashes || input.hashes.length === 0)
		throw new Error(
			"[E_STALE_ANCHOR] missing previous hashes for stable anchoring",
		);
	const removedHashes = collectRemovedHashes(input.edit, input.hashes);
	const nextHashes = await defaultHashIdentity.hashesFor(nextContent, {
		path: input.absolutePath,
		prior: { content: input.content, hashes: input.hashes, removedHashes },
		persist: input.persistHashes,
		snapshotIO: snapshotIOFor(input.store),
	});
	return {
		kind: "applied",
		content: nextContent,
		hashes: nextHashes,
		removedHashes,
		range: anchorResult.range,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
		autoFixes: anchorResult.autoFixes,
		anchorWarnings,
	};
}
