export {
  HASH_LEN,
  ANCHOR_LEN,
  HASH_SEP,
  HASH_CLASS,
  HASH_SPACE,
  USABLE_HASH_SPACE,
  DIGIT_ANCHOR_RE,
  MAX_HASH_LINES,
  isValidHashList,
  CANON_VERSION,
  lineHashes,
  _lineHashesPure,
  initHasher,
  canon,
  canonDigest,
  HashIdentity,
  defaultHashIdentity,
  type HashSnapshotIO,
  type HashPrior,
  type HashOptions,
  HASH_PROBE_STRIDE,
} from "./hash-identity.js";

export { parseHashRef, parseText, type Anchor } from "./parse.js";

export {
  type HEdit,
  type RHEdit,
  type HTEdit,
  type NEdit,
  type SpanSourceRef,
  type LeaseIdentityView,
  type LeaseSpanSource,
  resEdit,
  valEdit,
  swapReversedRanges,
  isUniformLeaseFastPath,
  resolveLineIdentity,
  uniqueAnchorLine,
  uniqueServedPosition,
} from "./resolve.js";

export { resolveLeasedEdit, type LeasedEditResolution } from "./lease-resolve.js";

export { applyEdit, fmtRegion, changedRange, type ApplyVerificationContext } from "./apply.js";

export {
  findServedHashEcho,
  findServedPrefixMismatches,
  findNeverServedAnchorShapes,
  ServedHashEchoError,
  buildServedEditMessage,
  buildServedEditPrefixNote,
  buildServedWriteMessage,
  buildServedWritePrefixNote,
  buildNeverServedEditHint,
  trackServedEditRefusal,
  trackServedWriteRefusal,
  clearServedRefusals,
  LITERAL_BYPASS_NOTICE,
  type ServedHashEchoMatch,
  type ServedPrefixMismatch,
  type NeverServedAnchorShape,
} from "./served-guard.js";
