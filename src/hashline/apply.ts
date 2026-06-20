
import { throwIfAborted } from "../runtime";
import { computeLineHashes } from "./hash";
import {
	validateAnchorEdits,
	assertNoBareHashPrefixLines,
	maybeWarnSuspiciousUnicodeEscapePlaceholder,
	formatMismatchError,
	describeEdit,
	type ResolvedHashlineEdit,
	type NoopEdit,
	type HashlineEdit,
	type BoundaryDuplicationWarning,
} from "./resolve";
import { countVisibleLines } from "../utils";


type LineIndex = {
	fileLines: string[];
	lineStarts: number[];
	hasTerminalNewline: boolean;
};

export function buildLineIndex(content: string): LineIndex {
	const fileLines = content.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;

	for (let index = 0; index < fileLines.length; index++) {
		lineStarts.push(offset);
		offset += fileLines[index]!.length;
		if (index < fileLines.length - 1) {
			offset += 1;
		}
	}

	return {
		fileLines,
		lineStarts,
		hasTerminalNewline: content.endsWith("\n"),
	};
}


type ResolvedEditSpan = {
	kind: "replace";
	index: number;
	label: string;
	start: number;
	end: number;
	replacement: string;
};

function assertDoesNotEmptyFile(originalContent: string, result: string): void {
	if (originalContent.length > 0 && result.length === 0) {
		throw new Error(
			"[E_WOULD_EMPTY] Cannot empty a non-empty file via edit."
		);
	}
}


function throwEditConflict(
	left: { index: number; label: string },
	right: { index: number; label: string },
	reason: string,
): never {
	throw new Error(
		`[E_EDIT_CONFLICT] Edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}.`
	);
}


function resolveEditToSpan(
	edit: ResolvedHashlineEdit,
	index: number,
	content: string,
	lineIndex: LineIndex,
	noopEdits: NoopEdit[],
): ResolvedEditSpan | null {
	const { fileLines, lineStarts, hasTerminalNewline } = lineIndex;

	const startLine = edit.old_range[0].line;
	const endLine = edit.old_range[1].line;
	const originalLines = fileLines.slice(startLine - 1, endLine);
	if (
		originalLines.length === edit.new_lines.length &&
		originalLines.every(
			(line, lineIndex) => line === edit.new_lines[lineIndex],
		)
	) {
		noopEdits.push({
			editIndex: index,
			loc: edit.old_range[0].hash,
			currentContent: originalLines.join("\n"),
		});
		return null;
	}

	if (edit.new_lines.length > 0) {
		return {
			kind: "replace",
			index,
			label: describeEdit(edit),
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
			replacement: edit.new_lines.join("\n"),
		};
	}

	if (startLine === 1 && endLine === fileLines.length) {
		return {
			kind: "replace",
			index,
			label: describeEdit(edit),
			start: 0,
			end: content.length,
			replacement: "",
		};
	}

	if (endLine < fileLines.length) {
		return {
			kind: "replace",
			index,
			label: describeEdit(edit),
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine]!,
			replacement: "",
		};
	}

	return {
		kind: "replace",
		index,
		label: describeEdit(edit),
		start: Math.max(0, lineStarts[startLine - 1]! - 1),
		end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
		replacement: "",
	};
}

function assertNoConflictingSpans(spans: ResolvedEditSpan[]): void {
	for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
		const left = spans[leftIndex]!;
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < spans.length;
			rightIndex++
		) {
			const right = spans[rightIndex]!;

			if (left.start < right.end && right.start < left.end) {
				throwEditConflict(
					left,
					right,
					"overlap on the same original line range",
				);
			}
		}
	}
}

function resolveEditSpans(
	edits: ResolvedHashlineEdit[],
	content: string,
	lineIndex: LineIndex,
	noopEdits: NoopEdit[],
	signal: AbortSignal | undefined,
): ResolvedEditSpan[] {
	const seenSpanKeys = new Set<string>();
	const resolvedSpans: ResolvedEditSpan[] = [];
	for (const [index, edit] of edits.entries()) {
		throwIfAborted(signal);
		const span = resolveEditToSpan(
			edit,
			index,
			content,
			lineIndex,
			noopEdits,
		);
		if (!span) {
			continue;
		}

		const spanKey =
				`replace:${span.start}:${span.end}:${span.replacement}`;
		if (seenSpanKeys.has(spanKey)) {
			continue;
		}
		seenSpanKeys.add(spanKey);
		resolvedSpans.push(span);
	}

	assertNoConflictingSpans(resolvedSpans);
	return [...resolvedSpans].sort((left, right) => {
		if (right.end !== left.end) {
			return right.end - left.end;
		}
		return left.index - right.index;
	});
}

function assembleEditResult(
	content: string,
	spans: ResolvedEditSpan[],
	signal: AbortSignal | undefined,
): string {
	let result = content;
	for (const span of spans) {
		throwIfAborted(signal);
		result =
			result.slice(0, span.start) + span.replacement + result.slice(span.end);
	}
	return result;
}


