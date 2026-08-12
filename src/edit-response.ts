import type { EditDetails } from "./edit";
import { genDiff } from "./edit-diff";
import { visLines, clipLine } from "./utils";

type TResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: EditDetails;
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
	addedLines: number;
	removedLines: number;
};

type NEditEntry = {
	loc: string;
	currentContent: string;
};

export interface NoopInput {
	path: string;
	noopEdit: NEditEntry | undefined;
	snapshotId?: string;
	editMeta: RMeta;
	warnings: string[] | undefined;
	driftNotice?: string;
}

export interface SuccessInput {
	path: string;
	originalNormalized: string;
	originalHashes: string[];
	result: string;
	resultHashes: string[];
	warnings: string[] | undefined;
	snapshotId?: string;
	editMeta: RMeta;
	driftNotice?: string;
}

export function buildMetrics(args: {
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

export interface FinalizeInput {
	diff: string;
	warnings?: string[];
	driftNotice?: string;
}

export function finalizeResult(input: FinalizeInput): string {
	const warningsBlock = input.warnings?.length
		? `\n\nWarnings:\n${input.warnings.join("\n")}`
		: "";
	const base = warningsBlock ? `${input.diff}${warningsBlock}` : input.diff;
	return input.driftNotice ? `${base}\n\n${input.driftNotice}` : base;
}

function warnBlock(warnings: string[] | undefined): string {
	return warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
}

export function buildNoop(input: NoopInput): TResult {
	const { path, noopEdit, snapshotId, editMeta, warnings, driftNotice } = input;

	const noopDetailsText = noopEdit
		? `Edit for ${noopEdit.loc} is identical to current content:\n  ${noopEdit.loc}: ${clipLine(noopEdit.currentContent)}`
		: "The edit produced identical content.";

	const noticeBlock = driftNotice ? `\n\n${driftNotice}` : "";
	const text = `No changes made to ${path}\nClassification: noop\n${noopDetailsText}${noticeBlock}`;

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
			...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
			...(driftNotice !== undefined ? { driftNotice } : {}),
		},
	};
}

export function buildChanged(input: SuccessInput): TResult {
	const {
		path,
		result,
		warnings,
		snapshotId,
		originalNormalized,
		originalHashes,
		editMeta,
		resultHashes,
		driftNotice,
	} = input;
	const resultLines = visLines(result);
	const diffResult = genDiff(
		originalNormalized,
		result,
		1,
		resultHashes,
		originalHashes,
	);
	const addedLines = editMeta.addedLines;
	const removedLines = editMeta.removedLines;
	const warningsBlock = warnBlock(warnings);
	const successPrefix = `Successfully edited in ${path}.`;
	const lineSummary =
		addedLines > 0 || removedLines > 0
			? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
			: "";
	const noticeBlock = driftNotice ? `\n\n${driftNotice}` : "";
	const text =
		resultLines.length === 0
			? "File is empty. Use edit to insert content." + noticeBlock
			: warningsBlock
				? `${successPrefix}${lineSummary}${warningsBlock}${noticeBlock}`
				: `${successPrefix}${lineSummary}${noticeBlock}`;

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
			...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
			servedRows: diffResult.servedRows,
			...(driftNotice !== undefined ? { driftNotice } : {}),
		},
	};
}
