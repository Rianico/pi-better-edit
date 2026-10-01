import { describe, expect, it, beforeAll } from "vitest";
import { _lineHashesPure } from "../../src/hashline/hash";
import { initHasher } from "../../src/hashline/hasher";
import { applyEdit } from "../../src/hashline/apply";
import { HASH_SEP, canonDigest } from "../../src/hashline/hash-identity";
import type { HEdit } from "../../src/hashline/resolve";

beforeAll(async () => {
  await initHasher();
});

const FILE = "a\nb\nX\nY\nc\n";
const H = _lineHashesPure(FILE);

// WHY: the span-ref arm's internal-seam shape (ticket-02): the target names where the text lands,
// WHY: `source` names the same-file line span to copy from, and `retire` distinguishes move from
// WHY: copy. `content_lines` is the empty placeholder the implementation materializes from the
// WHY: pre-item buffer — the caller never hand-writes copied text.
function spanRefEdit(
  target: [number, number],
  source: [number, number],
  retire: boolean,
  placement?: HEdit["placement"],
): HEdit {
  return {
    content_lines: [],
    hash_bounds: [{ hash: H[target[0] - 1]! }, { hash: H[target[1] - 1]! }],
    ...(placement !== undefined ? { placement } : {}),
    source: {
      bounds: [{ hash: H[source[0] - 1]! }, { hash: H[source[1] - 1]! }],
      retire,
    },
  } as HEdit;
}

