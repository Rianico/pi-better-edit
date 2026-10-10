import { describe, expect, it } from "vitest";
import { attachEnvelope, readEnvelope } from "../../src/error-envelope.js";
import { toFailure } from "../../src/mutation-engine/engine.js";
import { DomainError } from "../../src/domain-errors.js";

/**
 * Envelope contract oracle (CAND-4): `src/error-envelope.ts` is the single owner of the
 * five forwarded rejection fields (`code`, `details.cause`, `servedRows`, `servedBlock`,
 * `payloadMessage`) that were previously hand-copied at five sites. This test pins the
 * contract at ONE place: the assembler round-trips all five fields, and the engine's
 * a caught error — registry code keeps its typed route, a non-registry (errno-style)
 * code still lands as `E_UNKNOWN` — is owned by the reader's validation.
 */

describe("error envelope — one assembler/reader for the forwarded rejection fields", () => {
  it("attachEnvelope round-trips all five forwarded fields", () => {
    const err = new Error("[MODEL] wrapped rejection");
    // WHY: `payloadMessage` is single-purpose, so the carrier code must be the one the
    // WHY: reader's gate admits — a foreign code drops that slot (pinned below).
    attachEnvelope(err, {
      code: "E_BAD_PAYLOAD",
      cause: "retirement",
      servedRows: [{ position: 1, hash: "abc" }],
      servedBlock: "abc│b",
      payloadMessage: 'Field "at" needs one line.',
    });
    expect(readEnvelope(err)).toEqual({
      code: "E_BAD_PAYLOAD",
      cause: "retirement",
      servedRows: [{ position: 1, hash: "abc" }],
      servedBlock: "abc│b",
      payloadMessage: 'Field "at" needs one line.',
    });
    // WHY: the wire projection is pinned too: consumers catch `details.cause` off the
    // WHY: thrown error, and `toFailure`'s failure shape carries the {code, cause} twin.
    const wire = err as Error & { code?: unknown; cause?: unknown; details?: unknown };
    expect(wire.code).toBe("E_BAD_PAYLOAD");
    expect(wire.cause).toBe("retirement");
    expect(wire.details).toEqual({ code: "E_BAD_PAYLOAD", cause: "retirement" });
  });

  it("a foreign registry code bearing a payload message still comes out without it", () => {
    const err = new Error("stale anchor");
    attachEnvelope(err, { code: "E_STALE_ANCHOR", payloadMessage: 'Field "at" needs one line.' });
    expect(readEnvelope(err)?.code).toBe("E_STALE_ANCHOR");
    expect(readEnvelope(err)?.payloadMessage).toBeUndefined();
    // WHY: the writer gates too, so reading the carrier directly proves the slot never landed.
    // WHY: `readEnvelope` alone could not show a stamped leak, since the reader hides it.
    expect((err as { payloadMessage?: unknown }).payloadMessage).toBeUndefined();
    // WHY: a blank message is absence, exactly like a blank served block, so the
    // WHY: non-empty clause of the gate needs its own witness.
    const blank = new Error("blank payload message");
    attachEnvelope(blank, { code: "E_BAD_PAYLOAD", payloadMessage: "" });
    expect(readEnvelope(blank)?.payloadMessage).toBeUndefined();
    expect((blank as { payloadMessage?: unknown }).payloadMessage).toBeUndefined();
  });

  it("a non-registry code on a caught error still lands as E_UNKNOWN (errno pass-through keeps its route)", () => {
    const err = new Error("read failed");
    // SAFETY: an errno-style code attached at a foreign seam — the reader must not trust it.
    (err as { code?: string }).code = "ENOENT";
    const failure = toFailure(err);
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.code).toBe("E_UNKNOWN");
      expect(failure.message).toBe("[MODEL] [E_UNKNOWN] Unknown Error: read failed.");
      expect(failure.cause).toBeUndefined();
      expect(failure.details).toBeUndefined();
    }
  });

  it("a registry code on a caught error keeps the typed route and the full envelope", () => {
    const inner = new DomainError("E_STALE_RANGE", {
      headline: "line 2 in probe.ts differs from what was served.",
      servedRows: [{ position: 1, hash: "abc" }],
      servedBlock: "abc│b",
      cause: "retirement",
    });
    const failure = toFailure(inner);
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.code).toBe("E_STALE_RANGE");
      expect(failure.message).toBe(inner.message);
      expect(failure.servedRows).toEqual(inner.servedRows);
      expect(failure.servedBlock).toBe(inner.servedBlock);
      expect(failure.cause).toBe("retirement");
      expect(failure.details).toEqual({ code: "E_STALE_RANGE", cause: "retirement" });
    }
  });
});
