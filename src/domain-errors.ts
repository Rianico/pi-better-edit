/**
 * Domain error registry — the closed, type-safe contract for every
 * negative-path rejection (spec docs/spec/unified-error-and-warning-contract.md
 * section 4, D1). Zero dependencies: no imports, so any seam can throw without
 * wiring a store, session, or hasher.
 *
 * INVARIANT (the point of this module): a code is never declared without a
 * producer. Every `DomainErrorCode` member must have at least one
 * `new DomainError(code, payload)` site in src/, and every code passed at a
 * throw site must be a union member. Asserted BOTH directions in
 * test/arch/domain-error-registry.test.ts. This is what makes the registry a
 * contract instead of a list.
 *
 * WHY: payload text reports facts; a remedy clause may appear only when it is
 * helpful, unharmful and fail-closed, AND the evidence pins a single cause.
 * When the intent is ambiguous the payload states the fact and carries NO
 * remedy, because an intent-guessing suggestion steers the model's next
 * action. The remedy field is absent BY RULE for `E_UNKNOWN` (no cause is
 * knowable at all); later tasks add `E_UNKNOWN_ANCHOR`, `E_FOREIGN_ANCHOR`
 * and `E_UNVERIFIED_RANGE` to that set.
 */

export type Audience = "MODEL" | "USER";

export type DomainErrorCode =
  | "E_BAD_PAYLOAD"
  | "E_EMPTY_RANGE"
  | "E_STALE_ANCHOR"
  | "E_STALE_RANGE"
  | "E_TARGET_LOST"
  | "E_UNVERIFIED_RANGE"
  | "E_MALFORMED_ANCHOR"
  | "E_SUSPICIOUS_TEXT"
  | "E_REVERSED_ANCHORS"
  | "E_BATCH_ABORT"
  | "E_NOOP_LOOP"
  | "E_UNSUPPORTED_FILE"
  | "E_ACCESS"
  | "E_NOT_FOUND"
  | "E_UNDO_STALE"
  | "E_UNDO_UNAVAILABLE"
  | "E_UNKNOWN"
  | "E_LARGE_FILE";

/** SAFETY: one served row — position is 0-based, hash is the 3-char anchor. */
export interface ServedRow {
  position: number;
  hash: string;
}

// WHY: user-facing diagnosis carried as `details.cause` on range-family
// WHY: rejections. Never a model remedy: the code alone selects the retry.
// WHY: Values are CONTEXT.md glossary terms.
export type RangeCause =
  | "retirement"
  | "tombstone"
  | "never-served"
  | "served-range staleness"
  | "anchor staleness"
  | "served span";

