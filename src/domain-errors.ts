/**
 * Domain error registry — the closed, type-safe contract for every negative-path rejection (spec
 * docs/spec/unified-error-and-warning-contract.md section 4, D1). Its imports are pure leaves —
 * `./hashline/alphabet.js` and `./unserved-span-message.js` (→ `./constants.js`): no store, no session.
 * INVARIANT: a code is never declared without a producer — every `DomainErrorCode` member has a
 * `new DomainError(code, payload)` site in src/, and every throw-site code is a union member;
 * asserted BOTH directions in test/arch/domain-error-registry.test.ts.
 * Payload text reports facts. `Options:` renders only for `MODEL`, only on the refusal (never
 * in a prompt or a success path), and only when the moves are neutral, unharmful and fail-closed
 * with the evidence pinning one cause: an explicit list, never one directive; no neutral option,
 * no `Options:` (docs/.archive_adrs/0047-remediation-options-are-refusal-scoped-and-neutral.md).
 */

import { HASH_LEN } from "./hashline/alphabet.js";
import { formatUnservedSpanMessage } from "./unserved-span-message.js";

export type Audience = "MODEL" | "USER";

export type DomainErrorCode =
  | "E_BAD_PAYLOAD"
  | "E_EMPTY_RANGE"
  | "E_STALE_ANCHOR"
  | "E_UNKNOWN_ANCHOR"
  | "E_FOREIGN_ANCHOR"
  | "E_STALE_RANGE"
  | "E_TARGET_LOST"
  | "E_UNVERIFIED_RANGE"
  | "E_UNSERVED_RANGE"
  | "E_MALFORMED_ANCHOR"
  | "E_SUSPICIOUS_TEXT"
  | "E_BATCH_ABORT"
  | "E_NOOP_LOOP"
  | "E_UNSUPPORTED_FILE"
  | "E_ACCESS"
  | "E_NOT_FOUND"
  | "E_UNDO_STALE"
  | "E_UNDO_UNAVAILABLE"
  | "E_LOSSY_TEXT"
  | "E_UNDO_REVERT_FAILED"
  | "E_UNKNOWN"
  | "E_LARGE_FILE"
  | "E_INTERNAL_INVARIANT";

/**
 * The registered tool whose call produced an `E_BAD_PAYLOAD`. WHY the registered name: the model
 * reads the tool list, so `undo_last_edit` names the call it must repair and a short form would
 * name nothing. A tool belongs here only after a live path is measured, never by assumption.
 */
export type PayloadSubject = "read" | "edit" | "undo_last_edit";

const PAYLOAD_SUBJECTS: readonly PayloadSubject[] = ["read", "edit", "undo_last_edit"];

export function isPayloadSubject(value: unknown): value is PayloadSubject {
  return typeof value === "string" && (PAYLOAD_SUBJECTS as readonly string[]).includes(value);
}

/**
 * Applied-tier warning codes — the `W_*` namespace (spec
 * docs/spec/unified-error-and-warning-contract.md sections 3.1, 3.3, D3).
 * A `[W_*]` line reports an applied mutation; `[E_*]` reports a rejection.
 * `formatWarning` is the sole producer of `[W_*]` headers: no raw `[W_*]`
 * header literal may exist outside this module (asserted in
 * test/arch/domain-error-registry.test.ts).
 */
export type DomainWarningCode =
  | "W_NEVER_SERVED_SHAPE"
  | "W_SERVED_PREFIX_MISMATCH"
  | "W_REVERSED_ANCHORS"
  | "W_UNICODE_LITERAL"
  | "W_LITERAL_BYPASS"
  | "W_NOOP"
  | "W_NOOP_INSERT"
  | "W_EOL_REWRITTEN"
  | "W_UNSERVED_INTERIOR";

/**
 * SAFETY: one served row — position is 0-based, hash is the anchor string. Canon evidence is not a
 * row attribute: it is derived on demand from `served_leases.canon_hash`, so no canon text is ever
 * stored (issue #151).
 */
export interface ServedRow {
  position: number;
  hash: string;
}

