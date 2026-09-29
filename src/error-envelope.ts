/**
 * SAFETY: single owner of the rejection envelope — the four forwarded fields
 * (`code`, `details.cause`, `servedRows`, `servedBlock`) every rejection carries
 * between its producer and the engine's reader. Before this module each site
 * hand-copied them through `as { code?: string }` casts (batch-abort wrappers,
 * the tool-seam throw, `toFailure`'s sniff), so adding a field meant five edits.
 *
 * Design (chosen over an Error subclass): the wire shape stays plain properties
 * on the caught `Error`, and this module owns BOTH ends — `attachEnvelope` (the
 * only writer) and `readEnvelope` (the only reader/validation seam). A subclass
 * would force `DomainError` — whose public surface the registry tests pin — or
 * the batch wrappers onto a new hierarchy without deepening anything: the
 * wrappers must stay `instanceof Error`-plain while a caught `DomainError` is
 * still routed by class identity in `toFailure`. Adding a fifth envelope field
 * is one `ErrorEnvelope` slot + one line in `attachEnvelope` + one line in
 * `readEnvelope` — never a call-site change.
 *
 * Honesty rule: the read validates, it does not trust. Only a registry member
 * survives in `code` and only a `RangeCause` member in `cause` — errno-style
 * pass-through is not a legitimate use: `toFailure` already routes non-registry
 * codes to `E_UNKNOWN`, so a dropped field changes no routing decision. The
 * writer keeps the `details: { code?, cause }` projection in lockstep with the
 * top-level `cause`, preserving the engine's failure shape; registry-typed
 * fields are forwarded unchanged, while untyped extras on `details` are no
 * longer carried (no in-repo consumer reads them).
 */

import {
  isDomainErrorCode,
  isRangeCause,
  type DomainErrorCode,
  type RangeCause,
  type ServedRow,
} from "./domain-errors.js";

/** The one owned representation of the forwarded rejection fields. */
export interface ErrorEnvelope {
  /** Machine code — registry members only; see the honesty rule above. */
  code?: DomainErrorCode;
  /** User-facing diagnosis (CONTEXT.md); carried as `details.cause` on the wire. */
  cause?: RangeCause;
  /** reject-and-serve rows the model retries from; absence means no rows. */
  servedRows?: ServedRow[];
  /** Pre-rendered serve block; a blank block is absence, never forwarded. */
  servedBlock?: string;
}

/** The wire projection `attachEnvelope` stamps — the single cast site for the envelope fields. */
type EnvelopedError = Error & {
  code?: DomainErrorCode;
  cause?: RangeCause;
  servedRows?: ServedRow[];
  servedBlock?: string;
  details?: { code?: DomainErrorCode; cause: RangeCause };
};

/** The untrusted carrier shape `readEnvelope` validates against. */
type EnvelopeCarrier = {
  code?: unknown;
  cause?: unknown;
  servedRows?: unknown;
  servedBlock?: unknown;
  details?: { cause?: unknown } | undefined;
};

/**
 * Stamp the envelope onto a rejection error. Only defined slots are written; the
 * `cause` slot also materialises its `details: { code?, cause }` projection so a
 * consumer reading `details.cause` sees exactly the top-level diagnosis.
 */
export function attachEnvelope(error: Error, envelope: ErrorEnvelope): void {
  // SAFETY: the only cast of an Error to the envelope wire shape — both ends of the
  // SAFETY: contract live in this module, so call sites never re-declare the fields.
  const carrier = error as EnvelopedError;
  if (envelope.code !== undefined) carrier.code = envelope.code;
  if (envelope.cause !== undefined) {
    carrier.cause = envelope.cause;
    carrier.details = {
      ...(envelope.code !== undefined ? { code: envelope.code } : {}),
      cause: envelope.cause,
    };
  }
  if (envelope.servedRows !== undefined) carrier.servedRows = envelope.servedRows;
  if (envelope.servedBlock !== undefined) carrier.servedBlock = envelope.servedBlock;
}

/**
 * Read the validated envelope off any caught error or failure-shaped object.
 * Returns `undefined` only for a non-object carrier; an object always yields an
 * envelope whose slots are present exactly when they are valid (a blank
 * `servedBlock` is absence). Element typing of `servedRows` is trusted at the
 * seam — same as the engine's previous `as ServedRow[]` — structural checks
 * belong to the row producers, not every reader.
 */
export function readEnvelope(source: unknown): ErrorEnvelope | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const carrier = source as EnvelopeCarrier;
  const envelope: ErrorEnvelope = {};
  if (isDomainErrorCode(carrier.code)) envelope.code = carrier.code;
  const cause = carrier.cause ?? carrier.details?.cause;
  if (isRangeCause(cause)) envelope.cause = cause;
  if (Array.isArray(carrier.servedRows)) {
    // SAFETY: rows are produced by DomainError/serve seams; the array gate is the wire check.
    envelope.servedRows = carrier.servedRows as ServedRow[];
  }
  if (typeof carrier.servedBlock === "string" && carrier.servedBlock.length > 0) {
    envelope.servedBlock = carrier.servedBlock;
  }
  return envelope;
}

/**
 * Unvalidated view of the `code` slot, for the batch promotion rule only:
 * `batchAbortForMany` keys the first-agreeing-code decision off the FIRST item's
 * raw string code — a non-registry head code must suppress the typed route rather
 * than let a later item's code promote, which is `toFailure`'s routing today.
 * Kept here so even the raw view stays one place; every other consumer uses
 * `readEnvelope`'s validated slot.
 */
export function rawCodeOf(source: unknown): string | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const code = (source as EnvelopeCarrier).code;
  return typeof code === "string" ? code : undefined;
}
