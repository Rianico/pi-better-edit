import type { ReplaceDetails } from "./replace";
import { genDiff } from "./replace-diff";
import { visLines } from "./utils";

type TResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: ReplaceDetails;
};

export type RMetrics = {
	edits_attempted: number;
	edits_noop: number;
	warnings: number;
	classification: "applied" | "noop";
	changed_lines?: { first: number; last: number };
	added_lines?: number;
	removed_lines?: number;
};

export type RMeta = {
	editsAttempted: number;
	noopEditsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
};

type NEditEntry = {
	editIndex: number;
	loc: string;
	currentContent: string;
};

export interface NoopInput {
	path: string;
	noopEdits: NEditEntry[] | undefined;
	snapshotId: string;
	editMeta: RMeta;
	warnings: string[] | undefined;
}

export interface SuccessInput {
	path: string;
	originalNormalized: string;
	result: string;
	resultHashes: string[];
	warnings: string[] | undefined;
	snapshotId: string;
	editMeta: RMeta;
}

function cntDiff(diff: string, marker: "+" | "-"): number {
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

function buildM(args: {
	classification: "applied" | "noop";
	editsAttempted: number;
	noopEditsCount: number;
	warningsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	addedLines?: number;
	removedLines?: number;
}): RMetrics {
	const metrics: RMetrics = {
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

function warnBlock(warnings: string[] | undefined): string {
	return warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
}

export function buildNoop(input: NoopInput): TResult {
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

	const metrics = buildM({
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

export function buildChanged(input: SuccessInput): TResult {
	const { path, result, warnings, snapshotId, originalNormalized, editMeta, resultHashes } = input;

	const resultLines = visLines(result);
	const diffResult = genDiff(originalNormalized, result, 2, resultHashes);
	const addedLines = cntDiff(diffResult.diff, "+");
	const removedLines = cntDiff(diffResult.diff, "-");
	const warningsBlock = warnBlock(warnings);
	const successPrefix = `Successfully replaced in ${path}.`;
	const text = resultLines.length === 0
		? "File is empty. Use replace to insert content."
		: warningsBlock
			? `${successPrefix}${warningsBlock}`
			: successPrefix;

	const metrics = buildM({
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