/**
 * User-facing diagnosis only — never a model remedy, because the code alone selects the retry.
 * Values are GLOSSARY.md glossary terms.
 */
export type RangeCause =
  | "retirement"
  | "never-served"
  | "served-range staleness"
  | "anchor staleness"
  | "served span";

/**
 * `src/error-envelope.ts` validates through this list, so `MutationFailure.cause` cannot claim a
 * diagnosis outside the union; a non-registry string stays unknown.
 */
const RANGE_CAUSES: readonly RangeCause[] = [
  "retirement",
  "never-served",
  "served-range staleness",
  "anchor staleness",
  "served span",
];

export function isRangeCause(value: unknown): value is RangeCause {
  return typeof value === "string" && (RANGE_CAUSES as readonly string[]).includes(value);
}

export interface ErrorPayloadMap {
  E_BAD_PAYLOAD: {
    message: string;
    /**
     * The invoking tool, when the boundary knows it. WHY optional: an absent subject renders the
     * neutral wording, while a required field would force every producer to claim a writer it
     * cannot prove — the defect this field removes.
     */
    subject?: PayloadSubject;
  };
  E_EMPTY_RANGE: Record<string, never>;
  E_STALE_ANCHOR: {
    headline: string;
    servedRows?: ServedRow[];
    servedBlock?: string;
    cause: RangeCause;
    firstOffendingLine?: number;
  };
  E_UNKNOWN_ANCHOR: {
    path: string;
    anchors: string[];
  };
  E_FOREIGN_ANCHOR: {
    path: string;
    anchors: string[];
    homes: string[];
  };
  E_STALE_RANGE: {
    headline: string;
    servedRows: ServedRow[];
    servedBlock: string;
    cause: RangeCause;
    firstOffendingLine?: number;
  };
  E_TARGET_LOST: {
    servedLine: number;
    path?: string;
    cause: RangeCause;
    firstOffendingLine?: number;
  };
  E_UNVERIFIED_RANGE: {
    /**
     * (remediation-2 item A) the rowless foreign pass-through needs a file-attributing headline;
     * target-side producers keep `UNVERIFIED_HEADLINE` and a block, byte-identical.
     */
    headline?: string;
    servedRows: ServedRow[];
    servedBlock: string;
    cause: RangeCause;
    firstOffendingLine?: number;
  };
  E_UNSERVED_RANGE: {
    headline: string;
    servedRows: [];
    servedBlock: "";
    cause: RangeCause;
    firstOffendingLine?: number;
  };
  E_MALFORMED_ANCHOR: {
    rawAnchor: string;
    reason: string;
  };
  E_SUSPICIOUS_TEXT: {
    target: "edit" | "write";
    path: string;
    line: number;
    hash: string;
    servedLine: number;
    count: number;
  };
  E_BATCH_ABORT: {
    earlierIndex: number;
    laterIndex: number;
    earlierStart: number;
    earlierEnd: number;
    laterStart: number;
    laterEnd: number;
    path: string;
    /** Reject-and-serve rows behind `servedBlock`, so the envelope union counts every rendered row. */
    servedRows?: ServedRow[];
    servedBlock: string;
  };
  E_NOOP_LOOP: {
    ref: string;
    removeFrom: string;
    removeTo: string;
    count: number;
    batch: boolean;
    servedRows: ServedRow[];
    servedBlock: string;
    /** Rowless changed-buffer variant: names the withheld rows and the bounded current-file read. */
    note?: string;
  };
  E_UNSUPPORTED_FILE: {
    path: string;
    kind: "directory" | "binary" | "image";
    description?: string;
  };
  E_ACCESS: {
    path: string;
    kind: "denied" | "symlink-loop" | "unreachable";
    access?: "read" | "write";
  };
  E_NOT_FOUND: {
    path: string;
  };
  E_UNDO_STALE: {
    path: string;
    reason: "deleted" | "modified";
  };
  E_UNDO_UNAVAILABLE: {
    path: string;
  };
  E_LOSSY_TEXT: {
    path: string;
  };
  E_UNDO_REVERT_FAILED: {
    path: string;
  };
  E_UNKNOWN: {
    errorName: string;
    message: string;
  };
  E_LARGE_FILE: {
    path?: string;
    limitKind: "lines" | "hash-space";
    lineCount?: number;
    limit: number;
  };
  E_INTERNAL_INVARIANT: {
    message: string;
    /**
     * The invoking tool, when the boundary knows it. WHY optional: the same
     * attribution channel as `E_BAD_PAYLOAD` — an absent subject renders the
     * neutral wording, while a required field would force every producer to
     * claim a writer it cannot prove.
     */
    subject?: PayloadSubject;
  };
}

