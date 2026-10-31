/**
 * Domain error registry — the closed, type-safe contract for every
 * negative-path rejection (spec docs/spec/unified-error-and-warning-contract.md
 * section 4, D1). Its only import is the dependency-free alphabet leaf
 * (`./hashline/alphabet.js`, which itself imports nothing), so any seam can
 * still throw without wiring a store, session, or hasher.
 *
 * INVARIANT (the point of this module): a code is never declared without a
 * producer. Every `DomainErrorCode` member must have at least one
 * `new DomainError(code, payload)` site in src/, and every code passed at a
 * throw site must be a union member. Asserted BOTH directions in
 * test/arch/domain-error-registry.test.ts. This is what makes the registry a
 * contract instead of a list.
 *
 * WHY: payload text reports facts. A served `Options:` section may appear only
 * when it is neutral, unharmful and fail-closed, AND the evidence pins a single
 * cause. Neutral means an explicit list of admissible next moves that keeps the
 * model's choice — never one directive, because a biased suggestion steers the
 * model's next action. A code with no neutral option declares none and renders
 * facts only.
 *
 * WHY: options live on the refusal, never in a prompt or on a success path. They
 * render only for `MODEL` audience. `E_LARGE_FILE` stays fact-only until its
 * payload can name the invoking tool, because read and edit need different
 * options. `E_SUSPICIOUS_TEXT` is the reference: two options, and the payload
 * arm selects text vs content.
 *
 * See ADR-0047.
 */

import { HASH_LEN } from "./hashline/alphabet.js";

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

// WHY: this is the runtime companion of the `PayloadSubject` union, like `isDomainErrorCode`.
// WHY: Only a member may name a tool.
// WHY: A non-member renders the neutral wording instead.
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
  | "W_NOOP_INSERT";

/**
 * SAFETY: one served row — position is 0-based, hash is the anchor string. Canon evidence is not a
 * row attribute: it is derived on demand from `served_leases.canon_hash`, so no canon text is ever
 * stored (issue #151).
 */
export interface ServedRow {
  position: number;
  hash: string;
}

// WHY: user-facing diagnosis carried as `details.cause` on range-family
// WHY: rejections. Never a model remedy: the code alone selects the retry.
// WHY: Values are GLOSSARY.md glossary terms.
export type RangeCause =
  | "retirement"
  | "never-served"
  | "served-range staleness"
  | "anchor staleness"
  | "served span";

// WHY: the runtime companion of the `RangeCause` union, mirroring `isDomainErrorCode`:
// WHY: the envelope reader (`src/error-envelope.ts`) validates diagnosis values so
// WHY: `MutationFailure.cause` stays honest to its union. Values are registry-owned —
// WHY: a non-registry string is an unknown diagnosis, never a typed one.
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
    // WHY: (remediation-2 item A) the foreign pass-through renders this code with NO rows, which
    // WHY: needs a file-attributing headline; target-side producers keep passing
    // WHY: `UNVERIFIED_HEADLINE` and a non-empty `servedBlock`, so their render is byte-identical.
    headline?: string;
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

