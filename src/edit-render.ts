import type { Theme } from "@earendil-works/pi-coding-agent";
import { normReq, isNormalizedEdit } from "./edit-normalize";
import type { EditParams } from "./edit";
import type { EditDetails } from "./edit-response";


export type FgT = Pick<Theme, "fg">;
export type CallT = Pick<Theme, "fg" | "bold">;
export type MdTheme = Pick<
	Theme,
	"fg" | "bold" | "italic" | "underline" | "strikethrough"
>;

export type RPreview = { diff: string } | { error: string };

export type RRState = {
	argsKey?: string;
	preview?: RPreview;
	previewGeneration?: number;
	previewTimer?: ReturnType<typeof setTimeout>;
};

export function getPreviewInput(args: unknown): EditParams | null {
	let normalized: unknown;
	try {
		normalized = normReq(args);
	} catch {
		return null;
	}
	if (!isNormalizedEdit(normalized)) {
		return null;
	}
	if (
		normalized.path !== null &&
		(typeof normalized.path !== "string" || normalized.path.length === 0)
	) {
		return null;
	}
	if (
		typeof normalized.remove_from !== "string" ||
		typeof normalized.remove_to !== "string" ||
		typeof normalized.replacement_text !== "string"
	) {
		return null;
	}

	return {
		path: normalized.path,
		remove_from: normalized.remove_from,
		remove_to: normalized.remove_to,
		replacement_text: normalized.replacement_text,
	};
}


export function colorLines(lines: string[], theme: FgT): string[] {
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

export function fmtPreview(
	diff: string,
	expanded: boolean,
	theme: FgT,
): string {
	const lines = diff.split("\n");
	const maxLines = expanded ? 40 : 16;
	const shown = colorLines(lines.slice(0, maxLines), theme);

	if (lines.length > maxLines) {
		shown.push(
			theme.fg("muted", `... ${lines.length - maxLines} more diff lines`),
		);
	}
	return shown.join("\n");
}

export function fmtResult(diff: string, theme: FgT): string {
	return colorLines(diff.split("\n"), theme).join("\n");
}

export function fmtCall(
	args: EditParams | undefined,
	state: RRState,
	expanded: boolean,
	theme: CallT,
): string {
	const path = args?.path;
	const pathDisplay =
		typeof path === "string" && path.length > 0
			? theme.fg("accent", path)
			: theme.fg("toolOutput", "...");
	let text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

	if (!state.preview) {
		return text;
	}

	if ("error" in state.preview) {
		text += `\n\n${theme.fg("error", state.preview.error)}`;
		return text;
	}

	if (state.preview.diff) {
		text += `\n\n${fmtPreview(state.preview.diff, expanded, theme)}`;
	}
	return text;
}

export function getResultText(result: {
	content?: Array<{ type: string; text?: string }>;
}): string | undefined {
	const textContent = result.content?.find(
		(entry): entry is { type: "text"; text: string } =>
			entry.type === "text" && typeof entry.text === "string",
	);
	return textContent?.text;
}

export function isApplied(details: EditDetails | undefined): boolean {
	const metrics = details?.metrics;
	return (
		metrics?.classification === "applied" &&
		metrics.added_lines !== undefined &&
		metrics.removed_lines !== undefined
	);
}

export function buildAppliedText(
	details: EditDetails | undefined,
	theme: FgT,
): string | undefined {
	const sections: string[] = [];

	if (details?.diff) {
		sections.push(fmtResult(details.diff, theme));
	}

	const warnings = details?.warnings;
	if (warnings?.length) {
		sections.push(warnings.join("\n"));
	}

	return sections.length > 0 ? sections.join("\n\n") : undefined;
}
function trimEmpty(lines: string[]): string[] {
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

export function fmtResultMd(text: string): string {
	return trimEmpty(text.split("\n")).join("\n");
}

export function mkMdTheme(theme: MdTheme) {
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