export interface CodeSpec<P> {
  audience: Audience;
  format: (payload: P) => string;
  /**
   * Neutral, refusal-scoped next moves, rendered as `Options: a; or b.` after the
   * format. NEVER on a success path, never in prompt prose. WHY a list: two or
   * more admissible moves keep the model's choice; one directive biases it.
   */
  options?: readonly string[] | ((payload: P) => readonly string[]);
}

/** SAFETY: exact heading for an unverified fresh-read serve — machine-checkable. */
const FRESH_READ_HEADING = "Current range (fresh read):";

/** SAFETY: one general headline clause for an unplaceable bound — no narration. */
export const UNVERIFIED_HEADLINE =
  "a bound of this range no longer resolves to the line identity it was served with.";

function suspiciousTail(count: number): string {
  if (count < 2) return "";
  return ` Identical refusal submitted ${count} times — the bytes still reproduce a served row.`;
}

function suspiciousFormat(payload: ErrorPayloadMap["E_SUSPICIOUS_TEXT"]): string {
  const times = payload.count === 1 ? "time" : "times";
  return (
    `Write/Edit to ${payload.path} rejected: line ${payload.line} starts with the served anchor ` +
    `${payload.hash}│ for line ${payload.servedLine}. (submission ${payload.count} ${times})` +
    suspiciousTail(payload.count)
  );
}

/** Resolve a spec's options for this payload; nothing renders for a USER audience. */
function optionsFor<P>(spec: CodeSpec<P>, payload: P): readonly string[] | undefined {
  if (spec.audience !== "MODEL" || spec.options === undefined) return undefined;
  return typeof spec.options === "function" ? spec.options(payload) : spec.options;
}

/** `Options: a; or b.` — one owned shape for every served remediation. */
function renderOptions(options: readonly string[]): string {
  return `\nOptions: ${options.join("; or ")}.`;
}

function unsupportedFormat(payload: ErrorPayloadMap["E_UNSUPPORTED_FILE"]): string {
  if (payload.kind === "directory") {
    return `Path is a directory: ${payload.path}.`;
  }
  if (payload.kind === "image") {
    return `Path is an image file: ${payload.path}.`;
  }
  return `Path is a binary file: ${payload.path} (${payload.description ?? "binary"}).`;
}

function accessFormat(payload: ErrorPayloadMap["E_ACCESS"]): string {
  if (payload.kind === "symlink-loop") {
    return `Too many symbolic links while resolving: ${payload.path}.`;
  }
  if (payload.kind === "unreachable") {
    return `Cannot access file: ${payload.path}.`;
  }
  const label = payload.access === "write" ? "not writable" : "not readable";
  return `File is ${label}: ${payload.path}.`;
}

function largeFileFormat(payload: ErrorPayloadMap["E_LARGE_FILE"]): string {
  if (payload.limitKind === "hash-space") {
    return (
      `Cannot allocate a unique hash anchor: the file exceeds the ${payload.limit}-line limit ` +
      `for ${HASH_LEN}-char hashline anchors.`
    );
  }
  const observed =
    payload.lineCount === undefined ? `more than ${payload.limit}` : `${payload.lineCount}`;
  const where = payload.path ?? "the file";
  return `${where} has ${observed} lines, exceeding the ${payload.limit}-line edit limit.`;
}

function staleAnchorFormat(payload: ErrorPayloadMap["E_STALE_ANCHOR"]): string {
  if (!payload.servedBlock) return payload.headline;
  return `${payload.headline}\nCurrent range:\n${payload.servedBlock}`;
}

