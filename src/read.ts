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
import { normalizeToLF, stripBom } from "./replace-diff";
import { loadFileKindAndText } from "./file-kind";
import { computeLineHashes, formatHashlineRegion } from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { getFileSnapshot } from "./snapshot";
import { getVisibleLines } from "./utils";
import { loadPrompt, loadPromptGuidelines } from "./prompts";
import { validateFileAccess, assertTextFile } from "./validation";

const READ_DESC = loadPrompt("../prompts/read.md", {
	DEFAULT_MAX_LINES: String(DEFAULT_MAX_LINES),
	DEFAULT_MAX_BYTES: formatSize(DEFAULT_MAX_BYTES),
});

const READ_PROMPT_SNIPPET = loadPrompt("../prompts/read-snippet.md");
const READ_PROMPT_GUIDELINES = loadPromptGuidelines("../prompts/read-guidelines.md");

function normalizePositiveInteger(
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


export function formatHashlineReadPreview(
	text: string,
	options: { offset?: number; limit?: number },
	precomputedHashes?: string[],
): { text: string; truncation?: TruncationResult; nextOffset?: number } {
	const allLines = getVisibleLines(text);
	const totalLines = allLines.length;
	const startLine = normalizePositiveInteger(options.offset, "offset") ?? 1;
	if (totalLines === 0) {
		if (startLine === 1) {
			return {
				text: "File is empty. Use edit to insert content.",
			};
		}
		return {
			text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use edit to insert content.`,
		};

	}
	if (startLine > totalLines) {
		return {
			text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
		};
	}

	const limit = normalizePositiveInteger(options.limit, "limit");
	const endIdx = limit
		? Math.min(startLine - 1 + limit, totalLines)
		: totalLines;
	const selected = allLines.slice(startLine - 1, endIdx);
	const allHashes = precomputedHashes ?? computeLineHashes(text);
	const selectedHashes = allHashes.slice(startLine - 1, endIdx);
	const formatted = formatHashlineRegion(selectedHashes, selected);

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
			preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines} (${formatSize(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
		}
	} else if (endIdx < totalLines) {
		nextOffset = endIdx + 1;
		preview += `\n\n[Showing lines ${startLine}-${endIdx} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
	}

	return {
		text: preview,
		truncation: truncation.truncated ? truncation : undefined,
		...(nextOffset !== undefined ? { nextOffset } : {}),
	};
}

export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "Read",
		description: READ_DESC,
		promptSnippet: READ_PROMPT_SNIPPET,
		promptGuidelines: READ_PROMPT_GUIDELINES,
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
			const absolutePath = resolveToCwd(rawPath, ctx.cwd);

			throwIfAborted(signal);
			await validateFileAccess(absolutePath, rawPath);

			throwIfAborted(signal);
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
			assertTextFile(file, rawPath);

			throwIfAborted(signal);
			const normalized = normalizeToLF(stripBom(file.text).text);
			const fileHashes = computeLineHashes(normalized);
			const preview = formatHashlineReadPreview(
				normalized,
				{
					offset: params.offset,
					limit: params.limit,
				},
				fileHashes,
			);
			const snapshot = await getFileSnapshot(absolutePath);

			const previewText =
				file.hadUtf8DecodeErrors === true
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