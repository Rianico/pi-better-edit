import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toCwd } from "./paths.js";
import { abortIf, isRec, normalizeFilePath } from "./utils.js";
import { loadP } from "./prompts.js";
import { valAccess } from "./validation.js";

const RS_DESC = loadP("../prompts/read-skill.md");

const RS_SNIPPET = loadP("../prompts/read-skill-snippet.md");

export function regReadSkill(pi: ExtensionAPI): void {
	const builtinReadDef = createReadToolDefinition("");
	const builtinRenderCall = builtinReadDef.renderCall as any;
	const builtinRenderResult = builtinReadDef.renderResult as any;
	pi.registerTool({
		name: "read_skill",
		label: "Read skill",
		description: RS_DESC,
		promptSnippet: RS_SNIPPET,
		renderCall: builtinRenderCall,
		renderResult: builtinRenderResult,
		prepareArguments: (args: unknown) => {
			if (!isRec(args)) return args as any;
			const record = { ...args };
			normalizeFilePath(record);
			return record;
		},
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the skill file to read (relative or absolute)",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rawPath = params.path;
			const absolutePath = toCwd(rawPath, ctx.cwd);

			abortIf(signal);
			await valAccess(absolutePath, rawPath);

			abortIf(signal);
			const builtinRead = createReadTool(ctx.cwd);
			// SAFETY: createReadTool's execute is untyped in pi-coding-agent; cast to typed delegate signature is safe because args are validated via valAccess and forwarded unchanged.
			const executeBuiltinRead = builtinRead.execute as unknown as (
				toolCallId: string,
				input: typeof params,
				abortSignal: typeof signal,
				onUpdate: typeof _onUpdate,
				context: typeof ctx,
			) => ReturnType<typeof builtinRead.execute>;
			return executeBuiltinRead(_toolCallId, params, signal, _onUpdate, ctx);
		},
	});
}