function unknownAnchorFormat(payload: ErrorPayloadMap["E_UNKNOWN_ANCHOR"]): string {
  const anchors = payload.anchors;
  if (anchors.length === 1) {
    return `${payload.path} has not served the anchor "${anchors[0]}".`;
  }
  if (anchors.length === 0) {
    return `${payload.path} has not served an anchor.`;
  }
  return `${payload.path} has not served the anchors ${anchors.map((a) => `"${a}"`).join(", ")}.`;
}

function foreignHomesDisplay(homes: string[]): string {
  if (homes.length <= 3) return homes.join(", ");
  return `${homes.slice(0, 3).join(", ")} and ${homes.length - 3} more`;
}

function foreignAnchorFormat(payload: ErrorPayloadMap["E_FOREIGN_ANCHOR"]): string {
  const anchors = payload.anchors;
  const noun =
    anchors.length === 1
      ? `the anchor "${anchors[0]}"`
      : `the anchors ${anchors.map((a) => `"${a}"`).join(", ")}`;
  const verb = anchors.length === 1 ? "was" : "were";
  const homes = foreignHomesDisplay(payload.homes);
  if (homes.length === 0) {
    return `${noun} ${verb} not served for ${payload.path}.`;
  }
  return `${noun} ${verb} served for ${homes}, not for ${payload.path}.`;
}

