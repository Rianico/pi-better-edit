import { abortIf, rejectUnknownFields, clipLine } from "../utils.js";
import {
	HASH_CLASS,
	HL_BARE_PREFIX_RE,
	HL_PREFIX_PLUS_RE,
	HL_PREFIX_MINUS_RE,
} from "./hash-identity.js";
import { parseHashRef, parseText, type Anchor } from "./parse.js";
import type { ServedRow } from "./served.js";
import { NEW_CONTENT_NOT_STRING_MSG } from "../constants.js";

type RAnchor = {
	line: number;
	hash: string;
	hashMatched: boolean;
};

export type HEdit = { content_lines: string[]; hash_bounds: [Anchor, Anchor] };
export type RHEdit = {
	content_lines: string[];
	hash_bounds: [RAnchor, RAnchor];
};

interface HMismatch {
	ref: Anchor;
	kind: "not_found" | "ambiguous";
	candidates?: number[];
	context?: RAnchor;
}

export interface NEdit {
	loc: string;
	currentContent: string;
}

export type HTEdit = {
	replace_with: string;
	anchor_from: string;
	anchor_to: string;
};

function resAnchorFromMap(
	ref: Anchor,
	hashIndex: Map<string, number[]>,
): RAnchor | HMismatch {
	const hashMatches = hashIndex.get(ref.hash);
	if (!hashMatches || hashMatches.length === 0) {
		return { ref, kind: "not_found" };
	}
	if (hashMatches.length === 1) {
		return {
			line: hashMatches[0]!,
			hash: ref.hash,
			hashMatched: true,
		};
	}
	return { ref, kind: "ambiguous", candidates: hashMatches };
}

