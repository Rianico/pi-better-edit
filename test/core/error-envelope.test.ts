import { describe, expect, it } from "vitest";
import { attachEnvelope, readEnvelope } from "../../src/error-envelope.js";
import { toFailure } from "../../src/mutation-engine/engine.js";
import { DomainError } from "../../src/domain-errors.js";

/**
 * Envelope contract oracle (CAND-4): `src/error-envelope.ts` is the single owner of the
 * four forwarded rejection fields (`code`, `details.cause`, `servedRows`, `servedBlock`)
 * that were previously hand-copied at five sites. This test pins the contract at ONE
 * place: the assembler round-trips all four fields, and the engine's routing decision on
 * a caught error — registry code keeps its typed route, a non-registry (errno-style)
 * code still lands as `E_UNKNOWN` — is owned by the reader's validation.
 */

describe("error envelope — one assembler/reader for the forwarded rejection fields", () => {
  it("attachEnvelope round-trips all four forwarded fields", () => {
    const err = new Error("[MODEL] wrapped rejection");
    attachEnvelope(err, {
      code: "E_STALE_RANGE",
      cause: "retirement",
      servedRows: [{ position: 1, hash: "abc" }],
      servedBlock: "abc│b",
    });
    expect(readEnvelope(err)).toEqual({
      code: "E_STALE_RANGE",
      cause: "retirement",
      servedRows: [{ position: 1, hash: "abc" }],
      servedBlock: "abc│b",
    });
    // WHY: the wire projection is pinned too: consumers catch `details.cause` off the
    // WHY: thrown error, and `toFailure`'s failure shape carries the {code, cause} twin.
    const wire = err as Error & { code?: unknown; cause?: unknown; details?: unknown };
    expect(wire.code).toBe("E_STALE_RANGE");
    expect(wire.cause).toBe("retirement");
    expect(wire.details).toEqual({ code: "E_STALE_RANGE", cause: "retirement" });
  });

  it("a non-registry code on a caught error still lands as E_UNKNOWN (errno pass-through keeps its route)", () => {
    const err = new Error("read failed");
    // SAFETY: an errno-style code attached at a foreign seam — the reader must not trust it.
    (err as { code?: string }).code = "ENOENT";
    const failure = toFailure(err);
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.code).toBe("E_UNKNOWN");
      expect(failure.message).toBe("[MODEL] [E_UNKNOWN] unexpected Error: read failed");
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