export const ERROR_REGISTRY: { [K in DomainErrorCode]: CodeSpec<ErrorPayloadMap[K]> } = {
  E_BAD_PAYLOAD: {
    audience: "MODEL",
    format: ({ message, subject }) =>
      isPayloadSubject(subject)
        ? `The ${subject} payload is not valid: ${message}`
        : `The payload is not valid: ${message}`,
  },
  E_INTERNAL_INVARIANT: {
    audience: "MODEL",
    format: ({ message, subject }) =>
      isPayloadSubject(subject)
        ? `The ${subject} invariant failed: ${message}`
        : `An internal invariant failed: ${message}`,
  },
  E_EMPTY_RANGE: {
    audience: "MODEL",
    format: () => "Cannot empty a non-empty file via edit.",
  },
  E_STALE_ANCHOR: {
    audience: "MODEL",
    format: staleAnchorFormat,
  },
  E_UNKNOWN_ANCHOR: {
    audience: "MODEL",
    format: unknownAnchorFormat,
  },
  E_FOREIGN_ANCHOR: {
    audience: "MODEL",
    format: foreignAnchorFormat,
  },
  E_STALE_RANGE: {
    audience: "MODEL",
    format: ({ headline, servedBlock }) => {
      if (servedBlock === "" && headline === "") {
        throw new TypeError("E_STALE_RANGE: headline must be non-empty when servedBlock is empty");
      }
      return servedBlock === "" ? headline : `${headline}\n${FRESH_READ_HEADING}\n${servedBlock}`;
    },
  },
  E_TARGET_LOST: {
    audience: "MODEL",
    format: ({ servedLine, path }) =>
      `line ${servedLine}${path ? ` in ${path}` : ""} no longer resolves to the line identity it was served with.`,
  },
  E_UNVERIFIED_RANGE: {
    audience: "MODEL",
    format: ({ headline, servedBlock }) => {
      const resolved = headline ?? UNVERIFIED_HEADLINE;
      if (servedBlock === "" && resolved === "") {
        throw new TypeError(
          "E_UNVERIFIED_RANGE: headline must be non-empty when servedBlock is empty",
        );
      }
      return servedBlock === "" ? resolved : `${resolved}\n${FRESH_READ_HEADING}\n${servedBlock}`;
    },
  },
  E_UNSERVED_RANGE: {
    audience: "MODEL",
    format: ({ headline }) => {
      if (headline === "") {
        throw new TypeError("E_UNSERVED_RANGE: headline must be non-empty");
      }
      return headline;
    },
  },
  E_MALFORMED_ANCHOR: {
    audience: "MODEL",
    format: ({ rawAnchor, reason }) => `The anchor "${rawAnchor}" is not valid: ${reason}.`,
  },
  E_SUSPICIOUS_TEXT: {
    audience: "MODEL",
    format: suspiciousFormat,
    options: ({ target }) =>
      target === "write"
        ? [
            "omit the anchors from content and retry",
            'declare mode: "literal" to write the lines verbatim',
          ]
        : [
            "omit the anchors from text and retry with the same anchors",
            'declare mode: "literal" to write the lines verbatim',
          ],
  },
  E_BATCH_ABORT: {
    audience: "MODEL",
    format: ({ earlierIndex, earlierStart, earlierEnd, laterStart, laterEnd, servedBlock }) => {
      const overlapStart = Math.max(earlierStart, laterStart);
      const overlapEnd = Math.min(earlierEnd, laterEnd);
      const head =
        `its span (lines ${laterStart}-${laterEnd}) overlaps edit[${earlierIndex}] ` +
        `(lines ${earlierStart}-${earlierEnd}) at lines ${overlapStart}-${overlapEnd}.`;
      return servedBlock
        ? `${head}\nCurrent range:\n${servedBlock}`
        : `${head} No current range is served.`;
    },
    options: ["merge the overlapping items into one span", "split them across separate calls"],
  },
  E_NOOP_LOOP: {
    audience: "MODEL",
    format: ({ removeFrom, removeTo, count, batch, servedBlock, note }) => {
      const verdict = batch ? "Rejecting the batch." : "Rejected.";
      const base =
        `Identical edit (${removeFrom} → ${removeTo}) submitted ${count} times without change. ` +
        `The range already has this text. ${verdict}`;
      if (note !== undefined && servedBlock === "") return `${base} ${note}`;
      return `${base} Current range:\n${servedBlock}`;
    },
  },
  E_UNSUPPORTED_FILE: {
    audience: "MODEL",
    format: unsupportedFormat,
  },
  E_ACCESS: {
    audience: "MODEL",
    format: accessFormat,
  },
  E_NOT_FOUND: {
    audience: "MODEL",
    format: ({ path }) => `File not found: ${path}.`,
  },
  E_UNDO_STALE: {
    audience: "MODEL",
    format: ({ path, reason }) =>
      reason === "deleted"
        ? `Cannot undo on ${path}: file no longer exists.`
        : `Cannot undo on ${path}: file modified after edit — undo would overwrite changes.`,
  },
  E_UNDO_UNAVAILABLE: {
    audience: "MODEL",
    format: ({ path }) =>
      `Cannot persist undo history to the hash store. The edit was not applied. ${path} is unchanged.`,
    options: ["retry the edit", "use write if the store stays unavailable"],
  },
  E_LOSSY_TEXT: {
    audience: "MODEL",
    format: ({ path }) =>
      `Cannot edit ${path}: its bytes do not round-trip UTF-8. ` +
      `A line-addressed rewrite would destroy the original bytes.`,
  },
  E_UNDO_REVERT_FAILED: {
    audience: "MODEL",
    format: ({ path }) =>
      `Undo of the cut transaction was interrupted: ${path} could not be restored while other ` +
      `files of the transaction already were. No undo history was cleared; the files stay in the ` +
      `half-reverted state the durable repair record describes.`,
  },
  E_UNKNOWN: {
    audience: "MODEL",
    format: ({ errorName, message }) =>
      `Unknown ${errorName}: ${message.split("\n")[0]!.slice(0, 300)}.`,
  },
  E_LARGE_FILE: {
    audience: "MODEL",
    format: largeFileFormat,
    // Ref: docs/.archive_adrs/0047-remediation-options-are-refusal-scoped-and-neutral.md
  },
};