function assertAligned(
	fileLines: string[],
	fileHashes: string[],
	ctx: string,
): void {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`${ctx}: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
}

function _fmtMismatch(
	mismatches: HMismatch[],
	fileLines: string[],
	fileHashes: string[],
	filePath?: string,
): string {
	return fmtMismatchWithServes(mismatches, fileLines, fileHashes, filePath)
		.message;
}

function formatNotFound(
	notFound: HMismatch[],
	fileLines: string[],
	fileHashes: string[],
	filePath: string | undefined,
	pushRow: (ln: number) => void,
	out: string[],
): void {
	if (notFound.length === 0) return;
	const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
	out.push(
		`[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. Re-read the full file and copy the fresh 3-char anchors (the 3 chars before │, e.g. "wUp").`,
	);
	for (const m of notFound) {
		const ctx = m.context;
		if (!ctx) continue;
		const from = Math.max(1, ctx.line - 1);
		const to = Math.min(fileLines.length, ctx.line + 1);
		const rows: string[] = [];
		for (let ln = from; ln <= to; ln++) {
			rows.push(
				`    ${ln}: ${fileHashes[ln - 1]}│${clipLine(fileLines[ln - 1] ?? "")}`,
			);
			pushRow(ln);
		}
		out.push("");
		out.push(
			`  Current context around resolved anchor "${ctx.hash}" (line ${ctx.line}):\n${rows.join("\n")}`,
		);
	}
}
function formatAmbiguous(
	ambiguous: HMismatch[],
	fileLines: string[],
	fileHashes: string[],
	filePath: string | undefined,
	pushRow: (ln: number) => void,
	out: string[],
): void {
	if (ambiguous.length === 0) return;
	if (out.length > 0) out.push("");
	out.push(
		`[E_STALE_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}. Re-read the full file and copy the fresh 3-char anchors (the 3 chars before │, e.g. "wUp").`,
	);
	for (const m of ambiguous) {
		const sample = (m.candidates ?? []).slice(0, 5);
		const more =
			(m.candidates?.length ?? 0) > sample.length
				? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
				: "";
		const lines = sample
			.map((line) => {
				const content = clipLine(fileLines[line - 1] ?? "");
				pushRow(line);
				return `    ${line}: ${fileHashes[line - 1]}│${content}`;
			})
			.join("\n");
		out.push(
			`  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`,
		);
	}
}
function buildHashIndex(fileHashes: string[]): Map<string, number[]> {
	const hashIndex = new Map<string, number[]>();
	for (let i = 0; i < fileHashes.length; i++) {
		const h = fileHashes[i]!;
		const list = hashIndex.get(h) ?? [];
		list.push(i + 1);
		hashIndex.set(h, list);
	}
	return hashIndex;
}
export function fmtMismatchWithServes(
	mismatches: HMismatch[],
	fileLines: string[],
	fileHashes: string[],
	filePath?: string,
): { message: string; servedRows: ServedRow[] } {
	assertAligned(fileLines, fileHashes, "fmtMismatch");

	const out: string[] = [];
	const servedRows: ServedRow[] = [];
	const seen = new Set<number>();
	const pushRow = (ln: number) => {
		if (ln < 1 || ln > fileLines.length) return;
		const position = ln - 1;
		if (seen.has(position)) return;
		seen.add(position);
		servedRows.push({ position, hash: fileHashes[ln - 1]! });
	};
	const notFound = mismatches.filter((m) => m.kind === "not_found");
	const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");
	formatNotFound(notFound, fileLines, fileHashes, filePath, pushRow, out);
	formatAmbiguous(ambiguous, fileLines, fileHashes, filePath, pushRow, out);

	return { message: out.join("\n"), servedRows };
}

const ITEM_KS = new Set(["replace_with", "anchor_from", "anchor_to"]);

function assertItem(edit: Record<string, unknown>): void {
	rejectUnknownFields(
		edit,
		ITEM_KS,
		"Edit",
		"The edit takes only { replace_with, anchor_from, anchor_to }.",
	);

	if ("anchor_from" in edit && typeof edit.anchor_from !== "string") {
		throw new Error(
			`[MODEL] [E_BAD_PAYLOAD] Field "anchor_from" must be a bare 3-char hash anchor copied from served output (before │). Nothing was written; fix the field and retry.`,
		);
	}
	if ("anchor_to" in edit && typeof edit.anchor_to !== "string") {
		throw new Error(
			`[MODEL] [E_BAD_PAYLOAD] Field "anchor_to" must be a bare 3-char hash anchor copied from served output (before │). Nothing was written; fix the field and retry.`,
		);
	}
	if (!("replace_with" in edit)) {
		throw new Error(
			`[MODEL] [E_BAD_PAYLOAD] The edit requires a "replace_with" field. Provide the replacement text (use "" to delete). Nothing was written.`,
		);
	}
	if (typeof edit.replace_with !== "string") {
		throw new Error(NEW_CONTENT_NOT_STRING_MSG);
	}
	if (
		typeof edit.anchor_from !== "string" ||
		typeof edit.anchor_to !== "string"
	) {
		throw new Error(
			`[MODEL] [E_BAD_PAYLOAD] The edit requires "anchor_from" and "anchor_to" anchor strings (bare 3-char hashes from served output). Nothing was written.`,
		);
	}
}

// SAFETY: HASH_CLASS is trusted constant [A-Za-z0-9]{3}, linear row prefix — bounded, no user input, no ReDoS.
const ANCHOR_ROW_RE = new RegExp(`^([+-]?)(${HASH_CLASS})│`);
function firstHashFromBlock(block: string): string | undefined {
	for (const line of block.split("\n")) {
		const m = line.match(ANCHOR_ROW_RE);
		if (m) return m[2]!;
		// SAFETY: HASH_CLASS is trusted constant [A-Za-z0-9]{3}, bounded 3-char, linear search — no user-controlled pattern, no ReDoS.
		const bare = line.match(new RegExp(HASH_CLASS));
		if (bare) return bare[0]!;
	}
	return undefined;
}

export function resEdit(edit: HTEdit, _warnings?: string[]): HEdit {
	assertItem(edit as Record<string, unknown>);

	const editLines = parseText(edit.replace_with);
	const bounds = [edit.anchor_from, edit.anchor_to].map((ref) => {
		const trimmed = ref.trim();
		if (trimmed.includes("\n")) {
			const hash = firstHashFromBlock(trimmed);
			if (hash) {
				const lines = trimmed.split("\n").length;
				throw new Error(`[MODEL] [E_BAD_ANCHOR] extracted first hash "${hash}" from ${lines}-line block — use bare "${hash}" next time`);
			}
		}
		const match = trimmed.match(ANCHOR_ROW_RE);
		if (match) {
			let message: string;
			if (match[1] === "+") {
				message = `[MODEL] [E_BAD_ANCHOR] stripped diff-preview marker from anchor_from/anchor_to "${trimmed}". Nothing was written; pass the bare 3-char anchor and retry.`;
			} else if (match[1] === "-") {
				message = `[MODEL] [E_BAD_ANCHOR] stripped leading "-" marker from anchor_from/anchor_to "${trimmed}". Nothing was written; pass the bare 3-char anchor and retry.`;
			} else {
				message = `[MODEL] [E_BAD_ANCHOR] stripped "HASH│" prefix from anchor_from/anchor_to "${trimmed}". Nothing was written; copy only the 3 chars before │ and retry.`;
			}
			throw new Error(message);
		}
		return ref;
	}) as [string, string];
	return {
		content_lines: editLines,
		hash_bounds: [parseHashRef(bounds[0]), parseHashRef(bounds[1])],
	};
}

function warnUnicodeEsc(edit: HEdit, warnings: string[]): void {
	if (edit.content_lines.some((line) => /\\uDDDD/i.test(line))) {
		warnings.push(
			"Literal \\uDDDD in edit content; no autocorrection applied. Verify whether this is a real Unicode escape or plain text.",
		);
	}
}

export function stripBarePrefixes(
	edit: HEdit,
	fileHashes: string[],
	_warnings: string[],
): HEdit {
	const fileHashSet = new Set(fileHashes);
	const stripped: { lineIndex: number; matched: boolean }[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const match = line.match(HL_BARE_PREFIX_RE);
		if (!match) return line;
		stripped.push({ lineIndex, matched: fileHashSet.has(match[1]!) });
		return line.slice(match[0].length);
	});
	if (stripped.length === 0) return edit;
	const locations = stripped
		.map((s) => `replace_with line ${s.lineIndex + 1}`)
		.join(", ");
	const matchedCount = stripped.filter((s) => s.matched).length;
	const evidence =
		matchedCount === 0
			? "0 matched — verify literal 'HASH│' content"
			: `${matchedCount}/${stripped.length} matched`;
	if (matchedCount === stripped.length) {
		throw new Error(`[MODEL] [E_BAD_ANCHOR] Refused: stripped "HASH│" prefix from ${locations} (${evidence}). Nothing was written; pass bare content without HASH│ and retry.`);
	} else {
		throw new Error(`[MODEL] [E_BAD_ANCHOR] Refused: stripped "HASH│" prefix from ${locations} (${evidence}). Nothing was written; pass bare content and retry.`);
	}
	return { ...edit, content_lines: contentLines };
}

export function stripDiffPrefixes(edit: HEdit, _warnings: string[]): HEdit {
	const stripped: number[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const plus = line.match(HL_PREFIX_PLUS_RE);
		if (plus) {
			stripped.push(lineIndex);
			return line.slice(plus[0].length);
		}
		const minus = line.match(HL_PREFIX_MINUS_RE);
		if (minus) {
			stripped.push(lineIndex);
			return line.slice(minus[0].length);
		}
		return line;
	});
	if (stripped.length === 0) return edit;
	const locations = stripped
		.map((i) => `replace_with line ${i + 1}`)
		.join(", ");
	throw new Error(`[MODEL] [E_BAD_ANCHOR] Refused: stripped diff-preview marker from ${locations}. Nothing was written; pass bare content without +/- prefixes and retry.`);
	return { ...edit, content_lines: contentLines };
}

export function swapReversedRanges(
	edit: HEdit,
	fileHashes: string[],
	warnings: string[],
): HEdit {
	const lineByHash = new Map<string, number>();
	for (let i = 0; i < fileHashes.length; i++) {
		lineByHash.set(fileHashes[i]!, i + 1);
	}
	const [startRef, endRef] = edit.hash_bounds;
	const startLine = lineByHash.get(startRef.hash);
	const endLine = lineByHash.get(endRef.hash);
	if (startLine === undefined || endLine === undefined || startLine <= endLine) {
		return edit;
	}
	warnings.push(
		`[USER] [E_REVERSED_ANCHORS] anchor_from/anchor_to were reversed (${startRef.hash} after ${endRef.hash}); healed and applied with the range swapped.`,
	);
	return { ...edit, hash_bounds: [endRef, startRef] as [Anchor, Anchor] };
}

export function valEdit(
	edit: HEdit,
	fileLines: string[],
	fileHashes: string[],
	_warnings: string[],
	signal: AbortSignal | undefined,
): {
	resolved: RHEdit | undefined;
	mismatches: HMismatch[];
} {
	assertAligned(fileLines, fileHashes, "valEdit");
	const mismatches: HMismatch[] = [];

	const hashIndex = buildHashIndex(fileHashes);

	const tryResolve = (ref: Anchor): RAnchor | undefined => {
		const result = resAnchorFromMap(ref, hashIndex);
		if ("kind" in result) {
			mismatches.push(result);
			return undefined;
		}
		return result;
	};

	abortIf(signal);
	const startResolved = tryResolve(edit.hash_bounds[0]);
	const endResolved = tryResolve(edit.hash_bounds[1]);
	if (!startResolved || !endResolved) {
		if (!startResolved && endResolved) {
			const startMismatch = mismatches.findLast(
				(m) => m.ref === edit.hash_bounds[0],
			);
			if (startMismatch && startMismatch.kind === "not_found")
				startMismatch.context = endResolved;
		} else if (startResolved && !endResolved) {
			const endMismatch = mismatches.findLast(
				(m) => m.ref === edit.hash_bounds[1],
			);
			if (endMismatch && endMismatch.kind === "not_found")
				endMismatch.context = startResolved;
		}
		return { resolved: undefined, mismatches };
	}
	if (startResolved.line > endResolved.line) {
		throw new Error(
			`[MODEL] [E_REVERSED_ANCHORS] Refused: range start line ${startResolved.line} is after end line ${endResolved.line} (anchors ${edit.hash_bounds[0].hash} and ${edit.hash_bounds[1].hash}). Nothing was written; swap anchor_from/anchor_to and retry.`,
		);
	}

	return {
		resolved: {
			content_lines: edit.content_lines,
			hash_bounds: [startResolved, endResolved],
		},
		mismatches,
	};
}

export { warnUnicodeEsc };
