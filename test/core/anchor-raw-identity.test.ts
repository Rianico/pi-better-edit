import { beforeAll, describe, expect, it } from "vitest";
import { ANCHOR_GENERATION, contentOnlyHashes } from "../../src/hashline/hash-identity.js";
import { initHasher } from "../../src/hashline/hasher";

/**
 * The identity half of the canon split ([ADR-0013](../../docs/adr/0013-anchor-identity-derives-from-raw-bytes.md)):
 * a served anchor keys on the line's RAW bytes. `canon` still folds the frozen 28-code-point
 * whitespace class, but only as an alignment and verification digest — never as an identity function.
 *
 * WHY these three lines: their canons are byte-identical (`consts="ab";`), so a canon-keyed
 * allocator cannot tell them apart and falls back to its positional probe. Measured before the fix:
 * each line derived alone spelled `BDXy`, and inside one file they spelled `BDXy`, `BEYz`, `BFZ0` —
 * the last two are probe offsets, not identities.
 */
const CANON_EQUAL_LINES = ['const s = "a\u00A0b";', 'const s = "a b";', 'const s = "ab";'];

// WHY: `contentOnlyHashes` reads the wasm hasher synchronously, and the hasher is a worker-level
// WHY: singleton (`isolate: false`). Initialise it here rather than inheriting it from whichever
// WHY: suite the runner happened to execute first: without this the file passes alone by luck of
// WHY: ordering and fails in a fresh worker.
beforeAll(async () => {
  await initHasher();
});

describe("anchor identity derives from raw bytes (#230)", () => {
  it("pins ANCHOR_GENERATION at 2 — the raw-byte seeding generation", () => {
    // WHY: the generation is the only invalidation axis that covers the (path, content) seeding.
    // WHY: Generation 2 seeds on raw bytes; a silent return to canon seeding would leave stale
    // WHY: anchors resolvable against content they no longer denote.
    expect(ANCHOR_GENERATION).toBe(2);
  });

  it("#230: three canon-equal lines derive three distinct, content-derived anchors", async () => {
    const solo: (string | undefined)[] = [];
    for (const line of CANON_EQUAL_LINES) {
      const [anchor] = contentOnlyHashes(`${line}\n`);
      solo.push(anchor);
    }
    // Measured, not recomputed from the allocator: each raw line's own spelling.
    expect(solo).toEqual(["ALH5", "AXEh", "AiAH"]);

    const inFile = contentOnlyHashes(`${CANON_EQUAL_LINES.join("\n")}\n`);
    expect(new Set(inFile).size).toBe(3);
    // WHY: equality with the solo derivation is the observable form of "identity is a function of
    // WHY: the line's own bytes". A canon-keyed allocator fails it: the second and third lines get
    // WHY: probe spellings that depend on their siblings.
    expect(inFile).toEqual(solo);
  });
});