export interface WarningPayloadMap {
  W_NEVER_SERVED_SHAPE: {
    count: number;
  };
  W_SERVED_PREFIX_MISMATCH: {
    k: number;
    anchor: string;
    servedLine: number;
  };
  W_REVERSED_ANCHORS: {
    fromHash: string;
    toHash: string;
  };
  W_UNICODE_LITERAL: {
    line: number;
  };
  W_LITERAL_BYPASS: Record<string, never>;
  W_NOOP: {
    ref: string;
    removeFrom: string;
    removeTo: string;
    batch: boolean;
    count: number;
  };
  W_NOOP_INSERT: {
    ref: string;
    removeFrom: string;
    removeTo: string;
  };
  /**
   * `target` and `source` mirror `LineEnding` and the `eol` ladder rungs respectively, spelled
   * inline because this module sits below edit-diff and eol-config in the import graph and
   * importing them would cycle.
   */
  W_EOL_REWRITTEN: {
    target: "LF" | "CRLF" | "CR";
    source: "env" | "project" | "global" | "file" | "system";
    changed: number;
  };
  /**
   * Absolute old-file lines the edit replaced unseen, plus the replaced-set denominator the
   * shared formatter quotes. Both are facts; the sentence grammar lives in
   * `./unserved-span-message.js` so this voice and the strict refusal cannot drift.
   */
  W_UNSERVED_INTERIOR: {
    unservedLines: readonly number[];
    replacedLineCount: number;
  };
}

function neverServedShapeFormat(payload: WarningPayloadMap["W_NEVER_SERVED_SHAPE"]): string {
  if (payload.count === 1) {
    return (
      "1 replacement line starts with an anchor-shaped token " +
      "never served for this session and file. Applied verbatim."
    );
  }
  return (
    `${payload.count} replacement lines start with anchor-shaped tokens ` +
    "never served for this session and file. Applied verbatim."
  );
}

function servedPrefixMismatchFormat(
  payload: WarningPayloadMap["W_SERVED_PREFIX_MISMATCH"],
): string {
  return (
    `Line ${payload.k} starts with the exact ${payload.anchor}│ anchor ` +
    `served for this session and file for line ${payload.servedLine}, ` +
    "but its content differs from what was served. Applied verbatim."
  );
}

function noopWarnFormat(payload: WarningPayloadMap["W_NOOP"]): string {
  if (payload.batch) {
    return (
      `Identical edit (${payload.ref}) did not change the range. ` +
      "The range already has this text. A resend rejects the batch."
    );
  }
  return (
    `Identical edit (${payload.ref}) did not change the range. ` +
    "The range already has this text. A resend rejects."
  );
}

/**
 * Read-tier warning codes. A read warning reports file state a page observed BEFORE any write, so it
 * is not an applied warning: it carries a bare `[<CODE>]` header with no audience prefix.
 */
export type ReadWarningCode = "W_MIXED_EOL";

/**
 * Read-tier payloads. `target` and `source` mirror the applied tier's and are spelled inline for the
 * same import-cycle reason.
 */
export interface ReadWarningPayloadMap {
  W_MIXED_EOL: {
    crlf: number;
    lf: number;
    cr: number;
    target: "LF" | "CRLF" | "CR";
    source: "env" | "project" | "global" | "file" | "system";
  };
}

/** The kinds present, in the fixed CRLF, LF, CR order — a kind the file never spells is left out. */
function mixedEolFormat(payload: ReadWarningPayloadMap["W_MIXED_EOL"]): string {
  const kinds = [
    ...(payload.crlf > 0 ? [`${payload.crlf} CRLF`] : []),
    ...(payload.lf > 0 ? [`${payload.lf} LF`] : []),
    ...(payload.cr > 0 ? [`${payload.cr} CR`] : []),
  ];
  return (
    `Mixed EOL: ${kinds.join(", ")}. ` +
    `All edits normalize to ${payload.target} (${payload.source}).`
  );
}