export interface ErrorPayloadMap {
  E_BAD_PAYLOAD: {
    message: string;
  };
  E_EMPTY_RANGE: Record<string, never>;
  E_STALE_ANCHOR: {
    headline: string;
    servedRows?: ServedRow[];
    servedBlock?: string;
    cause: RangeCause;
    firstOffendingLine?: number;
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
    cause?: RangeCause;
    firstOffendingLine?: number;
  };
  E_UNVERIFIED_RANGE: {
    servedRows: ServedRow[];
    servedBlock: string;
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
  E_REVERSED_ANCHORS: {
    startLine: number;
    endLine: number;
    fromAnchor: string;
    toAnchor: string;
  };
  E_BATCH_ABORT: {
    earlierIndex: number;
    laterIndex: number;
    earlierStart: number;
    earlierEnd: number;
    laterStart: number;
    laterEnd: number;
    path: string;
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
}

export interface CodeSpec<P> {
  audience: Audience;
  format: (payload: P) => string;
  remedy?: string;
}

// WHY: the reject-and-serve retry affordance, owned here so every row-carrying
// WHY: rejection renders it identically.
const RETRY_HINT = "Retry with these anchors (no read needed).";

/** SAFETY: exact heading for an unverified fresh-read serve — machine-checkable. */
export const FRESH_READ_HEADING = "Current range (fresh read):";

/** SAFETY: one general headline clause for an unplaceable bound — no narration. */
export const UNVERIFIED_HEADLINE =
  "a bound of this range no longer resolves to the line identity it was served with.";

/** SAFETY: recovery sentence for a target-lost rejection — the only retry is a read. */
export const TARGET_LOST_RECOVERY =
  "The line you targeted was deleted or replaced; your anchors describe a version of this file that no longer exists. Read the file and re-target.";

// WHY: 3-char is the hashline anchor width (`HASH_LEN`); this module stays
// WHY: zero-dependency so the width is stated, never imported.
const ANCHOR_WIDTH = 3;

function suspiciousTail(count: number): string {
  if (count < 2) return "";
  return (
    ` Identical refusal submitted ${count}× — the bytes still reproduce a served row.` +
    ` Omit the copied anchors from \`replace_with\` and retry with the same anchors, or declare intent with mode: "literal".`
  );
}

function suspiciousFormat(payload: ErrorPayloadMap["E_SUSPICIOUS_TEXT"]): string {
  const submitted = `(submission ${payload.count}×)`;
  if (payload.target === "write") {
    return (
      `Refused write to ${payload.path}: line ${payload.line} begins with ` +
      `the exact ${payload.hash}│ anchor served for this session, path, and line ${payload.servedLine}. ` +
      `HASH│ anchors are tool output, not file content. ` +
      `Retry with file content only (remove the entire copied anchor chain), or declare intent with mode: "literal". ` +
      `Re-read the file for fresh anchors if needed. Nothing was written. ${submitted}` +
      suspiciousTail(payload.count)
    );
  }
  return (
    `Refused edit to ${payload.path}: replacement line ${payload.line} begins with ` +
    `the exact ${payload.hash}│ anchor served for this session, path, and line ${payload.servedLine}. ` +
    `HASH│ anchors are tool output, not file content. ` +
    `Omit the copied anchors from \`replace_with\` and retry with the same anchors, or declare intent with mode: "literal". ` +
    `Re-read the file for fresh anchors if needed. Nothing was written. ${submitted}` +
    suspiciousTail(payload.count)
  );
}

function unsupportedFormat(payload: ErrorPayloadMap["E_UNSUPPORTED_FILE"]): string {
  if (payload.kind === "directory") {
    return (
      `Path is a directory: ${payload.path}. Pass the text file inside it ` +
      `(a file, never a directory) in "file" and retry.`
    );
  }
  if (payload.kind === "image") {
    return (
      `Path is an image file: ${payload.path}. Hashline edit only supports text files; ` +
      `choose a text file and retry.`
    );
  }
  return (
    `Path is a binary file: ${payload.path} (${payload.description ?? "binary"}). ` +
    `Hashline edit only supports text files; choose a text file and retry.`
  );
}

function accessFormat(payload: ErrorPayloadMap["E_ACCESS"]): string {
  if (payload.kind === "symlink-loop") {
    return (
      `Too many symbolic links while resolving: ${payload.path}. ` +
      `Retry with the real file location.`
    );
  }
  if (payload.kind === "unreachable") {
    return (
      `Cannot access file: ${payload.path}. Verify the "file" value exists and is reachable, ` +
      `then retry.`
    );
  }
  const label = payload.access === "write" ? "not writable" : "not readable";
  return `File is ${label}: ${payload.path}. Fix permissions or choose a writable file and retry.`;
}

function largeFileFormat(payload: ErrorPayloadMap["E_LARGE_FILE"]): string {
  if (payload.limitKind === "hash-space") {
    return (
      `Cannot allocate a unique hash anchor: the file exceeds the ${payload.limit}-line limit ` +
      `for ${ANCHOR_WIDTH}-char hashline anchors. For very large files use write or a non-line-based approach.`
    );
  }
  const observed =
    payload.lineCount === undefined ? `more than ${payload.limit}` : `${payload.lineCount}`;
  const where = payload.path ?? "the file";
  return (
    `${where} has ${observed} lines, exceeding the ${payload.limit}-line edit limit. ` +
    `Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.`
  );
}

function staleAnchorFormat(payload: ErrorPayloadMap["E_STALE_ANCHOR"]): string {
  if (!payload.servedBlock) return payload.headline;
  return `${payload.headline}\nCurrent range:\n${payload.servedBlock}\n${RETRY_HINT}`;
}

export const ERROR_REGISTRY: { [K in DomainErrorCode]: CodeSpec<ErrorPayloadMap[K]> } = {
  E_BAD_PAYLOAD: {
    audience: "MODEL",
    format: ({ message }) => message,
  },
  E_EMPTY_RANGE: {
    audience: "MODEL",
    format: () =>
      "Cannot empty a non-empty file via edit. Use `write` if you need to clear the file.",
    remedy: "Use write to clear the file.",
  },
  E_STALE_ANCHOR: {
    audience: "MODEL",
    format: staleAnchorFormat,
    remedy: "Retry with the served rows; no read is needed.",
  },
  E_STALE_RANGE: {
    audience: "MODEL",
    format: ({ headline, servedBlock }) =>
      `${headline}\nCurrent range:\n${servedBlock}\n${RETRY_HINT}`,
    remedy: "Retry with the served rows; no read is needed.",
  },
  E_TARGET_LOST: {
    audience: "MODEL",
    format: ({ servedLine, path }) =>
      `line ${servedLine}${path ? ` in ${path}` : ""} no longer resolves to the line identity it was served with.\n${TARGET_LOST_RECOVERY}`,
    remedy: "Read the file and re-target.",
  },
  E_UNVERIFIED_RANGE: {
    audience: "MODEL",
    format: ({ servedBlock }) => `${UNVERIFIED_HEADLINE}\n${FRESH_READ_HEADING}\n${servedBlock}`,
  },
  E_MALFORMED_ANCHOR: {
    audience: "MODEL",
    format: ({ rawAnchor, reason }) => `Invalid anchor "${rawAnchor}": ${reason}`,
    remedy: "Pass the bare 3-char anchor and retry.",
  },
  E_SUSPICIOUS_TEXT: {
    audience: "MODEL",
    format: suspiciousFormat,
    remedy:
      'Omit the copied anchors from replace_with and retry with the same anchors, or declare intent with mode: "literal".',
  },
  E_REVERSED_ANCHORS: {
    audience: "MODEL",
    format: ({ startLine, endLine, fromAnchor, toAnchor }) =>
      `Refused: range start line ${startLine} is after end line ${endLine} ` +
      `(anchors ${fromAnchor} and ${toAnchor}). Nothing was written; swap anchor_from/anchor_to and retry.`,
    remedy: "Swap anchor_from/anchor_to and retry.",
  },
  E_BATCH_ABORT: {
    audience: "MODEL",
    format: ({
      earlierIndex,
      laterIndex,
      earlierStart,
      earlierEnd,
      laterStart,
      laterEnd,
      path,
      servedBlock,
    }) =>
      `edit[${laterIndex}] (${path}) failed: overlapping spans — edit[${earlierIndex}] targets lines ${earlierStart}-${earlierEnd} ` +
      `and edit[${laterIndex}] targets lines ${laterStart}-${laterEnd} of the same call. ` +
      `Spans in one edits[] call must be disjoint.\n` +
      `The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.` +
      (servedBlock ? ` Current range:\n${servedBlock}` : " Call read() to get fresh anchors.") +
      `\nMerge the overlapping ranges into a single edit (or split them into separate edit calls), then resubmit.`,
    remedy: "Merge the overlapping ranges into a single edit, or split them into separate calls.",
  },
  E_NOOP_LOOP: {
    audience: "MODEL",
    // WHY: the reject arm states the refusal that actually happened — it IS the
    // WHY: rejection, so "resend will reject" misdescribed it.
    format: ({ ref, removeFrom, removeTo, count, batch, servedBlock }) =>
      batch
        ? `${ref}: identical edit (${removeFrom} → ${removeTo}) submitted ${count}×, no changes each time. ` +
          `Range already contains this text; rejecting the batch. Current range:\n${servedBlock}`
        : `identical edit (${removeFrom} → ${removeTo} ${ref}) submitted ${count}×, no changes each time. ` +
          `Range already contains this text; rejecting. Current range:\n${servedBlock}`,
    remedy: "The range already contains the replacement text; send different content.",
  },
  E_UNSUPPORTED_FILE: {
    audience: "MODEL",
    format: unsupportedFormat,
    remedy: "Choose a text file and retry.",
  },
  E_ACCESS: {
    audience: "MODEL",
    format: accessFormat,
  },
  E_NOT_FOUND: {
    audience: "MODEL",
    format: ({ path }) =>
      `File not found: ${path}. Check the "file" value (a text file, never a directory); ` +
      `use ls on the parent directory and retry with the corrected file.`,
    remedy: "Use ls on the parent directory and retry with the corrected file.",
  },
  E_UNDO_STALE: {
    audience: "MODEL",
    format: ({ path, reason }) =>
      reason === "deleted"
        ? `cannot undo on ${path}: file no longer exists.`
        : `cannot undo on ${path}: file modified after edit — undo would overwrite changes.`,
  },
  E_UNDO_UNAVAILABLE: {
    audience: "MODEL",
    format: ({ path }) =>
      `Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. ` +
      `Retry the edit, or use write if the store cannot be recovered.`,
    remedy: "Retry the edit.",
  },
  E_UNKNOWN: {
    audience: "MODEL",
    format: ({ errorName, message }) =>
      `unexpected ${errorName}: ${message.split("\n")[0]!.slice(0, 300)}`,
  },
  E_LARGE_FILE: {
    audience: "MODEL",
    format: largeFileFormat,
    remedy: "Use write or a non-line-based approach for very large files.",
  },
};

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
    super(`[${spec.audience}] [${code}] ${spec.format(payload)}`);
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

// WHY: the batch-abort wrapper carries the inner code as a plain field — this
// WHY: guard keeps errno-style codes (ENOENT, EACCES) and unknown strings out
// WHY: of the domain contract: only registry members route the typed path.
export function isDomainErrorCode(code: unknown): code is DomainErrorCode {
  return typeof code === "string" && code.startsWith("E_") && code in ERROR_REGISTRY;
}

// WHY: transitional carriers for the two refusal-adjacent warning arms the tier
// WHY: task owns. The `[USER]` warn arm of `E_NOOP_LOOP` (count===2) and the
// WHY: healed `[USER] [E_REVERSED_ANCHORS]` notice stay byte-identical here —
// WHY: audience, tier, and wording change in the tier task, which also retires
// WHY: these helpers. They live in this module so no raw header literal exists
// WHY: anywhere else in non-test src/.
export function formatNoopLoopWarn(args: {
  ref: string;
  removeFrom: string;
  removeTo: string;
  batch: boolean;
}): string {
  return args.batch
    ? `[USER] [E_NOOP_LOOP] Notice: ${args.ref} — identical edit no-op'd twice; range already has this text. Resend will reject the batch.`
    : `[USER] [E_NOOP_LOOP] Notice: identical edit (${args.removeFrom} → ${args.removeTo} ${args.ref}) no-op'd twice; range already has this text. Resend will reject.`;
}

export function formatReversedAnchorsHealed(args: {
  fromAnchor: string;
  toAnchor: string;
}): string {
  return (
    `[USER] [E_REVERSED_ANCHORS] anchor_from/anchor_to were reversed ` +
    `(${args.fromAnchor} after ${args.toAnchor}); healed and applied with the range swapped.`
  );
}
