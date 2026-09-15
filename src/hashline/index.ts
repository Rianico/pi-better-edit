export {
  HASH_LEN,
  ANCHOR_LEN,
  HASH_SEP,
  HASH_CLASS,
  HASH_SPACE,
  MAX_HASH_LINES,
  HL_PREFIX_PLUS_RE,
  HL_PREFIX_MINUS_RE,
  HL_BARE_PREFIX_RE,
  isValidHashList,
  CANON_VERSION,
  lineHashes,
  _lineHashesPure,
  initHasher,
  canon,
  HashIdentity,
  defaultHashIdentity,
  type HashSnapshotIO,
  type HashPrior,
  type HashOptions,
} from "./hash-identity.js";

export const HASH_PROBE_STRIDE = 3907;

export { parseHashRef, parseText, type Anchor } from "./parse.js";

export {
  type HEdit,
  type RHEdit,
  type HTEdit,
  type NEdit,
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
  ServedHashEchoError,
  buildServedEditMessage,
  buildServedEditPrefixNote,
  buildServedWriteMessage,
  buildServedWritePrefixNote,
  trackServedEditRefusal,
  trackServedWriteRefusal,
  clearServedRefusals,
  LITERAL_BYPASS_NOTICE,
  type ServedHashEchoMatch,
  type ServedPrefixMismatch,
} from "./served-guard.js";
