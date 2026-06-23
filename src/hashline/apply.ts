import { abortIf } from "../runtime";
import { lineHashes } from "./hash";
import {
	valEdits,
	assertNoBarePrefix,
	warnUnicodeEsc,
	fmtMismatch,
	descEdit,
	type RHEdit,
	type NEdit,
	type HEdit,
	type BDupWarn,
} from "./resolve";
import { cntLines } from "../utils";
import { CTX_LINES, MAX_OUT } from "../constants";

type LIdx = {
	fileLines: string[];
	lineStarts: number[];
	hasTerminalNewline: boolean;
};

export function buildIdx(content: string): LIdx {
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

type RESpan = {
	kind: "replace";
	index: number;
	label: string;
	start: number;
	end: number;
	replacement: string;
};

function assertNotEmpty(originalContent: string, result: string): void {
	if (originalContent.length > 0 && result.length === 0) {
		throw new Error(
			"[E_WOULD_EMPTY] Cannot empty a non-empty file via edit."
		);
	}
}

function throwConflict(
	left: { index: number; label: string },
	right: { index: number; label: string },
	reason: string,
): never {
	throw new Error(
		`[E_EDIT_CONFLICT] Edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}.`
	);
}

function resToSpan(
	edit: RHEdit,
	index: number,
	content: string,
	lineIndex: LIdx,
	noopEdits: NEdit[],
): RESpan | null {
	const { fileLines, lineStarts, hasTerminalNewline } = lineIndex;

	const startLine = edit.hash_range_incl[0].line;
	const endLine = edit.hash_range_incl[1].line;
	const originalLines = fileLines.slice(startLine - 1, endLine);
	if (
		originalLines.length === edit.new_lines.length &&
		originalLines.every(
			(line, lineIndex) => line === edit.new_lines[lineIndex],
		)
	) {
		noopEdits.push({
			editIndex: index,
			loc: edit.hash_range_incl[0].hash,
			currentContent: originalLines.join("\n"),
		});
		return null;
	}

	if (edit.new_lines.length > 0) {
		return {
			kind: "replace",
			index,
			label: descEdit(edit),
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
			replacement: edit.new_lines.join("\n"),
		};
	}

	if (startLine === 1 && endLine === fileLines.length) {
		return {
			kind: "replace",
			index,
			label: descEdit(edit),
			start: 0,
			end: content.length,
			replacement: "",
		};
	}

	if (endLine < fileLines.length) {
		return {
			kind: "replace",
			index,
			label: descEdit(edit),
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine]!,
			replacement: "",
		};
	}

	return {
		kind: "replace",
		index,
		label: descEdit(edit),
		start: Math.max(0, lineStarts[startLine - 1]! - 1),
		end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
		replacement: "",
	};
}

function assertNoConflict(spans: RESpan[]): void {
	for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
		const left = spans[leftIndex]!;
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < spans.length;
			rightIndex++
		) {
			const right = spans[rightIndex]!;

			if (left.start < right.end && right.start < left.end) {
				throwConflict(
					left,
					right,
					"overlap on the same original line range",
				);
			}
		}
	}
}

function resSpans(
	edits: RHEdit[],
	content: string,
	lineIndex: LIdx,
	noopEdits: NEdit[],
	signal: AbortSignal | undefined,
): RESpan[] {
	const seenSpanKeys = new Set<string>();
	const resolvedSpans: RESpan[] = [];
	for (const [index, edit] of edits.entries()) {
	abortIf(signal);
		const span = resToSpan(
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

	assertNoConflict(resolvedSpans);
	return [...resolvedSpans].sort((left, right) => {
		if (right.end !== left.end) {
			return right.end - left.end;
		}
		return left.index - right.index;
	});
}

function assemble(
	content: string,
	spans: RESpan[],
	signal: AbortSignal | undefined,
): string {
	let result = content;
	for (const span of spans) {
		abortIf(signal);
		result =
			result.slice(0, span.start) + span.replacement + result.slice(span.end);
	}
	return result;
}

export function applyEdits(
	content: string,
	edits: import("./resolve").HEdit[],
	signal?: AbortSignal,
	precomputedHashes?: string[],
	filePath?: string,
	): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: NEdit[];
} {
	abortIf(signal);
	if (!edits.length)
		return {
			content,
			firstChangedLine: undefined,
			lastChangedLine: undefined,
		};

	edits = edits.map((edit) =>
		edit.new_lines.length === 1 &&
		edit.new_lines[0] === ""
			? { ...edit, new_lines: [] }
			: edit,
	);

	const lineIndex = buildIdx(content);
	const fileHashes = precomputedHashes ?? lineHashes(content);
	const noopEdits: NEdit[] = [];
	const warnings: string[] = [];

	const { resolved, mismatches, boundaryWarnings } = valEdits(
		edits,
		lineIndex.fileLines,
		fileHashes,
		warnings,
		signal,
	);
	if (mismatches.length) {
		throw new Error(
			fmtMismatch(mismatches, lineIndex.fileLines, fileHashes, filePath),
		);
	}

	assertNoBarePrefix(edits, lineIndex.fileLines, fileHashes);
	warnUnicodeEsc(edits, warnings);

	const orderedSpans = resSpans(
		resolved,
		content,
		lineIndex,
		noopEdits,
		signal,
	);

	const result = assemble(content, orderedSpans, signal);
	assertNotEmpty(content, result);
	const range = changedRange(content, result);

	const resultLines = result.split("\n");
	const resultHashes = lineHashes(result);
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
		firstChangedLine: range?.firstChangedLine,
		lastChangedLine: range?.lastChangedLine,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
	};
}

export function affRange(params: {
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
		contextLines = CTX_LINES,
		maxOutputLines = MAX_OUT,
	} = params;

	if (firstChangedLine === undefined || lastChangedLine === undefined) {
		return null;
	}

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

export function fmtRegion(
	hashes: string[],
	lines: string[],
): string {
	if (hashes.length !== lines.length) {
		throw new Error(
			`fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`,
		);
	}
	return lines
		.map((line, index) => `${hashes[index]}│${line}`)
		.join("\n");
}

export function changedRange(
	original: string,
	result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
	if (original === result) return null;

	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: cntLines(result),
		};
	}

	if (result.startsWith(original) && original.endsWith("\n")) {
		return {
			firstChangedLine: cntLines(original) + 1,
			lastChangedLine: cntLines(result),
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

	function idxToLine(charIdx: number, text: string): number {
		let line = 1;
		for (let i = 0; i < charIdx && i < text.length; i++) {
			if (text[i] === "\n") line++;
		}
		return line;
	}

	const firstChangedLine = idxToLine(firstDiff + 1, result);
	let lastChangedLine: number;
	if (lastRes < firstDiff) {
		lastChangedLine = result.length === 0 ? 1 : cntLines(result);
	} else if (
		firstDiff === 0 &&
		original.length > 0 &&
		result.endsWith(original)
	) {
		lastChangedLine = firstChangedLine;
	} else {
		lastChangedLine = idxToLine(lastRes + 1, result);
	}

	return { firstChangedLine, lastChangedLine };
}