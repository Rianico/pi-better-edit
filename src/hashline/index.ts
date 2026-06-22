

export {
	HASH_LENGTH,
	HASH_PREFIX,
	ANCHOR_LENGTH,
	HASH_FORMAT,
	HASH_CHARS_CLASS,
	HASHLINE_PREFIX_RE,
	HASHLINE_PREFIX_PLUS_RE,
	DIFF_MINUS_RE,
	HASHLINE_BARE_PREFIX_RE,
	computeLineHashes,
	computeLineHash,
	ensureHasherReady,
} from "./hash";

export {
	parseHashRef,
	hashlineParseText,
	type Anchor,
} from "./parse";

export {
	type ResolvedAnchor,
	type HashlineEdit,
	type ResolvedHashlineEdit,
	type HashlineToolEdit,
	type NoopEdit,
	type BoundaryDuplicationWarning,
	describeEdit,
	resolveEditAnchors,
	validateAnchorEdits,
	assertNoBareHashPrefixLines,
	formatMismatchError,
} from "./resolve";

export {
	buildLineIndex,
	applyHashlineEdits,
	computeAffectedLineRange,
	formatHashlineRegion,
	computeChangedLineRange,
} from "./apply";
