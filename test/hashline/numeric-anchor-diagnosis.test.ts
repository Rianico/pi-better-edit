import { describe, expect, it } from "vitest";
import { DomainError, ERROR_REGISTRY } from "../../src/domain-errors.js";
import { resolveLeasedEdit } from "../../src/hashline/lease-resolve.js";
import { resEdit, type LeaseSpanSource } from "../../src/hashline/resolve.js";

function emptySource(): LeaseSpanSource {
  return {
    currentSnapshotHash: "C",
    leaseFor: () => undefined,
    rebasedLineOf: () => undefined,
    anchorHomes: () => [],
  };
}

describe("E_UNKNOWN_ANCHOR numeric-anchor diagnosis", () => {
  it("single 3-digit anchor notes that it resembles a line number", () => {
    const error = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["833"] });
    expect(error.code).toBe("E_UNKNOWN_ANCHOR");
    expect(error.message.startsWith("[MODEL] [E_UNKNOWN_ANCHOR] ")).toBe(true);
    expect(error.message).toContain('a.py has not served the anchor "833"; nothing was written.');
    expect(error.message).toContain('Note: anchor "833" consists only of digits');
    expect(error.message).toContain("resembles a line number");
    expect(error.message).toContain('3-character alphanumeric content hashes (e.g. "aB3")');
  });

  it("non-numeric unknown anchor retains the standard format without the note", () => {
    const error = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["ZZZ"] });
    expect(error.message).toBe(
      '[MODEL] [E_UNKNOWN_ANCHOR] a.py has not served the anchor "ZZZ"; nothing was written.',
    );
    expect(error.message).not.toContain("Note:");
    expect(error.message).not.toContain("line number");
  });

  it("mixed pair notes only the numeric anchor", () => {
    const error = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["ZZZ", "733"] });
    expect(error.message).toContain(
      'has not served the anchors "ZZZ", "733"; nothing was written.',
    );
    expect(error.message).toContain('Note: anchor "733" consists only of digits');
    expect(error.message).not.toContain('"ZZZ" consists');
  });

  it("all-numeric pair uses the plural note naming both anchors", () => {
    const error = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["125", "239"] });
    expect(error.message).toContain('Note: anchors "125", "239" consist only of digits');
    expect(error.message).toContain("resemble line numbers");
  });

  it("all-nonnumeric pair carries no note", () => {
    const error = new DomainError("E_UNKNOWN_ANCHOR", { path: "a.py", anchors: ["ZZZ", "YYY"] });
    expect(error.message).toBe(
      '[MODEL] [E_UNKNOWN_ANCHOR] a.py has not served the anchors "ZZZ", "YYY"; nothing was written.',
    );
    expect(error.message).not.toContain("Note:");
  });

  it("lease resolution surfaces the note for a submitted line number", () => {
    let caught: unknown;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "833", anchor_to: "834", replace_with: "X" }),
        snapshot: {
          fileHashes: ["AAA", "BBB"],
          fileLines: ["a", "b"],
          filePath: "a.py",
        },
        served: [],
        source: emptySource(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe("E_UNKNOWN_ANCHOR");
    expect(err.message).toMatch(/\[MODEL\] \[E_UNKNOWN_ANCHOR\]/);
    expect(err.message).toContain("resemble line numbers");
  });

  it("carries no remedy field per ADR-0021", () => {
    expect(ERROR_REGISTRY.E_UNKNOWN_ANCHOR.remedy).toBeUndefined();
  });
});
