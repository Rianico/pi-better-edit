/**
 * SAFETY: served — thin facade over ServedVerification deep module.
 *
 * All verification logic lives in served-verification.ts (instance-scoped CanonStore,
 * decision-table branching, orphan healing, serve-block building). This file re-exports the
 * public surface so existing importers (`from "./served.js"`) remain stable and so
 * ServedRejectionError identity is singular (defined in served-verification).
 */
export {
  verifyServedRange,
  buildRangeServeRows,
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
