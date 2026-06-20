import { generateDiffString } from "./replace-diff";
import {
	computeAffectedLineRange,
	computeLineHashes,
	formatHashlineRegion,
} from "./hashline";
import { getVisibleLines } from "./utils";
import { CHANGED_ANCHOR_TEXT_BUDGET_BYTES } from "./constants";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: any;
};

export type ReplaceMetrics = {
	edits_attempted: number;
	edits_noop: number;
	warnings: number;
	classification: "applied" | "noop";
	changed_lines?: { first: number; last: number };
	added_lines?: number;
	removed_lines?: number;
};

export type ReadMetrics = {
	truncated: boolean;
	next_offset?: number;
};

export type ReplaceMeta = {
	editsAttempted: number;
	noopEditsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
};

type NoopEditEntry = {
	editIndex: number;
	loc: string;
	currentContent: string;
};



export interface NoopResponseInput {
	path: string;
	noopEdits: NoopEditEntry[] | undefined;
	snapshotId: string;
	editMeta: ReplaceMeta;
	warnings: string[] | undefined;
}

export interface SuccessResponseInput {
	path: string;
	originalNormalized: string;
	result: string;
	resultHashes?: string[];
	warnings: string[] | undefined;
	snapshotId: string;
	editMeta: ReplaceMeta;
}



function countDiffLines(diff: string, marker: "+" | "-"): number {
	if (!diff) return 0;
	let count = 0;
	for (const line of diff.split("\n")) {
		if (
			line.startsWith(marker) &&
			!line.startsWith(`${marker}${marker}${marker}`)
		) {
			count += 1;
		}
	}
	return count;
}

function buildMetrics(args: {
	classification: "applied" | "noop";
	editsAttempted: number;
	noopEditsCount: number;
	warningsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	addedLines?: number;
	removedLines?: number;
}): ReplaceMetrics {
	const metrics: ReplaceMetrics = {
		edits_attempted: args.editsAttempted,
		edits_noop: args.noopEditsCount,
		warnings: args.warningsCount,
		classification: args.classification,
	};
	if (
		args.classification === "applied" &&
		args.firstChangedLine !== undefined &&
		args.lastChangedLine !== undefined
	) {
		metrics.changed_lines = {
			first: args.firstChangedLine,
			last: args.lastChangedLine,
		};
	}
	if (args.addedLines !== undefined) metrics.added_lines = args.addedLines;
	if (args.removedLines !== undefined)
		metrics.removed_lines = args.removedLines;
	return metrics;
}

function warningsBlockOf(warnings: string[] | undefined): string {
	return warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
}


export function buildNoopResponse(input: NoopResponseInput): ToolResult {
	const {
		path,
		noopEdits,
		snapshotId,
		editMeta,
		warnings,
	} = input;

	const noopDetailsText = noopEdits?.length
		? noopEdits
				.map(
					(edit) =>
						`Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}: ${edit.currentContent}`,
				)
				.join("\n")
		: "The edits produced identical content.";

	const text = `No changes made to ${path}\nClassification: noop\n${noopDetailsText}`;

	const metrics = buildMetrics({
		classification: "noop",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: "",
			firstChangedLine: undefined,
			snapshotId,
			classification: "noop" as const,
			metrics,
		},
	};
}

export function buildChangedResponse(input: SuccessResponseInput): ToolResult {
	const { result, warnings, snapshotId, originalNormalized, editMeta } = input;

	const diffResult = generateDiffString(originalNormalized, result);
	const addedLines = countDiffLines(diffResult.diff, "+");
	const removedLines = countDiffLines(diffResult.diff, "-");
	const warningsBlock = warningsBlockOf(warnings);

	const resultLines = getVisibleLines(result);
	const resultHashes = input.resultHashes ?? computeLineHashes(result);
	const anchorRange = computeAffectedLineRange({
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
		resultLineCount: resultLines.length,
	});
	const anchorsBlock = anchorRange
		? (() => {
				const region = resultLines.slice(
					anchorRange.start - 1,
					anchorRange.end,
				);
				const regionHashes = resultHashes.slice(
					anchorRange.start - 1,
					anchorRange.end,
				);
				const formatted = formatHashlineRegion(regionHashes, region);
				const block = `--- Anchors ---\n${formatted}`;
				return Buffer.byteLength(block, "utf8") <=
					CHANGED_ANCHOR_TEXT_BUDGET_BYTES
					? block
					: "Anchors omitted; use read for subsequent edits.";
			})()
		: resultLines.length === 0
			? "File is empty. Use edit to insert content."
			: "";
	const text = [anchorsBlock, warningsBlock.trimStart()]
		.filter((section) => section.length > 0)
		.join("\n\n");

	const metrics = buildMetrics({
		classification: "applied",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
		addedLines,
		removedLines,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: diffResult.diff,
			firstChangedLine:
				editMeta.firstChangedLine ?? diffResult.firstChangedLine,
			snapshotId,
			metrics,
		},
	};
}