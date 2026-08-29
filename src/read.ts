import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createReadTool,
	formatSize,
	truncateHead,
	DEFAULT_MAX_LINES,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_READ_LINE_BYTES } from "./constants.js";
import { loadFileKindAndText } from "./file-kind.js";
import { loadHashStore } from "./hash-store.js";
import { readNormFile } from "./file-reader.js";
import { lineHashes, fmtRegion, HASH_SEP, MAX_HASH_LINES } from "./hashline/index.js";
import type { ServedRow } from "./hashline/served.js";
import { toCwd } from "./paths.js";
import { sessionFromContext } from "./served-session/index.js";
import { abortIf, isRec, normalizeFilePath } from "./utils.js";
import { fileSnap } from "./file-reader.js";
import { visLines } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import { valAccess } from "./validation.js";

const R_DESC = loadP("../prompts/read.md");

const R_SNIPPET = loadP("../prompts/read-snippet.md");

function readGuide(): string[] {
	return loadGuide("../prompts/read-guidelines.md");
}

function normPosInt(
	value: number | undefined,
	name: "offset" | "limit",
): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!Number.isInteger(value) || value < 1) {
		throw new Error(
			`[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`,
		);
	}

	return value;
}

function formatPaginationHint(
	startLine: number,
	endLine: number,
	totalLines: number,
	nextOffset: number,
	byteLimit?: number,
): string {
	const sizeSuffix =
		byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
	return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}


async function emptyFilePreview(startLine: number, text: string, precomputedHashes: string[] | undefined, path: string | undefined, HASH_SEP: string): Promise<{ text: string; served: ServedRow[] }> {
  if (startLine === 1) {
    const allHashes = precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
    const emptyLineHash = allHashes[0]!;
    return { text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use edit to insert content.]`, served: [{ position: 0, hash: emptyLineHash }] };
  }
  return { text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use edit to insert content.`, served: [] };
}
function oversizedWarning(oversized: { lineNumber: number }[]): { lineLabel: string; verb: string; addresses: string } {
  const lineLabel = oversized.length === 1 ? `Line ${oversized[0]!.lineNumber}` : `Lines ${oversized.map((row) => row.lineNumber).join(", ")}`;
  const verb = oversized.length === 1 ? "exceeds" : "exceed";
  const addresses = oversized.map((row) => `${row.lineNumber}p`).join(";");
  return { lineLabel, verb, addresses };
}
function buildOversizedPreview(params: {
  rowSizes: { lineNumber: number; bytes: number }[];
  selected: string[];
  selectedHashes: string[];
  startLine: number;
  totalLines: number;
  maxBytes: number;
  maxTruncLines: number;
}): { text: string; truncation?: TruncationResult; nextOffset?: number; served: ServedRow[] } {
  const { rowSizes, selected, selectedHashes, startLine, totalLines, maxBytes, maxTruncLines } = params;
  const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
  const rows = rowSizes.map((row, index) =>
    row.bytes > maxBytes
      ? `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`
      : fmtRegion([selectedHashes[index]!], [selected[index]!]),
  );
  const skippedTruncation = truncateHead(rows.join("\n"), { maxBytes, maxLines: maxTruncLines });
  const shownRowCount = skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
  const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
  const { lineLabel, verb, addresses } = oversizedWarning(oversized);
  const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}]`;
  let preview = skippedTruncation.content;
  let nextOffset: number | undefined;
  if (shownRowCount > 0 && (skippedTruncation.truncated || lastShownLine < totalLines)) {
    nextOffset = lastShownLine + 1;
    preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, nextOffset, skippedTruncation.truncated ? skippedTruncation.maxBytes : undefined)}`;
  } else {
    preview += `\n\n${warning}`;
  }
  const served: ServedRow[] = [];
  for (let index = 0; index < shownRowCount; index++) if (rowSizes[index]!.bytes <= maxBytes) served.push({ position: startLine - 1 + index, hash: selectedHashes[index]! });
  return { text: preview, truncation: skippedTruncation.truncated ? skippedTruncation : undefined, ...(nextOffset !== undefined ? { nextOffset } : {}), served };
}
function buildNormalPreview(formatted: string, startLine: number, endIdx: number, totalLines: number, maxBytes: number, maxTruncLines: number, selectedHashes: string[]): { preview: string; nextOffset?: number; truncation: ReturnType<typeof truncateHead>; served: ServedRow[] } {
  const truncation = truncateHead(formatted, { maxBytes, maxLines: maxTruncLines });
  let preview = truncation.content;
  let nextOffset: number | undefined;
  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    nextOffset = endLineDisplay + 1;
    if (truncation.truncatedBy === "lines") preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`;
    else preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
  } else if (endIdx < totalLines) {
    nextOffset = endIdx + 1;
    preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`;
  }
  const served: ServedRow[] = [];
  for (let index = 0; index < truncation.outputLines; index++) served.push({ position: startLine - 1 + index, hash: selectedHashes[index]! });
  return { preview, nextOffset, truncation, served };
}

