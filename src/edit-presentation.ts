/** SAFETY: EditPresentation — deep module owning Result Presentation seam. Collapses the shallow Result Presentation cluster behind one seam. See ADR-0014. */

import {
	genDiff as diffGenDiff,
	detectEnding,
	toLF,
	restoreEndings,
	stripBOM,
	type LineEnding,
} from "./edit-diff.js";
import {
	fmtPreview,
	fmtResult,
	fmtCall,
	getResultText,
	isApplied,
	buildAppliedText,
	fmtResultMd,
	mkMdTheme,
	colorLines,
	getPreviewInput,
	type FgT,
	type CallT,
	type MdTheme,
	type RPreview,
	type RRState,
} from "./edit-render.js";
import {
	buildMetrics,
	buildNoop,
	buildChanged,
	buildBatchResult,
	finalizeResult,
	finalizeToolResult,
	type EditDetails,
	type RMetrics,
	type NoopInput,
	type SuccessInput,
	type BatchSection,
} from "./edit-response.js";
import { computeDrift, scanDrift } from "./drift.js";
import {
	runNoopPolicy,
	clearNoopLoop,
	type NoopPolicyInput,
	type NoopPolicyOutcome,
} from "./noop-guard.js";

export { diffGenDiff as genDiff, detectEnding, toLF, restoreEndings, stripBOM };
export type { LineEnding };

export {
	fmtPreview,
	fmtResult,
	fmtCall,
	getResultText,
	isApplied,
	buildAppliedText,
	fmtResultMd,
	mkMdTheme,
	colorLines,
	getPreviewInput,
};
export type { FgT, CallT, MdTheme, RPreview, RRState };

export {
	buildMetrics,
	buildNoop,
	buildChanged,
	buildBatchResult,
	finalizeResult,
	finalizeToolResult,
};
export type { EditDetails, RMetrics, NoopInput, SuccessInput, BatchSection };

// SAFETY: drift re-exports — single seam for pipeline/edit tool
export { computeDrift, scanDrift };

export { runNoopPolicy, clearNoopLoop };
export type { NoopPolicyInput, NoopPolicyOutcome };

/** SAFETY: Unified present for a single applied edit — pipeline crosses one seam.
 * Delegates to buildChanged; owns diff + metrics + warnings + drift folding.
 */
export function presentChanged(
	input: SuccessInput,
): ReturnType<typeof buildChanged> {
	return buildChanged(input);
}

/** SAFETY: Unified present for a noop — owns noop shaping + metrics.
 */
export function presentNoop(input: NoopInput): ReturnType<typeof buildNoop> {
	return buildNoop(input);
}

/** SAFETY: Unified present for a batch — owns batch metrics + drift folding.
 */
export function presentBatch(
	sections: BatchSection[],
): ReturnType<typeof buildBatchResult> {
	return buildBatchResult(sections);
}

/** SAFETY: Unified diff seam — owns genDiff with anchor-aware hashing.
 */
export function presentDiff(
	oldContent: string,
	newContent: string,
	contextLines?: number,
	newContentHashes?: string[],
	oldContentHashes?: string[],
): ReturnType<typeof diffGenDiff> {
	return diffGenDiff(
		oldContent,
		newContent,
		contextLines,
		newContentHashes,
		oldContentHashes,
	);
}
