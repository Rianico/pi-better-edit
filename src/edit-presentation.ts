/**
 * EditPresentation — deep module owning Result Presentation seam.
 *
 * Collapses the shallow Result Presentation cluster (edit-diff, edit-render,
 * edit-response, drift, noop-guard) behind one seam. Pipeline and edit tool
 * cross one seam; internals remain private to this module but are re-exported
 * for backward compatibility where existing callers still import the old paths.
 *
 * Internal seams (diff, render, response, drift, noop) are not part of the
 * public contract — tests hit the unified present* interface. Two adapters
 * justify the seam: live pipeline and preview path.
 *
 * Note: drift.ts is single-range on this branch (main). Interval-aware
 * drift (C4) lives on a separate feat branch; this module keeps compatible
 * with the single-range ResolvedRange interface.
 */

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

// ---------------------------------------------------------------------------
// Re-exports — single seam for pipeline/edit tool
// ---------------------------------------------------------------------------

// diff
export { diffGenDiff as genDiff, detectEnding, toLF, restoreEndings, stripBOM };
export type { LineEnding };

// render
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

// response
export {
	buildMetrics,
	buildNoop,
	buildChanged,
	buildBatchResult,
	finalizeResult,
	finalizeToolResult,
};
export type { EditDetails, RMetrics, NoopInput, SuccessInput, BatchSection };

// drift
export { computeDrift, scanDrift };

// noop
export { runNoopPolicy, clearNoopLoop };
export type { NoopPolicyInput, NoopPolicyOutcome };

// ---------------------------------------------------------------------------
// Unified presentation seam — one interface for pipeline
// ---------------------------------------------------------------------------

/**
 * Unified present for a single applied edit — pipeline crosses one seam.
 * Delegates to buildChanged; owns diff + metrics + warnings + drift folding.
 */
export function presentChanged(input: SuccessInput): ReturnType<typeof buildChanged> {
	return buildChanged(input);
}

/**
 * Unified present for a noop — owns noop shaping + metrics.
 */
export function presentNoop(input: NoopInput): ReturnType<typeof buildNoop> {
	return buildNoop(input);
}

/**
 * Unified present for a batch — owns batch metrics + drift folding.
 */
export function presentBatch(sections: BatchSection[]): ReturnType<typeof buildBatchResult> {
	return buildBatchResult(sections);
}

/**
 * Unified diff seam — owns genDiff with anchor-aware hashing.
 */
export function presentDiff(
	oldContent: string,
	newContent: string,
	contextLines?: number,
	newContentHashes?: string[],
	oldContentHashes?: string[],
): ReturnType<typeof diffGenDiff> {
	return diffGenDiff(oldContent, newContent, contextLines, newContentHashes, oldContentHashes);
}
