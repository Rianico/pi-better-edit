
import { throwIfAborted } from "../runtime";
import { HASHLINE_BARE_PREFIX_RE } from "./hash";
import { parseHashRef, hashlineParseText, type Anchor } from "./parse";


export type ResolvedAnchor = {
	line: number;
	hash: string;
	hashMatched: boolean;
};

export type HashlineEdit = { old_range: [Anchor, Anchor]; new_lines: string[] };
export type ResolvedHashlineEdit = {
	old_range: [ResolvedAnchor, ResolvedAnchor];
	new_lines: string[];
};
interface HashMismatch {
	ref: Anchor;
	kind: "not_found" | "ambiguous";
	candidates?: number[];
}

export interface BoundaryDuplicationWarning {
	kind: "trailing" | "leading";
	survivingLineContent: string;
	survivingLineIndex: number;
	occurrence: number;
	replacementLineContent: string;
	editIndex: number;
}

export interface NoopEdit {
	editIndex: number;
	loc: string;
	currentContent: string;
}

export type HashlineToolEdit = {
	old_range?: [string, string];
	new_lines?: string[];
	oldText?: string;
	newText?: string;
};


function resolveAnchor(
	ref: Anchor,
	fileLines: string[],
	fileHashes: string[],
): ResolvedAnchor | HashMismatch {
	const hashMatches: number[] = [];
	for (let i = 0; i < fileHashes.length; i++) {
		if (fileHashes[i] === ref.hash) hashMatches.push(i + 1);
	}
	if (hashMatches.length === 0) {
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


export function formatMismatchError(
	mismatches: HashMismatch[],
	fileLines: string[],
	fileHashes: string[],
): string {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`formatMismatchError: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
	const out: string[] = [];
	const notFound = mismatches.filter((m) => m.kind === "not_found");
	const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");

	const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
	if (notFound.length > 0) {
	out.push(
		`[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}: ${refList}. Call read() to get fresh anchors, then copy the 3-character HASH from each line into your next replace call.`
	);
	}
	if (ambiguous.length > 0) {
		if (out.length > 0) out.push("");
	out.push(
		`[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}. Call read() to get fresh anchors, then copy the 3-character HASH from each line into your next replace call.`
	);
		for (const m of ambiguous) {
			const sample = (m.candidates ?? []).slice(0, 5);
			const more =
				(m.candidates?.length ?? 0) > sample.length
					? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
					: "";
			const lines = sample
				.map((line) => {
					const content = fileLines[line - 1] ?? "";
					return `    ${line}: ${fileHashes[line - 1]}│${content}`;
				})
				.join("\n");
				out.push(
					`  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`,
				);
		}
	}


	return out.join("\n");
}


const ITEM_KEYS = new Set(["old_range", "new_lines"]);
function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isStringPair(value: unknown): value is [string, string] {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		value.every((item) => typeof item === "string")
	);
}

function assertEditItem(edit: Record<string, unknown>, index: number): void {
	const unknownKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(
			`[E_BAD_SHAPE] Edit ${index} contains unknown or unsupported fields: ${unknownKeys.join(", ")}. Each edit takes only { old_range, new_lines }.`,
		);
	}

	if ("old_range" in edit && !isStringPair(edit.old_range)) {
		throw new Error(
			`[E_BAD_SHAPE] Edit ${index} field "old_range" must be a pair of anchor strings [start, end].`,
		);
	}
	if (!("new_lines" in edit)) {
		throw new Error(`[E_BAD_SHAPE] Edit ${index} requires a "new_lines" field. Provide the replacement lines (use [] to delete).`);
	}
	if ("new_lines" in edit && !isStringArray(edit.new_lines)) {
		throw new Error(`[E_BAD_SHAPE] Edit ${index} field "new_lines" must be a string array.`);
	}
	if (!isStringPair(edit.old_range)) {
		throw new Error(
			`[E_BAD_OP] Edit ${index} requires an "old_range" pair of anchor strings [start, end].`,
		);
	}

}

export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
	const result: HashlineEdit[] = [];
	for (const [index, edit] of edits.entries()) {
		assertEditItem(edit as Record<string, unknown>, index);

		const replaceLines = hashlineParseText(edit.new_lines ?? null);
		const normalizedLines =
			replaceLines.length === 1 && replaceLines[0] === ""
				? []
				: replaceLines;
		result.push({
			old_range: [parseHashRef(edit.old_range![0]), parseHashRef(edit.old_range![1])],
			new_lines: normalizedLines,
		});
	}
	return result;
}

function maybeWarnSuspiciousUnicodeEscapePlaceholder(
	edits: HashlineEdit[],
	warnings: string[],
): void {
	for (const edit of edits) {
		if (edit.new_lines.some((line) => /\\uDDDD/i.test(line))) {
			warnings.push(
				"Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
			);
		}
	}
}

export function assertNoBareHashPrefixLines(
	edits: HashlineEdit[],
	fileLines: string[],
	fileHashes: string[],
): string[] {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`assertNoBareHashPrefixLines: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
	const suspects: { line: string; hash: string; editIndex: number; lineIndex: number }[] = [];
	for (let editIndex = 0; editIndex < edits.length; editIndex++) {
		const edit = edits[editIndex]!;
		for (let lineIndex = 0; lineIndex < edit.new_lines.length; lineIndex++) {
			const line = edit.new_lines[lineIndex]!;
			const match = line.match(HASHLINE_BARE_PREFIX_RE);
			if (match) suspects.push({ line, hash: match[1]!, editIndex, lineIndex });
		}
	}
	if (suspects.length === 0) return [];

	const fileHashSet = new Set(fileHashes);
	const matched = suspects.filter((s) => fileHashSet.has(s.hash));
	const matchedCount = matched.length;
	const exampleLine = `${suspects[0]!.hash}│${suspects[0]!.line}`;


	const linesHint =
		matchedCount === 0
			? `None match file line hashes.`
			: `${matchedCount} match file line hashes — likely a copied hash.`;

	throw new Error(
		`[E_BARE_HASH_PREFIX] ${suspects.length} edit line(s) start with a hash-like prefix (e.g. ${JSON.stringify(exampleLine)}). ${linesHint} Use literal file content in \"lines\" — never paste HASH│content from read output.`
	);
}


export function describeEdit(edit: ResolvedHashlineEdit): string {
	return `replace ${edit.old_range[0].hash}-${edit.old_range[1].hash}`;
}

export function validateAnchorEdits(
	edits: HashlineEdit[],
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): { resolved: ResolvedHashlineEdit[]; mismatches: HashMismatch[]; boundaryWarnings: BoundaryDuplicationWarning[] } {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`validateAnchorEdits: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
	const resolved: ResolvedHashlineEdit[] = [];
	const mismatches: HashMismatch[] = [];
	const boundaryWarnings: BoundaryDuplicationWarning[] = [];

	const tryResolve = (ref: Anchor): ResolvedAnchor | undefined => {
		const result = resolveAnchor(ref, fileLines, fileHashes);
		if ("kind" in result) {
			mismatches.push(result);
			return undefined;
		}
		return result;
	};


	for (const edit of edits) {
		throwIfAborted(signal);
		const startResolved = tryResolve(edit.old_range[0]);
		const endResolved = tryResolve(edit.old_range[1]);
		if (!startResolved || !endResolved) {
			continue;
		}
		if (startResolved.line > endResolved.line) {
			throw new Error(
				`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.old_range[0].hash} and ${edit.old_range[1].hash}).`,
			);
		}
		const endLine = endResolved.line;
		const nextLine = fileLines[endLine];
		const replacementLastLine = edit.new_lines.at(-1);
		if (
			nextLine !== undefined &&
			replacementLastLine !== undefined &&
			replacementLastLine.length > 0 &&
			replacementLastLine === nextLine
		) {
			boundaryWarnings.push({
				kind: "trailing",
				survivingLineContent: nextLine,
				survivingLineIndex: endLine,
				occurrence: fileLines.slice(0, endLine).filter(l => l === nextLine).length,
				replacementLineContent: replacementLastLine,
				editIndex: resolved.length,
			});
		}
		const prevLine = fileLines[startResolved.line - 2];
		const replacementFirstLine = edit.new_lines[0];
		if (
			prevLine !== undefined &&
			replacementFirstLine !== undefined &&
			replacementFirstLine.length > 0 &&
			replacementFirstLine === prevLine
		) {
			boundaryWarnings.push({
				kind: "leading",
				survivingLineContent: prevLine,
				survivingLineIndex: startResolved.line - 2,
				occurrence: fileLines.slice(0, startResolved.line - 2).filter(l => l === prevLine).length,
				replacementLineContent: replacementFirstLine,
				editIndex: resolved.length,
			});
		}
		resolved.push({
			old_range: [startResolved, endResolved],
			new_lines: edit.new_lines,
		});
	}

	return { resolved, mismatches, boundaryWarnings };
}

export { maybeWarnSuspiciousUnicodeEscapePlaceholder };
