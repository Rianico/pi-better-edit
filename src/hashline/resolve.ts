import { abortIf, rejectUnknownFields, lastNonEmpty, firstNonEmpty, clipLine } from "../utils";
import { HL_BARE_PREFIX_RE, HL_PREFIX_PLUS_RE, HL_PREFIX_MINUS_RE } from "./hash";
import { parseHashRef, parseText, type Anchor } from "./parse";
import { CONTENT_LINES_NOT_STRING_MSG } from "../constants";

export type RAnchor = {
	line: number;
	hash: string;
	hashMatched: boolean;
};

export type HEdit = { content_lines: string[]; hash_range_inclusive: [Anchor, Anchor] };
export type RHEdit = {
  content_lines: string[];
  hash_range_inclusive: [RAnchor, RAnchor];
};

interface HMismatch {
	ref: Anchor;
	kind: "not_found" | "ambiguous";
	candidates?: number[];
	context?: RAnchor;
}

export interface BDupWarn {
	kind: "trailing" | "leading";
	survivingLineContent: string;
	survivingLineIndex: number;
	replacementLineContent: string;
}

export interface AutoFix {
  kind: "trailing" | "leading";
  removedLine: string;
}

export interface NEdit {
	loc: string;
	currentContent: string;
}

export type HTEdit = {
  content_lines: string[];
  hash_range_inclusive: [string, string];
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

export function fmtMismatch(
  mismatches: HMismatch[],
  fileLines: string[],
  fileHashes: string[],
  filePath?: string,
): string {
  assertAligned(fileLines, fileHashes, "fmtMismatch");

  const out: string[] = [];
  const notFound = mismatches.filter((m) => m.kind === "not_found");
  const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");

  const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
  if (notFound.length > 0) {
    out.push(
      `[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. The file content has changed since those anchors were read. Call read() to get fresh anchors, then copy the 3-char HASH of the start and end of the range you are replacing into hash_range_inclusive of your next replace call.`
    );
    for (const m of notFound) {
      const ctx = m.context;
      if (!ctx) continue;
      const from = Math.max(1, ctx.line - 1);
      const to = Math.min(fileLines.length, ctx.line + 1);
      const rows: string[] = [];
      for (let ln = from; ln <= to; ln++) {
        rows.push(`    ${ln}: ${fileHashes[ln - 1]}│${clipLine(fileLines[ln - 1] ?? "")}`);
      }
      out.push("");
      out.push(`  Current context around resolved anchor "${ctx.hash}" (line ${ctx.line}):\n${rows.join("\n")}`);
    }
  }
  if (ambiguous.length > 0) {
    if (out.length > 0) out.push("");
    out.push(
      `[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}. Call read() to get fresh anchors, then copy the 3-char HASH of the start and end of the range you are replacing into hash_range_inclusive of your next replace call.`
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

const ITEM_KS = new Set(["content_lines", "hash_range_inclusive"]);

function isStrArr(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isStrPair(value: unknown): value is [string, string] {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		value.every((item) => typeof item === "string")
	);
}

function assertItem(edit: Record<string, unknown>): void {
  rejectUnknownFields(edit, ITEM_KS, "Edit", "The edit takes only { content_lines, hash_range_inclusive }.");

  if ("hash_range_inclusive" in edit && !isStrPair(edit.hash_range_inclusive)) {
    throw new Error(
      `[E_BAD_SHAPE] Field "hash_range_inclusive" must be a pair of anchor strings [start, end].`,
    );
  }
  if (!("content_lines" in edit)) {
    throw new Error(`[E_BAD_SHAPE] The edit requires a "content_lines" field. Provide the replacement lines (use [] to delete).`);
  }
  if ("content_lines" in edit && !isStrArr(edit.content_lines)) {
    const val = edit.content_lines;
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          edit.content_lines = parsed;
        } else {
          throw new Error(CONTENT_LINES_NOT_STRING_MSG);
        }
      } catch {
        throw new Error(CONTENT_LINES_NOT_STRING_MSG);
      }
    } else {
      throw new Error(`[E_BAD_SHAPE] Field "content_lines" must be a string array.`);
    }
  }
  if (!isStrPair(edit.hash_range_inclusive)) {
    throw new Error(
      `[E_BAD_SHAPE] The edit requires a "hash_range_inclusive" pair of anchor strings [start, end].`,
    );
  }
}

export function resEdit(edit: HTEdit): HEdit {
  assertItem(edit as Record<string, unknown>);

  const replaceLines = parseText(edit.content_lines);
  return {
    content_lines: replaceLines,
    hash_range_inclusive: [parseHashRef(edit.hash_range_inclusive[0]), parseHashRef(edit.hash_range_inclusive[1])],
  };
}

function warnUnicodeEsc(
  edit: HEdit,
  warnings: string[],
): void {
  if (edit.content_lines.some((line) => /\\uDDDD/i.test(line))) {
    warnings.push(
      "Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
    );
  }
}

export function stripBarePrefixes(
	edit: HEdit,
	fileHashes: string[],
	warnings: string[],
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
		.map((s) => `content_lines[${s.lineIndex}]`)
		.join(", ");
	const matchedCount = stripped.filter((s) => s.matched).length;
	const evidence =
		matchedCount === 0
			? "none of the stripped hashes match current file lines"
			: `${matchedCount} of ${stripped.length} stripped hash(es) match current file lines`;
	const guidance =
		matchedCount === 0
			? " Verify that these lines were pasted from read output; literal content starting with 'HASH│' would be altered by this strip."
			: "";
	warnings.push(
		`[E_BARE_HASH_PREFIX] Autocorrected: stripped "HASH│" prefix copied from read output in ${locations} (${evidence}).${guidance}`
	);
	return { ...edit, content_lines: contentLines };
}

export function stripDiffPrefixes(
	edit: HEdit,
	warnings: string[],
): HEdit {
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
	const locations = stripped.map((i) => `content_lines[${i}]`).join(", ");
	warnings.push(
		`[E_INVALID_PATCH] Autocorrected: stripped diff-preview marker copied from the diff preview in ${locations}.`
	);
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
	const [startRef, endRef] = edit.hash_range_inclusive;
	const startLine = lineByHash.get(startRef.hash);
	const endLine = lineByHash.get(endRef.hash);
	if (
		startLine === undefined ||
		endLine === undefined ||
		startLine <= endLine
	) {
		return edit;
	}
	warnings.push(
		`[E_BAD_OP] Autocorrected: hash_range_inclusive was reversed (start ${startRef.hash} is after end ${endRef.hash}); swapped the pair.`
	);
	return { ...edit, hash_range_inclusive: [endRef, startRef] as [Anchor, Anchor] };
}

function checkBoundaryDup(
	adjacentLine: string | undefined,
	replacementEdge: string | undefined,
	kind: "trailing" | "leading",
	survivingLineIndex: number,
): BDupWarn | null {
	if (
		adjacentLine === undefined ||
		replacementEdge === undefined ||
		replacementEdge.length === 0 ||
		replacementEdge !== adjacentLine
	) return null;
  return {
    kind,
    survivingLineContent: adjacentLine,
    survivingLineIndex,
    replacementLineContent: replacementEdge,
  };
}

export function valEdit(
	edit: HEdit,
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): { resolved: RHEdit | undefined; mismatches: HMismatch[]; boundaryWarnings: BDupWarn[] } {
	assertAligned(fileLines, fileHashes, "valEdit");
	const mismatches: HMismatch[] = [];
	const boundaryWarnings: BDupWarn[] = [];

	const hashIndex = new Map<string, number[]>();
	for (let i = 0; i < fileHashes.length; i++) {
		const h = fileHashes[i]!;
		const list = hashIndex.get(h) ?? [];
		list.push(i + 1);
		hashIndex.set(h, list);
	}

	const tryResolve = (ref: Anchor): RAnchor | undefined => {
		const result = resAnchorFromMap(ref, hashIndex);
		if ("kind" in result) {
			mismatches.push(result);
			return undefined;
		}
		return result;
	};

	abortIf(signal);
	const startResolved = tryResolve(edit.hash_range_inclusive[0]);
	const endResolved = tryResolve(edit.hash_range_inclusive[1]);
	if (!startResolved || !endResolved) {
		if (!startResolved && endResolved) {
			const startMismatch = mismatches.findLast((m) => m.ref === edit.hash_range_inclusive[0]);
			if (startMismatch && startMismatch.kind === "not_found") startMismatch.context = endResolved;
		} else if (startResolved && !endResolved) {
			const endMismatch = mismatches.findLast((m) => m.ref === edit.hash_range_inclusive[1]);
			if (endMismatch && endMismatch.kind === "not_found") endMismatch.context = startResolved;
		}
		return { resolved: undefined, mismatches, boundaryWarnings };
	}
	if (startResolved.line > endResolved.line) {
		throw new Error(
			`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.hash_range_inclusive[0].hash} and ${edit.hash_range_inclusive[1].hash}).`,
		);
	}
	const endLine = endResolved.line;
	const nextLine = fileLines[endLine];
	const replacementLastLine = lastNonEmpty(edit.content_lines);
	const trailing = checkBoundaryDup(nextLine, replacementLastLine, "trailing", endLine);
	if (trailing) boundaryWarnings.push(trailing);
	const prevLine = fileLines[startResolved.line - 2];
	const replacementFirstLine = firstNonEmpty(edit.content_lines);
	const leading = checkBoundaryDup(prevLine, replacementFirstLine, "leading", startResolved.line - 2);
	if (leading) boundaryWarnings.push(leading);

	return {
		resolved: {
			content_lines: edit.content_lines,
			hash_range_inclusive: [startResolved, endResolved],
		},
		mismatches,
		boundaryWarnings,
	};
}

export { warnUnicodeEsc };