function expectErrorCode(run: () => unknown, code: string): void {
  try {
    run();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe("applyEdit — span-ref copy (source survives)", () => {
  it("copies a multi-line source onto a replace target that lies before the source", () => {
    const result = applyEdit(FILE, spanRefEdit([1, 1], [3, 4], false));
    expect(result.content).toBe("X\nY\nb\nX\nY\nc\n");
  });

  it("copies a multi-line source onto a replace target that lies after the source", () => {
    const result = applyEdit(FILE, spanRefEdit([5, 5], [3, 4], false));
    expect(result.content).toBe("a\nb\nX\nY\nX\nY\n");
  });

  it("copies with an insertion placement (before) — a zero-width splice, source untouched", () => {
    const result = applyEdit(FILE, spanRefEdit([2, 2], [3, 4], false, "before"));
    expect(result.content).toBe("a\nX\nY\nb\nX\nY\nc\n");
  });

  it("copies with an insertion placement (after) adjacent to the source — source untouched", () => {
    const result = applyEdit(FILE, spanRefEdit([4, 4], [3, 4], false, "after"));
    expect(result.content).toBe("a\nb\nX\nY\nX\nY\nc\n");
  });

  it("a self-copy is the honest noop — bytes unchanged, noopEdit present", () => {
    const result = applyEdit(FILE, spanRefEdit([2, 2], [2, 2], false));
    expect(result.content).toBe(FILE);
    expect(result.noopEdit).toBeDefined();
  });
});

describe("applyEdit — span-ref move (source retired)", () => {
  it("moves onto a replace target before the source — no duplication, no residue", () => {
    const result = applyEdit(FILE, spanRefEdit([1, 1], [3, 4], true));
    expect(result.content).toBe("X\nY\nb\nc\n");
  });

  it("moves onto a replace target adjacent to (immediately after) the source", () => {
    // The result bytes coincide with a plain target deletion here, so the applied-not-noop status
    // and the retired source span (invariant 7's carrier) are what refute a half-implementation.
    const result = applyEdit(FILE, spanRefEdit([5, 5], [3, 4], true));
    expect(result.content).toBe("a\nb\nX\nY\n");
    expect(result.noopEdit).toBeUndefined();
    expect(result.sourceRange).toEqual({
      startLine: 3,
      endLine: 4,
      startHash: H[2]!,
      endHash: H[3]!,
      delta: -2,
    });
  });

  it("moves onto an insertion target — the retired lines re-enter once, at the point", () => {
    const result = applyEdit(FILE, spanRefEdit([1, 1], [3, 4], true, "after"));
    expect(result.content).toBe("a\nX\nY\nb\nc\n");
  });

  it("a move from a multi-line source onto a single-line target retires the source", () => {
    const result = applyEdit(FILE, spanRefEdit([5, 5], [1, 2], true));
    expect(result.content).toBe("X\nY\na\nb\n");
  });

  it("the degenerate adjacent move is the honest noop — no crash, no write, no double-apply", () => {
    // Insert `X\nY` after line 2 while retiring exactly lines 3..4: the assembled bytes are the
    // pre-item bytes, so this must ride the noop path rather than splice twice.
    const result = applyEdit(FILE, spanRefEdit([2, 2], [3, 4], true, "after"));
    expect(result.content).toBe(FILE);
    expect(result.noopEdit).toBeDefined();
  });

  it("refuses a retired source that overlaps the target with E_BAD_PAYLOAD", () => {
    expectErrorCode(() => applyEdit(FILE, spanRefEdit([3, 4], [4, 5], true)), "E_BAD_PAYLOAD");
    expectErrorCode(() => applyEdit(FILE, spanRefEdit([3, 3], [3, 4], true)), "E_BAD_PAYLOAD");
  });

  it("a copy (no retire) may overlap the target — overlap only matters when retiring", () => {
    const result = applyEdit(FILE, spanRefEdit([3, 4], [4, 5], false));
    expect(result.content).toBe("a\nb\nY\nc\nc\n");
  });
});

describe("applyEdit — span-ref resolution and evidence", () => {
  it("an unresolvable source anchor fails through the existing anchor rejection", () => {
    const edit = spanRefEdit([1, 1], [3, 4], true);
    const withBadSource: HEdit = {
      ...edit,
      source: { bounds: [{ hash: "QQQ" }, { hash: "QQQ" }], retire: true },
    } as HEdit;
    expectErrorCode(() => applyEdit(FILE, withBadSource), "E_UNKNOWN_ANCHOR");
  });

  it("a reversed source bound pair heals like any other span", () => {
    const edit = spanRefEdit([1, 1], [4, 3], true);
    const result = applyEdit(FILE, edit);
    expect(result.content).toBe("X\nY\nb\nc\n");
    expect(result.warnings?.some((w) => w.includes("W_REVERSED_ANCHORS"))).toBe(true);
  });

  it("the served hash echo gate runs on copied lines, with a clean control beside it", () => {
    // The mirror below is base's served state; the file's line 3 is itself a reproducing served
    // row (`H3│gamma`). Copying it WRITES that reproducing line, so the evidence gate must refuse;
    // copying line 4 (plain "delta") must apply — both asserted in one test so the refusal cannot
    // come from the copy path being broken in general.
    const base = "alpha\nbeta\ngamma\ndelta";
    const bh = _lineHashesPure(base);
    const served = [...bh];
    const digests = ["alpha", "beta", "gamma", "delta"].map((line) => canonDigest(line));
    const file2 = `alpha\nbeta\n${bh[2]}${HASH_SEP}gamma\ndelta`;
    const h2 = _lineHashesPure(file2);
    const verification = { filePath: "f.txt", served, canonDigests: digests };

    const badEdit = {
      content_lines: [],
      hash_bounds: [{ hash: h2[0]! }, { hash: h2[0]! }],
      source: { bounds: [{ hash: h2[2]! }, { hash: h2[2]! }], retire: false },
    } as HEdit;
    expectErrorCode(
      () => applyEdit(file2, badEdit, undefined, h2, verification),
      "E_SUSPICIOUS_TEXT",
    );

    const controlEdit = {
      content_lines: [],
      hash_bounds: [{ hash: h2[0]! }, { hash: h2[0]! }],
      source: { bounds: [{ hash: h2[3]! }, { hash: h2[3]! }], retire: false },
    } as HEdit;
    const control = applyEdit(file2, controlEdit, undefined, h2, verification);
    expect(control.content).toBe(`delta\nbeta\n${bh[2]}${HASH_SEP}gamma\ndelta`);
  });
});
