
import type { Theme } from "@earendil-works/pi-coding-agent";
import { normalizeReplaceRequest } from "./replace-normalize";
import type { ReplaceRequestParams, HashlineReplaceToolDetails } from "./replace";
import { isRecord } from "./utils";

export type FgTheme = Pick<Theme, "fg">;
export type CallTheme = Pick<Theme, "fg" | "bold">;
export type RenderedMarkdownTheme = Pick<
	Theme,
	"fg" | "bold" | "italic" | "underline" | "strikethrough"
>;

export type ReplacePreview = { diff: string } | { error: string };

export type ReplaceRenderState = {
	argsKey?: string;
	preview?: ReplacePreview;
	previewGeneration?: number;
};


export function getRenderablePreviewInput(
	args: unknown,
): ReplaceRequestParams | null {
	let normalized: unknown;
	try {
		normalized = normalizeReplaceRequest(args);
	} catch {
		return null;
	}
	if (!isRecord(normalized) || typeof normalized.path !== "string") {
		return null;
	}

	const request: ReplaceRequestParams = { path: normalized.path };
	if (Array.isArray(normalized.edits)) {
		request.edits = normalized.edits as any;
	}

	return request.edits !== undefined ? request : null;
}

export function colorDiffLines(lines: string[], theme: FgTheme): string[] {
	return lines.map((line) => {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			return theme.fg("success", line);
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			return theme.fg("error", line);
		}
		return theme.fg("dim", line);
	});
}

export function formatPreviewDiff(
	diff: string,
	expanded: boolean,
	theme: FgTheme,
): string {
	const lines = diff.split("\n");
	const maxLines = expanded ? 40 : 16;
	const shown = colorDiffLines(lines.slice(0, maxLines), theme);

	if (lines.length > maxLines) {
		shown.push(
			theme.fg("muted", `... ${lines.length - maxLines} more diff lines`),
		);
	}
	return shown.join("\n");
}

export function formatResultDiff(diff: string, theme: FgTheme): string {
	return colorDiffLines(diff.split("\n"), theme).join("\n");
}

export function formatEditCall(
	args: ReplaceRequestParams | undefined,
	state: ReplaceRenderState,
	expanded: boolean,
	theme: CallTheme,
): string {
	const path = args?.path;
	const pathDisplay =
		typeof path === "string" && path.length > 0
			? theme.fg("accent", path)
			: theme.fg("toolOutput", "...");
	let text = `${theme.fg("toolTitle", theme.bold("replace"))} ${pathDisplay}`;

	if (!state.preview) {
		return text;
	}

	if ("error" in state.preview) {
		text += `\n\n${theme.fg("error", state.preview.error)}`;
		return text;
	}

	if (state.preview.diff) {
		text += `\n\n${formatPreviewDiff(state.preview.diff, expanded, theme)}`;
	}
	return text;
}

export function getRenderedEditTextContent(result: {
	content?: Array<{ type: string; text?: string }>;
}): string | undefined {
	const textContent = result.content?.find(
		(entry): entry is { type: "text"; text: string } =>
			entry.type === "text" && typeof entry.text === "string",
	);
	return textContent?.text;
}

export function extractRenderedWarnings(
	text: string | undefined,
): string | undefined {
	return text?.match(/(?:^|\n)Warnings:\n[\s\S]*$/)?.[0]?.trimStart();
}

export function isAppliedChangedResult(
	details: HashlineReplaceToolDetails | undefined,
): boolean {
	const metrics = details?.metrics;
	return (
		metrics?.classification === "applied" &&
		metrics.added_lines !== undefined &&
		metrics.removed_lines !== undefined
	);
}

export function buildAppliedChangedResultText(
	text: string | undefined,
	details: HashlineReplaceToolDetails | undefined,
	theme: FgTheme,
): string | undefined {
	const sections: string[] = [];

	if (details?.diff) {
		sections.push(formatResultDiff(details.diff, theme));
	}

	const warnings = extractRenderedWarnings(text);
	if (warnings) sections.push(warnings);

	return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function trimEdgeEmptyLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && lines[start] === "") {
		start++;
	}
	while (end > start && lines[end - 1] === "") {
		end--;
	}

	return lines.slice(start, end);
}

function isRenderedEditSectionBoundary(line: string): boolean {
	return (
		line === "--- Anchors ---" ||
		line === "Warnings:" ||
		line === "Structure outline:" ||
		/^--- Range \d+ ---$/.test(line)
	);
}

export function formatRenderedEditResultMarkdown(text: string): string {
	const lines = text.split("\n");
	const sections: string[] = [];
	let plainLines: string[] = [];

	const flushPlainLines = () => {
		const trimmed = trimEdgeEmptyLines(plainLines);
		if (trimmed.length > 0) {
			sections.push(trimmed.join("\n"));
		}
		plainLines = [];
	};

	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!;

		if (line.startsWith("--- Anchors ")) {
			flushPlainLines();
			const title = line.replace(/^---\s*/, "").replace(/\s*---$/, "");
			index++;
			const bodyLines: string[] = [];
			while (
				index < lines.length &&
				!isRenderedEditSectionBoundary(lines[index]!)
			) {
				bodyLines.push(lines[index]!);
				index++;
			}
			sections.push(
				[
					`#### ${title}`,
					"```text",
					...trimEdgeEmptyLines(bodyLines),
					"```",
				].join("\n"),
			);
			continue;
		}

		plainLines.push(line);
		index++;
	}

	flushPlainLines();

	return sections.join("\n\n");
}

export function createRenderedEditMarkdownTheme(theme: RenderedMarkdownTheme) {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => (theme.italic ? theme.italic(text) : text),
		underline: (text: string) =>
			theme.underline ? theme.underline(text) : text,
		strikethrough: (text: string) =>
			theme.strikethrough ? theme.strikethrough(text) : text,
		highlightCode: (code: string, lang?: string) =>
			code.split("\n").map((line) => {
				if (lang === "diff") {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						return theme.fg("toolDiffAdded", line);
					}
					if (line.startsWith("-") && !line.startsWith("---")) {
						return theme.fg("toolDiffRemoved", line);
					}
					return theme.fg("toolDiffContext", line);
				}

				return theme.fg("mdCodeBlock", line);
			}),
	};
}