export function applyHashlineEdits(
	content: string,
	edits: import("./resolve").HashlineEdit[],
	signal?: AbortSignal,
	precomputedHashes?: string[],
): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: NoopEdit[];
} {
	throwIfAborted(signal);
	if (!edits.length)
		return {
			content,
			firstChangedLine: undefined,
			lastChangedLine: undefined,
		};

	// Normalize new_lines: [""] to new_lines: [] for deletion.
	edits = edits.map((edit) =>
		edit.new_lines.length === 1 &&
		edit.new_lines[0] === ""
			? { ...edit, new_lines: [] }
			: edit,
	);

	const lineIndex = buildLineIndex(content);
	const fileHashes = precomputedHashes ?? computeLineHashes(content);
	const noopEdits: NoopEdit[] = [];
	const warnings: string[] = [];

	const { resolved, mismatches, boundaryWarnings } = validateAnchorEdits(
		edits,
		lineIndex.fileLines,
		fileHashes,
		warnings,
		signal,
	);
	if (mismatches.length) {
		throw new Error(
			formatMismatchError(mismatches, lineIndex.fileLines, fileHashes),
		);
	}

	const barePrefixWarnings = assertNoBareHashPrefixLines(edits, lineIndex.fileLines, fileHashes);
	warnings.push(...barePrefixWarnings);
	maybeWarnSuspiciousUnicodeEscapePlaceholder(edits, warnings);

	const orderedSpans = resolveEditSpans(
		resolved,
		content,
		lineIndex,
		noopEdits,
		signal,
	);

	const result = assembleEditResult(content, orderedSpans, signal);
	assertDoesNotEmptyFile(content, result);
	const changedRange = computeChangedLineRange(content, result);

	// Reconstruct boundary duplication warnings with post-edit hashes.
	// Use position + occurrence to find the exact surviving line (handles
	// files with multiple identical lines like several `}` closings).
	const resultLines = result.split("\n");
	const resultHashes = computeLineHashes(result);
	for (const bw of boundaryWarnings) {
		let seen = 0;
		let matchIndex = -1;
		for (let i = 0; i < resultLines.length; i++) {
			if (resultLines[i] === bw.survivingLineContent) {
				if (seen === bw.occurrence) { matchIndex = i; break; }
				seen++;
			}
		}
		if (matchIndex >= 0) {
			const hash = resultHashes[matchIndex];
			if (bw.kind === "trailing") {
				warnings.push(
					`Potential boundary duplication: the last line of the replacement (${JSON.stringify(bw.replacementLineContent)}) matches the next surviving line. Surviving line hash: ${hash}`
				);
			} else {
				warnings.push(
					`Potential boundary duplication: the first line of the replacement (${JSON.stringify(bw.replacementLineContent)}) matches the preceding surviving line. Surviving line hash: ${hash}`
				);
			}
		}
	}

	return {
		content: result,
		firstChangedLine: changedRange?.firstChangedLine,
		lastChangedLine: changedRange?.lastChangedLine,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
	};
}


const ANCHOR_CONTEXT_LINES = 0;
const ANCHOR_MAX_OUTPUT_LINES = 12;

export function computeAffectedLineRange(params: {
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	resultLineCount: number;
	contextLines?: number;
	maxOutputLines?: number;
}): { start: number; end: number } | null {
	const {
		firstChangedLine,
		lastChangedLine,
		resultLineCount,
		contextLines = ANCHOR_CONTEXT_LINES,
		maxOutputLines = ANCHOR_MAX_OUTPUT_LINES,
	} = params;

	if (firstChangedLine === undefined || lastChangedLine === undefined) {
		return null;
	}

	// When contextLines is 0, skip the anchor block entirely.
	// The LLM already knows what it changed and can call read for fresh anchors.
	if (contextLines === 0) {
		return null;
	}

	if (resultLineCount === 0) {
		return null;
	}

	const start = Math.max(1, firstChangedLine - contextLines);
	const end = Math.min(resultLineCount, lastChangedLine + contextLines);

	if (end < start) {
		return null;
	}

	if (end - start + 1 > maxOutputLines) {
		return null;
	}

	return { start, end };
}

export function formatHashlineRegion(
	hashes: string[],
	lines: string[],
): string {
	if (hashes.length !== lines.length) {
		throw new Error(
			`formatHashlineRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`,
		);
	}
	return lines
		.map((line, index) => `${hashes[index]}│${line}`)
		.join("\n");
}


export function computeChangedLineRange(
	original: string,
	result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
	if (original === result) return null;


	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: countVisibleLines(result),
		};
	}

	if (result.startsWith(original) && original.endsWith("\n")) {
		return {
			firstChangedLine: countVisibleLines(original) + 1,
			lastChangedLine: countVisibleLines(result),
		};
	}

	let firstDiff = 0;
	const minLen = Math.min(original.length, result.length);
	while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) {
		firstDiff++;
	}
	if (firstDiff === minLen && original.length === result.length) return null;

	let lastOrig = original.length - 1;
	let lastRes = result.length - 1;
	while (
		lastOrig >= firstDiff &&
		lastRes >= firstDiff &&
		original[lastOrig] === result[lastRes]
	) {
		lastOrig--;
		lastRes--;
	}

	function indexToLine(charIdx: number, text: string): number {
		let line = 1;
		for (let i = 0; i < charIdx && i < text.length; i++) {
			if (text[i] === "\n") line++;
		}
		return line;
	}

	const firstChangedLine = indexToLine(firstDiff + 1, result);
	let lastChangedLine: number;
	if (lastRes < firstDiff) {
		lastChangedLine = result.length === 0 ? 1 : countVisibleLines(result);
	} else if (
		firstDiff === 0 &&
		original.length > 0 &&
		result.endsWith(original)
	) {
		lastChangedLine = firstChangedLine;
	} else {
		lastChangedLine = indexToLine(lastRes + 1, result);
	}

	return { firstChangedLine, lastChangedLine };
}

