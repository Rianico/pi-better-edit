import { describe, expect, it, beforeAll } from "vitest";
import { lineHashes, _lineHashesPure } from "./src/hashline";
import { initHasher } from "./src/hashline/hasher";

beforeAll(async () => { await initHasher(); });

describe("format-tolerance probe", () => {
  it("fresh recompute after whitespace-only reformat", async () => {
    // Simulate: read clean file (hashes H0 from pure pass)
    const cleanBefore = "function hello() {\n  const x = 1;\n  return x;\n}\n";
    const H0 = await _lineHashesPure(cleanBefore);
    console.log("H0 (clean before):", H0);

    // Edit: replace last line "}" with messy inserted lines (whitespace-variant)
    const messy = "function hello() {\n  const x = 1;\n  return x;\n}\nfunction   multiply( a:  number,   b:  number )  {\n  return   a  *  b;\n}\n";
    // pipeline computes nextHashes via stable mapping
    const nextHashes = await lineHashes(messy, undefined, {
      content: cleanBefore,
      hashes: H0,
      removedHashes: new Set([H0[3]!]),
    });
    console.log("nextHashes (messy, stable map):", nextHashes);

    // autofix reformats whitespace-only -> clean final
    const cleanAfter = "function hello() {\n  const x = 1;\n  return x;\n}\nfunction multiply(a: number, b: number) {\n  return a * b;\n}\n";
    // NEXT tool invocation loads from disk fresh: snapshot miss (checksum differs) -> pure pass
    const H2 = await _lineHashesPure(cleanAfter);
    console.log("H2 (clean after, fresh pure):", H2);

    // Which anchors from the post-edit diff (nextHashes) survive in H2?
    const surviving = nextHashes.filter(h => H2.includes(h));
    console.log("nextHashes anchors surviving fresh recompute:", surviving);
    console.log("ALL survive?", surviving.length === nextHashes.length);
    expect(true).toBe(true);
  });
});