export async function fmtReadPreview(
	text: string,
	options: { offset?: number; limit?: number },
	precomputedHashes?: string[],
	path?: string,
	maxLineBytes = MAX_READ_LINE_BYTES,
	maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{
	text: string;
	truncation?: TruncationResult;
	nextOffset?: number;
	served: ServedRow[];
}> {
	const allLines = visLines(text);
	const totalLines = allLines.length;
	const startLine = normPosInt(options.offset, "offset") ?? 1;
	if (totalLines === 0) return emptyFilePreview(startLine, text, precomputedHashes, path, HASH_SEP);
	if (startLine > totalLines) {
		return {
			text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
			served: [],
		};
	}

	const limit = normPosInt(options.limit, "limit");
	const endIdx = limit
		? Math.min(startLine - 1 + limit, totalLines)
		: totalLines;
	const selected = allLines.slice(startLine - 1, endIdx);
	const allHashes =
		precomputedHashes ??
		(await (path ? lineHashes(text, path) : lineHashes(text)));
	const selectedHashes = allHashes.slice(startLine - 1, endIdx);
	const formatted = fmtRegion(selectedHashes, selected);
	const maxBytes = maxLineBytes;
	const rowSizes = selected.map((line, index) => ({
		lineNumber: startLine + index,
		bytes: Buffer.byteLength(
			`${selectedHashes[index]}${HASH_SEP}${line}`,
			"utf-8",
		),
	}));
	if (rowSizes.some((row) => row.bytes > maxBytes)) {
		return buildOversizedPreview({ rowSizes, selected, selectedHashes, startLine, totalLines, maxBytes, maxTruncLines });
	}

	const normal = buildNormalPreview(formatted, startLine, endIdx, totalLines, maxBytes, maxTruncLines, selectedHashes);
	return { text: normal.preview, truncation: normal.truncation.truncated ? normal.truncation : undefined, ...(normal.nextOffset !== undefined ? { nextOffset: normal.nextOffset } : {}), served: normal.served };
}

export function regRead(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "Read",
		description: R_DESC,
		promptSnippet: R_SNIPPET,
		promptGuidelines: readGuide(),
		prepareArguments: (args: unknown) => {
			if (!isRec(args)) return args as any;
			const record = { ...args };
			normalizeFilePath(record);
			return record;
		},
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file to read (relative or absolute)",
			}),
			offset: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Line number to start reading from (1-indexed)",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Maximum number of lines to read",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rawPath = params.path;
			const absolutePath = toCwd(rawPath, ctx.cwd);

			abortIf(signal);
			await valAccess(absolutePath, rawPath);

			abortIf(signal);
			const file = await loadFileKindAndText(absolutePath, {
				maxLines: MAX_HASH_LINES,
				displayPath: rawPath,
			});
			if (file.kind === "image") {
				const builtinRead = createReadTool(ctx.cwd);
				// SAFETY: pi-coding-agent's createReadTool returns untyped execute; cast narrows to typed signature validated by runtime params and is only used to delegate with same args.
				const executeBuiltinRead = builtinRead.execute as unknown as (
					toolCallId: string,
					input: typeof params,
					abortSignal: typeof signal,
					onUpdate: typeof _onUpdate,
					context: typeof ctx,
				) => ReturnType<typeof builtinRead.execute>;
				return executeBuiltinRead(_toolCallId, params, signal, _onUpdate, ctx);
			}
			const {
				normalized,
				fileHashes,
				hadUtf8DecodeErrors,
				absolutePath: resolvedPath,
			} = await readNormFile(rawPath, ctx.cwd, {
				signal,
				preloadedFile: file,
				maxLines: MAX_HASH_LINES,
				store: await loadHashStore(),
			});
			const preview = await fmtReadPreview(
				normalized,
				{
					offset: params.offset,
					limit: params.limit,
				},
				fileHashes,
				absolutePath,
			);
			const session = sessionFromContext(ctx as { sessionManager?: { getSessionId(): string } }, resolvedPath);
			await session.recordTruncated(preview.served, visLines(normalized).length);
			await session.clearDrift();
			let snapshotId: string | undefined;
			try {
				snapshotId = (await fileSnap(absolutePath)).snapshotId;
			} catch (error) {
				// SAFETY: best-effort snapshot computation — failures are ignored; read succeeds without snapshotId, tool returns preview and served state, no data loss.
				console.error("Failed to compute snapshot for read:", error);
			}
			const previewText = hadUtf8DecodeErrors
				? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
				: preview.text;

			return {
				content: [{ type: "text", text: previewText }],
				details: {
					truncation: preview.truncation,
					snapshotId,
					...(preview.nextOffset !== undefined
						? { nextOffset: preview.nextOffset }
						: {}),
					metrics: {
						truncated: Boolean(preview.truncation),
						...(preview.nextOffset !== undefined
							? { next_offset: preview.nextOffset }
							: {}),
					},
				},
			};
		},
	});
}