export const WARNING_REGISTRY: {
  [K in DomainWarningCode]: CodeSpec<WarningPayloadMap[K]>;
} = {
  W_NEVER_SERVED_SHAPE: {
    audience: "MODEL",
    format: neverServedShapeFormat,
  },
  W_SERVED_PREFIX_MISMATCH: {
    audience: "MODEL",
    format: servedPrefixMismatchFormat,
  },
  W_REVERSED_ANCHORS: {
    audience: "USER",
    format: ({ fromHash, toHash }) =>
      `The anchors were reversed (${fromHash} after ${toHash}). Applied with the range swapped.`,
  },
  W_UNICODE_LITERAL: {
    audience: "USER",
    format: ({ line }) =>
      `Replacement line ${line} contains a literal \\uDDDD sequence. Applied verbatim.`,
  },
  W_LITERAL_BYPASS: {
    audience: "USER",
    format: () => "Served-echo check bypassed by literal declaration.",
  },
  W_NOOP: {
    audience: "USER",
    format: noopWarnFormat,
  },
  W_NOOP_INSERT: {
    audience: "MODEL",
    format: ({ ref, removeFrom, removeTo }) =>
      `Empty insertion ${ref} (${removeFrom} → ${removeTo}) with "before"/"after" and text "" writes ` +
      "nothing. Provide text or drop the item.",
  },
  W_EOL_REWRITTEN: {
    audience: "MODEL",
    format: ({ target, source, changed }) =>
      `EOL normalized to ${target} (${source}): ${changed} terminators changed. ` +
      "Undo restores normalized content.",
  },
  W_UNSERVED_INTERIOR: {
    audience: "MODEL",
    format: ({ unservedLines, replacedLineCount }) =>
      formatUnservedSpanMessage({ voice: "hint", unservedLines, replacedLineCount }),
  },
};

/**
 * SAFETY: the applied tier's sole producer of `[W_*]` headers (`formatReadWarning` owns the read
 * tier). Renders `[<AUDIENCE>] [<W_CODE>] <neutral-observation>`, so every applied-tier warning
 * carries its machine-readable code and audience by construction. The registry owns the neutral
 * observation only: the applied-hint builders append exactly one retained conditional clause after
 * it (never a raw header) — the shared `ANCHOR_PREFIX_REMEDY` on `buildServedEditPrefixNote` and
 * `buildNeverServedEditHint`, a write-specific conditional clause on
 * `buildServedWritePrefixNote`. Each clause is guidance phrased as a conditional reference
 * (`If ... unintended`), not an order.
 */
export function formatWarning<K extends DomainWarningCode>(
  code: K,
  payload: WarningPayloadMap[K],
): string {
  const spec = WARNING_REGISTRY[code] as CodeSpec<WarningPayloadMap[K]>;
  return `[${spec.audience}] [${code}] ${spec.format(payload)}`;
}

/** The read tier's registry: the body only — `formatReadWarning` adds the bare `[<CODE>]` header. */
const READ_WARNING_REGISTRY: {
  [K in ReadWarningCode]: { format: (payload: ReadWarningPayloadMap[K]) => string };
} = {
  W_MIXED_EOL: { format: mixedEolFormat },
};

/**
 * SAFETY: the read tier's sole producer of `[W_*]` headers. It renders a bare `[<CODE>]` header and
 * no audience prefix: the page it trails is already the model's, and the warning reports state the
 * page observed before any write rather than a mutation that happened.
 */
export function formatReadWarning<K extends ReadWarningCode>(
  code: K,
  payload: ReadWarningPayloadMap[K],
): string {
  const spec = READ_WARNING_REGISTRY[code] as { format: (p: ReadWarningPayloadMap[K]) => string };
  return `[${code}] ${spec.format(payload)}`;
}

export class DomainError<K extends DomainErrorCode = DomainErrorCode> extends Error {
  readonly code: K;
  readonly audience: Audience;
  readonly payload: ErrorPayloadMap[K];
  readonly servedRows: ServedRow[];
  readonly servedBlock: string;
  readonly cause?: RangeCause;
  readonly firstOffendingLine?: number;
  readonly details: { cause?: RangeCause; code: K };

