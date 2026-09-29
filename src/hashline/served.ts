/**
 * SAFETY: served — facade fronting the reject-and-serve payload builders, the
 * serve-row/formatting helpers, and their shared types. Verification itself
 * lives in served-verification.ts, where the only live entry point is the
 * lease seam's `verifyRebasedSpan` (#151, imported directly by lease-resolve);
 * the mirror-seam verification surface (`ServedVerification`,
 * `verifyServedRange`) is retired (#10). This file re-exports the
 * public surface so existing importers (`from "./served.js"`) remain stable.
 */
export {
  buildRangeServeRows,
  denseServeRows,
  fmtServedRows,
  servedPositionsOf,
  makeServedRejection,
  makeTargetLostRejection,
  makeStaleAnchorRejection,
  TARGET_LOST_RECOVERY,
  FRESH_READ_HEADING,
  UNVERIFIED_HEADLINE,
  type FileSnapshotContext,
  type RangeCause,
  type ServedCode,
  type ServedRow,
  type ResolvedRange,
} from "./served-verification.js";
export { DomainError, type DomainErrorCode } from "../domain-errors.js";
