import { abortIf, rejectUnknownFields, lastNonEmpty, firstNonEmpty, firstNonEmptyIndex, lastNonEmptyIndex, clipLine } from "../utils";
import { HASH_CLASS, HL_BARE_PREFIX_RE, HL_PREFIX_PLUS_RE, HL_PREFIX_MINUS_RE, canon } from "./hash";
import { parseHashRef, parseText, type Anchor } from "./parse";
import { NEW_CONTENT_NOT_STRING_MSG } from "../constants";

export type RAnchor = {
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

export interface BDup {
	kind: "trailing" | "leading" | "first-new-after" | "last-new-before";
	replacementLineIndex: number;
}

export interface AutoFix {
	kind: "trailing" | "leading" | "first-new-after" | "last-new-before";
	removedLine: string;
	removedLineIndex: number;
}

export interface NEdit {
	loc: string;
	currentContent: string;
}

export type HTEdit = {
  new_content: string;
  hash_bounds: [string, string];
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
      `[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. The file content has changed since those anchors were read. Call read() to get fresh anchors, then copy the 3-char HASH of the start and end of the range you are replacing into hash_bounds of your next replace call.`
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
      `[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}. Call read() to get fresh anchors, then copy the 3-char HASH of the start and end of the range you are replacing into hash_bounds of your next replace call.`
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

const ITEM_KS = new Set(["new_content", "hash_bounds"]);

function isStrPair(value: unknown): value is [string, string] {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		value.every((item) => typeof item === "string")
	);
}

function assertItem(edit: Record<string, unknown>): void {
  rejectUnknownFields(edit, ITEM_KS, "Edit", "The edit takes only { new_content, hash_bounds }.");

  if ("hash_bounds" in edit && !isStrPair(edit.hash_bounds)) {
    throw new Error(
      `[E_BAD_SHAPE] Field "hash_bounds" must be a pair of anchor strings [start, end].`,
    );
  }
  if (!("new_content" in edit)) {
    throw new Error(`[E_BAD_SHAPE] The edit requires a "new_content" field. Provide the replacement text (use "" to delete).`);
  }
  if (typeof edit.new_content !== "string") {
    throw new Error(NEW_CONTENT_NOT_STRING_MSG);
  }
  if (!isStrPair(edit.hash_bounds)) {
    throw new Error(
      `[E_BAD_SHAPE] The edit requires a "hash_bounds" pair of anchor strings [start, end].`,
    );
  }
}

const ANCHOR_ROW_RE = new RegExp(`^([+-]?)(${HASH_CLASS})│`);

export function resEdit(edit: HTEdit, warnings?: string[]): HEdit {
  assertItem(edit as Record<string, unknown>);

  const replaceLines = parseText(edit.new_content);
  const bounds = edit.hash_bounds.map((ref) => {
    const trimmed = ref.trim();
    const match = trimmed.match(ANCHOR_ROW_RE);
    if (match) {
      let message: string;
      if (match[1] === "+") {
        message = `[E_BAD_REF] Autocorrected: stripped diff-preview marker copied from the diff preview in hash_bounds entry "${trimmed}".`;
      } else if (match[1] === "-") {
        message = `[E_BAD_REF] Autocorrected: stripped leading "-" marker in hash_bounds entry "${trimmed}".`;
      } else {
        message = `[E_BAD_REF] Autocorrected: stripped "HASH│" prefix copied from read output in hash_bounds entry "${trimmed}".`;
      }
      warnings?.push(message);
      return match[2]!;
    }
    return ref;
  }) as [string, string];
  return {
    content_lines: replaceLines,
    hash_bounds: [parseHashRef(bounds[0]), parseHashRef(bounds[1])],
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
		.map((s) => `new_content line ${s.lineIndex + 1}`)
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
	const locations = stripped.map((i) => `new_content line ${i + 1}`).join(", ");
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
	const [startRef, endRef] = edit.hash_bounds;
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
		`[E_BAD_OP] Autocorrected: hash_bounds was reversed (start ${startRef.hash} is after end ${endRef.hash}); swapped the pair.`
	);
	return { ...edit, hash_bounds: [endRef, startRef] as [Anchor, Anchor] };
}

function edgeRef(
	line: string | undefined,
	index: number,
): { index: number; line: string } | undefined {
	return line === undefined ? undefined : { index, line };
}

function checkBoundaryDup(
	adjacentLine: string | undefined,
	replacementEdge: { index: number; line: string } | undefined,
	kind: BDup["kind"],
	canonical = false,
	uniqueInFile?: Map<string, number>,
): BDup | null {
	if (
		adjacentLine === undefined ||
		replacementEdge === undefined ||
		replacementEdge.line.length === 0
	) {
		return null;
	}
	const matches = canonical
		? canon(adjacentLine) === canon(replacementEdge.line)
		: adjacentLine === replacementEdge.line;
	if (!matches) return null;
	if (uniqueInFile && (uniqueInFile.get(canon(adjacentLine)) ?? 0) !== 1) {
		return null;
	}
	return {
		kind,
		replacementLineIndex: replacementEdge.index,
	};
}

function canonCounts(lines: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of lines) {
		const key = canon(line);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

export function findNewEdge(
	contentLines: string[],
	rangeLines: string[],
	fromEnd: boolean,
): { index: number; line: string } | undefined {
	const multiset = canonCounts(rangeLines);
	const step = fromEnd ? -1 : 1;
	const start = fromEnd ? contentLines.length - 1 : 0;
	for (let i = start; i >= 0 && i < contentLines.length; i += step) {
		const line = contentLines[i]!;
		if (line.length === 0) continue;
		const key = canon(line);
		const count = multiset.get(key) ?? 0;
		if (count > 0) {
			multiset.set(key, count - 1);
		} else {
			return { index: i, line };
		}
	}
	return undefined;
}

function newEdgeLines(
	contentLines: string[],
	rangeLines: string[],
): { firstNew: { index: number; line: string } | undefined; lastNew: { index: number; line: string } | undefined } {
	return {
		firstNew: findNewEdge(contentLines, rangeLines, false),
		lastNew: findNewEdge(contentLines, rangeLines, true),
	};
}

export function valEdit(
	edit: HEdit,
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): { resolved: RHEdit | undefined; mismatches: HMismatch[]; boundaryDups: BDup[] } {
	assertAligned(fileLines, fileHashes, "valEdit");
	const mismatches: HMismatch[] = [];
	const boundaryDups: BDup[] = [];

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
	const startResolved = tryResolve(edit.hash_bounds[0]);
	const endResolved = tryResolve(edit.hash_bounds[1]);
	if (!startResolved || !endResolved) {
		if (!startResolved && endResolved) {
			const startMismatch = mismatches.findLast((m) => m.ref === edit.hash_bounds[0]);
			if (startMismatch && startMismatch.kind === "not_found") startMismatch.context = endResolved;
		} else if (startResolved && !endResolved) {
			const endMismatch = mismatches.findLast((m) => m.ref === edit.hash_bounds[1]);
			if (endMismatch && endMismatch.kind === "not_found") endMismatch.context = startResolved;
		}
		return { resolved: undefined, mismatches, boundaryDups };
	}
	if (startResolved.line > endResolved.line) {
		throw new Error(
			`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.hash_bounds[0].hash} and ${edit.hash_bounds[1].hash}).`,
		);
	}
	const endLine = endResolved.line;
	const nextLine = fileLines[endLine];
	const replacementLastLine = lastNonEmpty(edit.content_lines);
	const trailing = checkBoundaryDup(nextLine, edgeRef(replacementLastLine, lastNonEmptyIndex(edit.content_lines)), "trailing");
	if (trailing) boundaryDups.push(trailing);
	const prevLine = fileLines[startResolved.line - 2];
	const replacementFirstLine = firstNonEmpty(edit.content_lines);
	const leading = checkBoundaryDup(prevLine, edgeRef(replacementFirstLine, firstNonEmptyIndex(edit.content_lines)), "leading");
	if (leading) boundaryDups.push(leading);
	const rangeLines = fileLines.slice(startResolved.line - 1, endLine);
	const { firstNew, lastNew } = newEdgeLines(edit.content_lines, rangeLines);
	const fileCounts = canonCounts(fileLines);
	const firstNewAfter = checkBoundaryDup(nextLine, firstNew, "first-new-after", true, fileCounts);
	if (firstNewAfter) boundaryDups.push(firstNewAfter);
	const lastNewBefore = checkBoundaryDup(prevLine, lastNew, "last-new-before", true, fileCounts);
	if (lastNewBefore) boundaryDups.push(lastNewBefore);

	return {
		resolved: {
			content_lines: edit.content_lines,
			hash_bounds: [startResolved, endResolved],
		},
		mismatches,
		boundaryDups,
	};
}

export { warnUnicodeEsc };
