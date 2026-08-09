export {
	HASH_LEN,
	ANCHOR_LEN,
	HASH_SEP,
	HASH_CLASS,
	HASH_SPACE,
	HASH_PROBE_STRIDE,
	MAX_HASH_LINES,
	HL_PREFIX_PLUS_RE,
	HL_PREFIX_MINUS_RE,
	HL_BARE_PREFIX_RE,
	lineHashes,
	_lineHashesPure,
	initHasher,
	canon,
} from "./hash";

export {
	parseHashRef,
	parseText,
	type Anchor,
} from "./parse";

export {
	type RAnchor,
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
	fmtMismatch,
	findNewEdge,
} from "./resolve";

export {
	buildIdx,
	applyEdit,
	fmtRegion,
	changedRange,
} from "./apply";
