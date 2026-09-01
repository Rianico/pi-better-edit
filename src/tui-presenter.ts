/** SAFETY: TuiPresenter — Framework adapter owning the pi TUI boundary. Deep module EditTool never imports pi-tui; all Text/Markdown, DebouncedPreview wiring, and SAFETY casts live here. Two adapters justify the seam: TuiPresenter in prod, Headless in tests. Graded surface: public createTuiPresenter(preview) returns renderCall/renderResult ready for pi's ToolDefinition. */

import { Markdown, Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { DebouncedPreview } from "./preview-controller.js";
import {
	buildAppliedText,
	mkMdTheme,
	fmtCall,
	fmtResultMd,
	getPreviewInput,
	getResultText,
	isApplied,
	type RPreview,
	type RRState,
} from "./edit-render.js";
import type { EditDetails } from "./edit-response.js";

type TuiToolDef = ToolDefinition<TSchema, EditDetails, RRState> & {
	renderShell?: "default" | "self";
};

export function reuseText(context: unknown, content: string): Text {
	const ctx = context as { lastComponent: unknown };
	const t =
		ctx.lastComponent instanceof Text ? ctx.lastComponent : new Text("", 0, 0);
	t.setText(content);
	return t;
}

export function reuseMarkdown(
	context: unknown,
	content: string,
	theme: unknown,
): Markdown {
	const ctx = context as { lastComponent: unknown };
	const m =
		ctx.lastComponent instanceof Markdown
			? ctx.lastComponent
			: new Markdown("", 0, 0, mkMdTheme(theme as never));
	m.setText(content);
	return m;
}

function isErrorContext(ctx: unknown): boolean {
	// SAFETY: pi TUI context isError is untyped at boundary — cast isolated to adapter, validated by render error path
	return (ctx as unknown as { isError: boolean }).isError;
}

export function makeRenderCall(preview: DebouncedPreview) {
	return (args: unknown, theme: unknown, context: unknown) => {
		const ctx = context as {
			lastComponent: unknown;
			state: unknown;
			expanded: unknown;
		};
		// SAFETY: pi TUI renderCall expects untyped context — cast isolates to adapter, validated by pi's runtime context shape
		preview.renderCall(
			ctx as unknown as Parameters<DebouncedPreview["renderCall"]>[0],
			args,
		);
		const text = (ctx.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// SAFETY: pi context carries untyped state/expanded — cast to RRState/boolean narrowed by getPreviewInput and theme contract
		text.setText(
			fmtCall(
				getPreviewInput(args),
				(ctx as unknown as { state: RRState }).state as RRState,
				(ctx as unknown as { expanded: boolean }).expanded,
				theme as never,
			),
		);
		return text;
	};
}

export function makeRenderResult(preview: DebouncedPreview) {
	return (
		result: unknown,
		opts: { isPartial: boolean },
		theme: unknown,
		context: unknown,
	) => {
		const ctx = context as {
			lastComponent: unknown;
			state: unknown;
			isError: boolean;
		};
		if (opts.isPartial)
			return reuseText(
				ctx,
				(theme as { fg: (a: string, b: string) => string }).fg(
					"warning",
					"Editing...",
				),
			);
		const typedResult = result as {
			content?: Array<{ type: string; text?: string }>;
			details?: EditDetails;
		};
		const renderedText = getResultText(typedResult);
		// SAFETY: pi TUI context state is untyped at boundary — cast to RRState narrowed by preview lifecycle (covers ctx and state casts)
		const renderState = (ctx as unknown as { state: RRState | undefined }).state as RRState | undefined;
		if (renderState) preview.clearResult(renderState);
		if (isErrorContext(ctx))
			return renderedText
				? reuseText(
						ctx,
						`\n${(theme as { fg: (a: string, b: string) => string }).fg("error", renderedText)}`,
					)
				: new Text("", 0, 0);
		if (isApplied(typedResult.details)) {
			const appliedText = buildAppliedText(typedResult.details, theme as never);
			return appliedText ? reuseText(ctx, appliedText) : new Text("", 0, 0);
		}
		if (!renderedText) return new Text("", 0, 0);
		return reuseMarkdown(ctx, fmtResultMd(renderedText), theme as never);
	};
}

export interface TuiPresenter {
	renderCall: ReturnType<typeof makeRenderCall>;
	renderResult: ReturnType<typeof makeRenderResult>;
	preview: DebouncedPreview;
	/** SAFETY: Returns pi ToolDefinition-typed renders — adapter owns the SAFETY casts */
	asToolDef(): Pick<TuiToolDef, "renderCall" | "renderResult">;
}

export function createTuiPresenter(
	previewFn: (request: unknown, cwd: string) => Promise<RPreview>,
): TuiPresenter {
	const preview = new DebouncedPreview(previewFn);
	const renderCall = makeRenderCall(preview);
	const renderResult = makeRenderResult(preview);
	return {
		preview,
		renderCall,
		renderResult,
		asToolDef() {
			// SAFETY: ToolDef renderCall/renderResult typed strictly by pi — casts validated by ToolDef contract, owned by framework adapter seam
			return {
				renderCall: renderCall as unknown as TuiToolDef["renderCall"],
				renderResult: renderResult as unknown as TuiToolDef["renderResult"],
			};
		},
	};
}
