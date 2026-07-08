import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createReadTool,
	formatSize,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadFileKindAndText } from "./file-kind";
import { readNormFile } from "./file-reader";
import { lineHashes, fmtRegion, HASH_SEP } from "./hashline";
import { toCwd } from "./path-utils";
import { abortIf } from "./runtime";
import { fileSnap } from "./snapshot";
import { visLines } from "./utils";
import { loadP, loadGuide } from "./prompts";
import { valAccess } from "./validation";

const R_DESC = loadP("../prompts/read.md", {
	DEFAULT_MAX_LINES: String(DEFAULT_MAX_LINES),
	DEFAULT_MAX_BYTES: formatSize(DEFAULT_MAX_BYTES),
});

const R_SNIPPET = loadP("../prompts/read-snippet.md");
const R_GUIDE = loadGuide("../prompts/read-guidelines.md");

function normPosInt(
	value: number | undefined,
	name: "offset" | "limit",
): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`Read request field "${name}" must be a positive integer.`);
	}

	return value;
}

/**
 * Builds the `[Showing lines A-B of N. Use offset=M to continue.]` hint shared by
 * `fmtReadPreview` and the auto-read-after-write handler. `byteLimit` adds the
 * `(size limit)` suffix used when truncation is byte-driven.
 */
export function formatPaginationHint(
	startLine: number,
	endLine: number,
	totalLines: number,
	nextOffset: number,
	byteLimit?: number,
): string {
	const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
	return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}

export async function fmtReadPreview(
	text: string,
	options: { offset?: number; limit?: number },
	precomputedHashes?: string[],
	path?: string,
): Promise<{ text: string; truncation?: TruncationResult; nextOffset?: number }> {
	const allLines = visLines(text);
	const totalLines = allLines.length;
	const startLine = normPosInt(options.offset, "offset") ?? 1;
	if (totalLines === 0) {
		if (startLine === 1) {
      const allHashes = precomputedHashes ?? await (path ? lineHashes(text, path) : lineHashes(text));
      const emptyLineHash = allHashes[0] ?? "";
      return {
				text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use replace to insert content.]`,
			};
		}
		return {
			text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use replace to insert content.`,
		};
	}
	if (startLine > totalLines) {
		return {
			text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
		};
	}

	const limit = normPosInt(options.limit, "limit");
	const endIdx = limit
		? Math.min(startLine - 1 + limit, totalLines)
		: totalLines;
	const selected = allLines.slice(startLine - 1, endIdx);
	const allHashes = precomputedHashes ?? await (path ? lineHashes(text, path) : lineHashes(text));
	const selectedHashes = allHashes.slice(startLine - 1, endIdx);
	const formatted = fmtRegion(selectedHashes, selected);

	const truncation = truncateHead(formatted);
	if (truncation.firstLineExceedsLimit) {
		return {
			text: `[Line ${startLine} exceeds ${formatSize(truncation.maxBytes)}. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`,
			truncation,
		};
	}

	let preview = truncation.content;
	let nextOffset: number | undefined;
	if (truncation.truncated) {
		const endLineDisplay = startLine + truncation.outputLines - 1;
		nextOffset = endLineDisplay + 1;
		if (truncation.truncatedBy === "lines") {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`;
		} else {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
		}
	} else if (endIdx < totalLines) {
		nextOffset = endIdx + 1;
		preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`;
	}

	return {
		text: preview,
		truncation: truncation.truncated ? truncation : undefined,
		...(nextOffset !== undefined ? { nextOffset } : {}),
	};
}

export function regRead(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "Read",
		description: R_DESC,
		promptSnippet: R_SNIPPET,
		promptGuidelines: R_GUIDE,
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
			const file = await loadFileKindAndText(absolutePath);
			if (file.kind === "image") {
				const builtinRead = createReadTool(ctx.cwd);
				const executeBuiltinRead = builtinRead.execute as unknown as (
					toolCallId: string,
					input: typeof params,
					abortSignal: typeof signal,
					onUpdate: typeof _onUpdate,
					context: typeof ctx,
				) => ReturnType<typeof builtinRead.execute>;
				return executeBuiltinRead(_toolCallId, params, signal, _onUpdate, ctx);
			}
			const { normalized, fileHashes, hadUtf8DecodeErrors } = await readNormFile(
				rawPath, ctx.cwd, signal, undefined, file,
			);
			const preview = await fmtReadPreview(
				normalized,
				{
					offset: params.offset,
					limit: params.limit,
				},
				fileHashes,
				absolutePath,
			);
			const snapshot = await fileSnap(absolutePath);

			const previewText =
				hadUtf8DecodeErrors
					? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
					: preview.text;

			return {
				content: [{ type: "text", text: previewText }],
				details: {
					truncation: preview.truncation,
					snapshotId: snapshot.snapshotId,
					...(preview.nextOffset !== undefined
						? { nextOffset: preview.nextOffset }
						: {}),
					metrics: {
						truncated: !!preview.truncation,
						...(preview.nextOffset !== undefined
							? { next_offset: preview.nextOffset }
							: {}),
					},
				},
			};
		},
	});
}
