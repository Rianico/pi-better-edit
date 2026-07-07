import { abortIf } from "../runtime";
import { lineHashes, HASH_SEP } from "./hash";
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
};

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

  const startLine = edit.hash_range_inclusive[0].line;
  const endLine = edit.hash_range_inclusive[1].line;
  const originalLines = fileLines.slice(startLine - 1, endLine);
  if (
    originalLines.length === edit.content_lines.length &&
    originalLines.every(
      (line, lineIndex) => line === edit.content_lines[lineIndex],
    )
  ) {
    noopEdits.push({
      editIndex: index,
      loc: edit.hash_range_inclusive[0].hash,
      currentContent: originalLines.join("\n"),
    });
    return null;
  }

  const label = descEdit(edit);

  if (edit.content_lines.length > 0) {
    return {
      kind: "replace",
      index,
      label,
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
      replacement: edit.content_lines.join("\n"),
    };
  }

  if (startLine === 1 && endLine === fileLines.length) {
    return {
      kind: "replace",
      index,
      label,
      start: 0,
      end: content.length,
      replacement: "",
    };
  }

  if (endLine < fileLines.length) {
    return {
      kind: "replace",
      index,
      label,
      start: lineStarts[startLine - 1]!,
      end: lineStarts[endLine]!,
      replacement: "",
    };
  }

  return {
    kind: "replace",
    index,
    label,
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

/**
 * Builds the boundary-duplication warning shown after an edit. A minimal header
 * is followed by a hashline-anchored window: 2 lines of context before the
 * duplicated pair, the pair itself, and 2 lines after. The window carries the
 * post-edit hashes the model needs to remove the duplicate in a follow-up
 * `replace` (no `read` round-trip required, since the hashes are current and
 * staleness is per-line). Rows are plain `HASH│content` — no annotations.
 */
export function fmtBoundaryWarning(params: {
	kind: "trailing" | "leading";
	survivingContent: string;
	matchIndex: number;
	resultLines: string[];
	resultHashes: string[];
}): string {
	const header =
		params.kind === "trailing"
			? "Boundary duplication (trailing): the last replacement line duplicated the next line. This happens when `content_lines` includes a line that was already outside the replaced range. Delete the duplicate — the original line outside the range is still there."
			: "Boundary duplication (leading): the first replacement line duplicated the previous line. This happens when `content_lines` includes a line that was already outside the replaced range. Delete the duplicate — the original line outside the range is still there.";

	// Locate the adjacent duplicated pair (two identical neighboring lines). The
	// occurrence-based matchIndex usually lands inside the pair; when a file has
	// several identical lines we pick the pair nearest matchIndex so the window
	// frames the duplication this edit introduced, not an unrelated one.
	let pairStart = -1;
	let bestDist = Infinity;
	for (let i = 0; i < params.resultLines.length - 1; i++) {
		if (
			params.resultLines[i] === params.survivingContent &&
			params.resultLines[i + 1] === params.survivingContent
		) {
			const dist = Math.abs(i - params.matchIndex);
			if (dist < bestDist) {
				bestDist = dist;
				pairStart = i;
			}
		}
	}
	if (pairStart < 0) pairStart = params.matchIndex;

	const winStart = Math.max(0, pairStart - 2);
	const winEnd = Math.min(params.resultLines.length - 1, pairStart + 3);

	const rows: string[] = [];
	for (let i = winStart; i <= winEnd; i++) {
		rows.push(`${params.resultHashes[i]}${HASH_SEP}${params.resultLines[i]}`);
	}
	return `${header}\n\n${rows.join("\n")}`;
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
	resultHashes?: string[];
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
    edit.content_lines.length === 1 &&
    edit.content_lines[0] === ""
      ? { ...edit, content_lines: [] }
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
			warnings.push(
				fmtBoundaryWarning({
					kind: bw.kind,
					survivingContent: bw.survivingLineContent,
					matchIndex,
					resultLines,
					resultHashes,
				}),
			);
		}
	}

	return {
		content: result,
		firstChangedLine: range?.firstChangedLine,
		lastChangedLine: range?.lastChangedLine,
		resultHashes,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
	};
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
		.map((line, index) => `${hashes[index]}${HASH_SEP}${line}`)
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
