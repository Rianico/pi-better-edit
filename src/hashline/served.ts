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
  ServedRejectionError,
  AnchorMismatchError,
  makeServedRejection,
  makeTargetLostRejection,
  TARGET_LOST_RECOVERY,
  type FileSnapshotContext,
  type ServedCode,
  type ServedRow,
  type ResolvedRange,
} from "./served-verification.js";
