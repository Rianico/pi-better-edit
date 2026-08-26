/**
 * served — thin facade over ServedVerification deep module.
 *
 * All verification logic lives in served-verification.ts (instance-scoped CanonStore,
 * decision-table branching, orphan healing, echo building). This file re-exports the
 * public surface so existing importers (`from "./served"`) remain stable and so
 * ServedRejectionError identity is singular (defined in served-verification).
 */
export {
	ServedVerification,
	verifyServedRange,
	verifyServedRangeResult,
	buildRangeEcho,
	fmtServedRows,
	servedPositionsOf,
	isServedRejection,
	isAnchorMismatch,
	ServedRejectionError,
	AnchorMismatchError,
	type ServedCode,
	type ServedRow,
	type ResolvedRange,
	type VerificationRange,
	type VerificationInput,
	type VerificationResult,
} from "./served-verification";

// Re-export CanonStore adapters so callers can inject an isolated store
// without importing hash directly — keeps served boundary self-contained.
export {
	createCanonStore,
	createCanonStoreFromEntries,
	globalCanonStore,
	__clearGlobalCanonStoreForTest,
	__globalCanonEntriesForTest,
	type CanonStore,
} from "./hash";