// WHY: the anchor width is owned by `HASH_LEN` (`./hashline/alphabet.js`, a
// WHY: dependency-free leaf), so this module derives the count word instead of
// WHY: stating it.
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
    // WHY: the same refusal reaches the model from read, edit and undo_last_edit.
    // WHY: Naming the caller's own tool is what tells it which payload to repair.
    // WHY: A subject outside the union cannot name a tool, so it renders the neutral clause.
    format: ({ message, subject }) =>
      isPayloadSubject(subject)
        ? `The ${subject} payload is not valid: ${message}`
        : `The payload is not valid: ${message}`,
  },
  E_INTERNAL_INVARIANT: {
    audience: "MODEL",
    // WHY: one code covers all internal guards: every re-homed site is a tool-facing
    // WHY: invariant failure with no model-actionable field fix, so one remedy-free
    // WHY: rendering serves all of them. The optional subject keeps the payload
    // WHY: attribution channel, stamped by the same `withPayloadSubject` helper that
    // WHY: stamps `E_BAD_PAYLOAD` — a re-homed refusal changes code and remedy only.
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
    // WHY: the same fresh-read contract as `E_UNVERIFIED_RANGE` (issue #149): the rows served are
    // WHY: the current on-disk range, but a stale served canon is indistinguishable from real disk
    // WHY: drift, so the model must inspect them and decide — never a blind retry with the anchors
    // WHY: that just failed.
    // WHY: (remediation-2 item A) `servedBlock === ""` means NO rows are in the served set for
    // WHY: this rejection — render headline only. Every target-side producer passes a non-empty
    // WHY: block, so their renders stay byte-identical.
    // WHY: (04b §12.2) an empty headline over an empty block would render a header with no
    // WHY: information, so the pair is refused AT CONSTRUCTION, not silently defaulted.
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
    // WHY: same served-or-absent rule as `E_STALE_RANGE`: the fresh-read section appears exactly
    // WHY: when rows are served; an absent-rows rejection renders its headline only.
    // WHY: (04b §12.2) `headline: ""` passed `??` (which only rejects null/undefined) and admitted
    // WHY: the render "[MODEL] [E_UNVERIFIED_RANGE] " — header, no information. An absent headline
    // WHY: takes the non-empty default; an EMPTY one is refused at construction.
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
  E_MALFORMED_ANCHOR: {
    audience: "MODEL",
    format: ({ rawAnchor, reason }) => `The anchor "${rawAnchor}" is not valid: ${reason}.`,
  },
  E_SUSPICIOUS_TEXT: {
    audience: "MODEL",
    format: suspiciousFormat,
    // WHY: the replacement reproduces a served hash echo for this session, path and line.
    // WHY: the refusal proves the served hash echo; two neutral moves leave intent with the model.
    // WHY: the write arm guards `content` and the edit arm `text`, so the first option branches.
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
    format: ({
      earlierIndex,
      laterIndex,
      earlierStart,
      earlierEnd,
      laterStart,
      laterEnd,
      path,
      servedBlock,
    }) => {
      const overlapStart = Math.max(earlierStart, laterStart);
      const overlapEnd = Math.min(earlierEnd, laterEnd);
      return (
        `Overlapping spans in ${path}. Rejected. The file is unchanged.\n` +
        `- edit[${earlierIndex}]: lines ${earlierStart}-${earlierEnd}\n` +
        `- edit[${laterIndex}]: lines ${laterStart}-${laterEnd} ` +
        `(overlaps edit[${earlierIndex}]: lines ${overlapStart}-${overlapEnd})\n` +
        (servedBlock ? `Current range:\n${servedBlock}` : `No current range is served.`)
      );
    },
    // WHY: both moves are structural and preserve intent; neither is preferred.
    options: ["merge the overlapping items into one span", "split them across separate calls"],
  },
  E_NOOP_LOOP: {
    audience: "MODEL",
    // WHY: both arms state the refusal that happened; neither names an item because a wrapped
    // WHY: call already prefixes `edit[i] (path) failed:`.
    format: ({ removeFrom, removeTo, count, batch, servedBlock }) =>
      batch
        ? `Identical edit (${removeFrom} → ${removeTo}) submitted ${count} times without change. ` +
          `The range already has this text. Rejecting the batch. Current range:\n${servedBlock}`
        : `Identical edit (${removeFrom} → ${removeTo}) submitted ${count} times without change. ` +
          `The range already has this text. Rejected. Current range:\n${servedBlock}`,
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
    // WHY: the edit did not apply, so retry is safe; write is the fallback, not the order.
    options: ["retry the edit", "use write if the store stays unavailable"],
  },
  E_LOSSY_TEXT: {
    audience: "MODEL",
    // WHY: (04b-rem P2-3) the admission round-trip guard: anchors are derived from the DECODED
    // WHY: text, so bytes that do not re-encode identically cannot be line-addressed without
    // WHY: destruction — the refusal happens before any mutation, and the cause is OBSERVED (the
    // WHY: decode/encode comparison), never assumed.
    format: ({ path }) =>
      `Cannot edit ${path}: its bytes do not round-trip UTF-8. ` +
      `A line-addressed rewrite would destroy the original bytes.`,
  },
  E_UNDO_REVERT_FAILED: {
    audience: "MODEL",
    // WHY: (04b-rem P2-1) a correlated revert defeated mid-window: some members are already at
    // WHY: their pre bytes, others still at post. Nothing is cleared and nothing is re-attempted
    // WHY: blindly — the durable revert-intent record describes the state and repair completes it.
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
    // WHY: no options — read needs `mode: "verbatim"` and edit needs a split, but the payload
    // WHY: names neither tool. Add `subject` before serving advice (ADR-0047).
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
  // WHY: (ticket-04 §3.6) an empty `text` with "before"/"after" is a NO-OP, not a rejection: the
  // WHY: bytes stay unchanged, the item counts as a noop, and the model channel learns why — the
  // WHY: audience is MODEL because the fix belongs to the next submission, not to the human.
  W_NOOP_INSERT: {
    audience: "MODEL",
    format: ({ ref, removeFrom, removeTo }) =>
      `Empty insertion ${ref} (${removeFrom} → ${removeTo}) with "before"/"after" and text "" writes ` +
      "nothing. Provide text or drop the item.",
  },
};

/**
 * SAFETY: the sole producer of `[W_*]` headers. Renders
 * `[<AUDIENCE>] [<W_CODE>] <neutral-observation>` from the registry, so every
 * applied-tier warning carries its machine-readable code and audience by
 * construction. The registry owns the neutral observation only: the
 * applied-hint builders append exactly one retained conditional clause
 * after it (never a raw header) — the shared `ANCHOR_PREFIX_REMEDY` on
 * `buildServedEditPrefixNote` and `buildNeverServedEditHint`, a
 * write-specific conditional clause on `buildServedWritePrefixNote`. Each
 * clause is guidance phrased as a conditional reference (`If ... unintended`),
 * not an order.
 */
export function formatWarning<K extends DomainWarningCode>(
  code: K,
  payload: WarningPayloadMap[K],
): string {
  const spec = WARNING_REGISTRY[code] as CodeSpec<WarningPayloadMap[K]>;
  return `[${spec.audience}] [${code}] ${spec.format(payload)}`;
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

// WHY: the batch-abort wrapper carries the inner code as a plain field — this
// WHY: guard keeps errno-style codes (ENOENT, EACCES) and unknown strings out
// WHY: of the domain contract: only registry members route the typed path.
export function isDomainErrorCode(code: unknown): code is DomainErrorCode {
  return typeof code === "string" && code.startsWith("E_") && code in ERROR_REGISTRY;
}
