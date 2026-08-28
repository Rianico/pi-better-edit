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

export {
	parseHashRef,
	parseText,
	type Anchor,
} from "./parse.js";

export {
	type HEdit,
	type RHEdit,
	type HTEdit,
	type NEdit,
	type BDup,
	type AutoFix,
	resEdit,
	valEdit,
	stripBarePrefixes,
	stripDiffPrefixes,
	swapReversedRanges,
	findNewEdge,
} from "./resolve.js";

export {
	applyEdit,
	fmtRegion,
	changedRange,
	findEditHashEcho,
	EditHashEchoError,
} from "./apply.js";
