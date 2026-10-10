/**
 * SAFETY: single owner of the rejection envelope. The five forwarded fields are `code`,
 * `details.cause`, `servedRows`, `servedBlock`, and `payloadMessage`. Every rejection carries
 * them from its producer to the engine's reader. Before this module each site
 * hand-copied them through `as { code?: string }` casts (batch-abort wrappers,
 * the tool-seam throw, `toFailure`'s sniff), so adding a field meant five edits.
 *
 * Design (chosen over an Error subclass): the wire shape stays plain properties
 * on the caught `Error`, and this module owns BOTH ends — `attachEnvelope` (the
 * only writer) and `readEnvelope` (the only reader/validation seam). A subclass
 * would force `DomainError` — whose public surface the registry tests pin — or
 * the batch wrappers onto a new hierarchy without deepening anything: the
 * wrappers must stay `instanceof Error`-plain while a caught `DomainError` is
 * still routed by class identity in `toFailure`. Adding a sixth envelope field
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
  DomainError,
  isDomainErrorCode,
  isRangeCause,
  withPayloadSubject,
  type DomainErrorCode,
  type PayloadSubject,
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
  /**
   * The raw `E_BAD_PAYLOAD` payload message a ROUTED refusal had to carry: the engine turns a
   * thrown refusal into `code` plus a rendered message, so the tool seam cannot name the invoking
   * tool without the unrendered text. WHY single-purpose rather than a payload bag: only
   * `E_BAD_PAYLOAD` may write it and the reader ignores it under any other code, which keeps the
   * untyped-extras hole this module closes shut.
   */
  payloadMessage?: string;
}

/** The wire projection `attachEnvelope` stamps — the single cast site for the envelope fields. */
type EnvelopedError = Error & {
  code?: DomainErrorCode;
  cause?: RangeCause;
  servedRows?: ServedRow[];
  servedBlock?: string;
  payloadMessage?: string;
  details?: { code?: DomainErrorCode; cause: RangeCause };
};

/** The untrusted carrier shape `readEnvelope` validates against. */
type EnvelopeCarrier = {
  code?: unknown;
  cause?: unknown;
  servedRows?: unknown;
  servedBlock?: unknown;
  payloadMessage?: unknown;
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
  if (envelope.payloadMessage !== undefined) carrier.payloadMessage = envelope.payloadMessage;
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
  // WHY: the slot is single-purpose, so the code gate is part of the validation.
  // WHY: A payload message under any other code is an untyped extra this reader refuses.
  if (
    envelope.code === "E_BAD_PAYLOAD" &&
    typeof carrier.payloadMessage === "string" &&
    carrier.payloadMessage.length > 0
  ) {
    envelope.payloadMessage = carrier.payloadMessage;
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

/**
 * Attribute a routed `E_BAD_PAYLOAD` to the tool at the boundary. WHY this seam: the engine turns a
 * thrown refusal into `code` plus a rendered message, so the raw payload survives only on this
 * envelope — and the header shape stays with the registry, never re-split here. WHY transparent:
 * every other carrier, and every payload slot the reader rejected, comes back as the SAME object.
 */
export function attributePayloadSubject<T>(
  error: T,
  subject: PayloadSubject,
): T | DomainError<"E_BAD_PAYLOAD"> {
  const attributed = withPayloadSubject(error, subject);
  if (attributed !== error) return attributed;
  const envelope = readEnvelope(error);
  if (envelope?.code !== "E_BAD_PAYLOAD" || envelope.payloadMessage === undefined) return error;
  const rebuilt = new DomainError("E_BAD_PAYLOAD", { message: envelope.payloadMessage, subject });
  // WHY: the rebuilt refusal keeps the routed envelope's diagnosis, rows and block intact.
  attachEnvelope(rebuilt, envelope);
  return rebuilt;
}