  constructor(code: K, payload: ErrorPayloadMap[K]) {
    const spec = ERROR_REGISTRY[code] as CodeSpec<ErrorPayloadMap[K]>;
    const options = optionsFor(spec, payload);
    super(
      `[${spec.audience}] [${code}] ${spec.format(payload)}${options ? renderOptions(options) : ""}`,
    );
    this.name = "DomainError";
    this.code = code;
    this.audience = spec.audience;
    this.payload = payload;
    const fields = payload as {
      servedRows?: ServedRow[];
      servedBlock?: string;
      cause?: RangeCause;
      firstOffendingLine?: number;
    };
    this.servedRows = fields.servedRows ?? [];
    this.servedBlock = fields.servedBlock ?? "";
    if (fields.cause !== undefined) this.cause = fields.cause;
    if (fields.firstOffendingLine !== undefined) {
      this.firstOffendingLine = fields.firstOffendingLine;
    }
    this.details = {
      code,
      ...(fields.cause !== undefined ? { cause: fields.cause } : {}),
    };
  }
}

/**
 * The single cast from an unknown throw to the registry's `E_BAD_PAYLOAD` shape. WHY it is sound:
 * the code check fixes which member's payload this is — `message` plus the optional subject, and no
 * envelope field to lose — which the type system cannot see through the payload union.
 */
function badPayloadOf(error: unknown): ErrorPayloadMap["E_BAD_PAYLOAD"] | undefined {
  if (!(error instanceof DomainError) || error.code !== "E_BAD_PAYLOAD") return undefined;
  // SAFETY: the code gate above selects the registry member whose shape `payload` holds.
  return error.payload as ErrorPayloadMap["E_BAD_PAYLOAD"];
}
/**
 * The raw `{ message, subject? }` payload of a refusal on the payload-subject attribution
 * channel. WHY one cast for two codes: `E_BAD_PAYLOAD` and `E_INTERNAL_INVARIANT` share the
 * shape exactly, so the code gate fixes which member's payload this is — which the type system
 * cannot see through the payload union — with no second mechanism.
 */
function subjectPayloadOf(
  error: unknown,
): { message: string; subject?: PayloadSubject } | undefined {
  if (!(error instanceof DomainError)) return undefined;
  if (error.code !== "E_BAD_PAYLOAD" && error.code !== "E_INTERNAL_INVARIANT") return undefined;
  // SAFETY: the code gate above selects a registry member whose payload holds this shape.
  return error.payload as { message: string; subject?: PayloadSubject };
}

/**
 * The raw `message` of an `E_BAD_PAYLOAD`, for a seam that must re-attribute a refusal the engine
 * already rendered. WHY here: the payload type is registry-owned, so its one cast sits beside it.
 * Returns `undefined` for every other failure, and for anything that is not a DomainError.
 */
export function badPayloadMessageOf(error: unknown): string | undefined {
  return badPayloadOf(error)?.message;
}

/**
 * Attribute a payload-shaped refusal to the tool that raised it. WHY a re-wrap: the model-visible
 * header is composed inside the constructor, so the subject must sit in the payload before
 * construction. WHY both codes: `E_INTERNAL_INVARIANT` shares the payload-subject attribution
 * channel — a re-homed refusal changes code and remedy only, never its tool name. WHY
 * transparent: a foreign failure of any other kind comes back as the SAME object, so a boundary
 * can wrap its whole body without changing abort or any other path.
 */
export function withPayloadSubject<T>(
  error: T,
  subject: PayloadSubject,
): T | DomainError<"E_BAD_PAYLOAD" | "E_INTERNAL_INVARIANT"> {
  if (error instanceof DomainError && error.code === "E_INTERNAL_INVARIANT") {
    const payload = subjectPayloadOf(error);
    if (payload === undefined) return error;
    return new DomainError("E_INTERNAL_INVARIANT", { ...payload, subject });
  }
  const payload = badPayloadOf(error);
  if (payload === undefined) return error;
  return new DomainError("E_BAD_PAYLOAD", { ...payload, subject });
}

/**
 * The batch-abort wrapper carries the inner code as a plain field, so this guard keeps errno-style
 * codes (ENOENT, EACCES) out of the domain contract: only registry members pass.
 */
export function isDomainErrorCode(code: unknown): code is DomainErrorCode {
  return typeof code === "string" && code.startsWith("E_") && code in ERROR_REGISTRY;
}
