import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_HASH_LINES } from "./hashline/index.js";
import { loadHashStore } from "./hash-store.js";
import {
	recordServedTruncated,
	clearDriftReported,
	sessionKeyFor,
} from "./served-state.js";
import { abortIf, isRec, normalizeFilePath } from "./utils.js";
import { visLines } from "./utils.js";
import { loadP, loadGuide } from "./prompts.js";
import { prepareFile } from "./file-content/index.js";
import { fileSnap } from "./file-reader.js";
// Facade re-export for callers still importing preview directly
export { fmtReadPreview } from "./file-content/preview.js";

const R_DESC = loadP("../prompts/read.md");
const R_SNIPPET = loadP("../prompts/read-snippet.md");

function readGuide(): string[] {
	return loadGuide("../prompts/read-guidelines.md");
}

export function regRead(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "Read",
		description: R_DESC,
		promptSnippet: R_SNIPPET,
		promptGuidelines: readGuide(),
		prepareArguments: (args: unknown) => {
			if (!isRec(args)) return args as never;
			const record = { ...args } as Record<string, unknown>;
			normalizeFilePath(record);
			return record as never;
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
			abortIf(signal);
			// Deep seam: one call handles kind detection, decode, normalize, hash, preview
			const prepared = await prepareFile(rawPath, ctx.cwd, {
				signal,
				offset: params.offset,
				limit: params.limit,
				maxLines: MAX_HASH_LINES,
				store: await loadHashStore(),
			});

			if (prepared.kind === "image") {
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
			if (prepared.kind !== "text") {
				if (prepared.kind === "directory") {
					throw new Error(`[E_NOT_TEXT] Path is a directory: ${rawPath}. Use ls to inspect directories.`);
				}
				if (prepared.kind === "binary") {
					throw new Error(`[E_NOT_TEXT] Path is a binary file: ${rawPath} (${prepared.description}). Hashline edit only supports text files.`);
				}
				throw new Error(`[E_NOT_TEXT] Path is an image file: ${rawPath}. Hashline edit only supports text files.`);
			}

			await recordServedTruncated(
				sessionKeyFor(ctx),
				prepared.absolutePath,
				prepared.served,
				visLines(prepared.normalized).length,
			);
			await clearDriftReported(sessionKeyFor(ctx), prepared.absolutePath);
			let snapshotId: string | undefined;
			try {
				snapshotId = (await fileSnap(prepared.absolutePath)).snapshotId;
			} catch {
				snapshotId = undefined;
			}
			return {
				content: [{ type: "text", text: prepared.preview }],
				details: {
					truncation: prepared.truncation,
					snapshotId,
					...(prepared.nextOffset !== undefined ? { nextOffset: prepared.nextOffset } : {}),
					metrics: {
						truncated: Boolean(prepared.truncation),
						...(prepared.nextOffset !== undefined ? { next_offset: prepared.nextOffset } : {}),
					},
				},
			};
		},
	});
}
