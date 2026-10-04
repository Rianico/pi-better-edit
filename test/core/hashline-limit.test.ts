import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain-errors.js";
import { prepareFile } from "../../src/file-content/index.js";
import { readFileSync } from "node:fs";
import {
  _lineHashesPure,
  HASH_LEN,
  HASH_SPACE,
  lineHashes,
  MAX_HASH_LINES,
} from "../../src/hashline";
import { HASH_SPACE_EXHAUSTED_PAYLOAD } from "../../src/hashline/hash-identity.js";
import { READ_MAX_LINES } from "../../src/read.js";
import { useTestHome, withTempFile, setupReadTest } from "../support/fixtures";

const home = useTestHome();

// WHY: the producer pin matches against comment- and literal-blanked source so
// WHY: neither a `/* … */` block, a `// …` line, nor a quoted/template body quoting
// WHY: the throw can satisfy it (a real `throw` call is never inside a literal).
// WHY: The scanner is string-aware (`//` inside a literal never starts a comment).
function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  let blanking = false;
  while (i < code.length) {
    const ch = code[i]!;
    const next = code[i + 1] ?? "";
    if (quote !== null) {
      // WHY: only a template literal can span lines, so only its body is
      // WHY: blanked (newlines kept) — a quoted `throw …` line inside one must
      // WHY: not satisfy the pin, while single/double-quoted code like
      // WHY: `"E_LARGE_FILE"` stays intact for the pin to match.
      if (blanking) out += ch === "\n" ? "\n" : " ";
      else out += ch;
      if (ch === "\\") {
        out += blanking ? " " : next;
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        blanking = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      blanking = ch === "`";
      // WHY: the opening delimiter is blanked for templates (so the body and
      // WHY: the delimiter never match pin text) and kept otherwise.
      out += blanking ? '"' : ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i + 2);
      i = end === -1 ? code.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe("hashline limits", () => {
  it("derives the hash space from the alphabet and hash length", () => {
    // WHY: `62 ** 4 = 14,776,336` lines cannot be materialized, so the space
    // WHY: itself is pinned algebraically — a restated literal here would let
    // WHY: the cap drift from the width the leases actually enforce.
    expect(HASH_SPACE).toBe(62 ** HASH_LEN);
    expect(MAX_HASH_LINES).toBe(HASH_SPACE);
  });

  it("hashes a bounded line count with unique anchors", () => {
    // WHY: full-space enumeration is scale-infeasible at width 4, so a bounded
    // WHY: uniqueness run stands in — it exercises allocation without building
    // WHY: fourteen million lines.
    const content = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n");
    const hashes = _lineHashesPure(content);
    expect(hashes).toHaveLength(50_000);
    expect(new Set(hashes).size).toBe(50_000);
  });

  it("formats the hash-space E_LARGE_FILE naming the live limit", () => {
    // WHY: space exhaustion cannot be triggered (see above), so the error is
    // WHY: constructed directly — the assertion pins that the formatted copy
    // WHY: names the live `HASH_SPACE` limit and the live width, not a stale 3.
    const error = new DomainError("E_LARGE_FILE", {
      limitKind: "hash-space",
      limit: HASH_SPACE,
    });
    expect(error.code).toBe("E_LARGE_FILE");
    expect(error.message).toContain(`${HASH_SPACE}-line limit`);
    expect(error.message).toContain(`${HASH_LEN}-char`);
  });

  describe("capacity bindings", () => {
    it("pins the space-exhaustion producer payload and its binding", () => {
      // WHY: the top-of-space throw cannot be reached (see above), so the
      // WHY: binding is pinned twice — the exported payload constant equals the
      // WHY: live limit, and the producer throw site references that constant.
      // WHY: Inlining a different payload at the throw breaks the source pin.
      // WHY: The match runs on comment-stripped source (a `/* … */` or `// …`
      // WHY: line quoting the call cannot satisfy it) and tolerates an oxfmt
      // WHY: wrap plus trailing comma.
      expect(HASH_SPACE_EXHAUSTED_PAYLOAD).toEqual({
        limitKind: "hash-space",
        limit: HASH_SPACE,
      });
      const producer = stripComments(readFileSync("src/hashline/hash-identity.ts", "utf-8"));
      expect(
        /^\s*throw new DomainError\(\s*"E_LARGE_FILE",\s*HASH_SPACE_EXHAUSTED_PAYLOAD\s*,?\s*\)/m.test(
          producer,
        ),
      ).toBe(true);
    });

    it("pins the read seam cap binding", () => {
      // WHY: the 20 000-line read above passes under any cap in
      // WHY: `(20 000, 14 776 336)`, so the seam binding is pinned directly —
      // WHY: the exported ceiling equals `MAX_HASH_LINES` and the read seam
      // WHY: passes that binding. A smaller hidden cap breaks the source pin.
      expect(READ_MAX_LINES).toBe(MAX_HASH_LINES);
      const seam = readFileSync("src/read.ts", "utf-8");
      expect(/maxLines:\s*READ_MAX_LINES/.test(seam)).toBe(true);
    });
  });
  it("preserves unique hashes at the boundary through the store path", async () => {
    // WHY: same bounded stand-in through persistence — the seam, not the full
    // WHY: fourteen-million-line space, is what this exercises.
    const content = Array.from({ length: 5_000 }, (_, i) => `x${i}`).join("\n");
    const hashes = await lineHashes(content, home.testPath);
    expect(hashes).toHaveLength(5_000);
    expect(new Set(hashes).size).toBe(5_000);
  });
});

describe("read tool line cap", () => {
  it("rejects over-maxLines files with E_LARGE_FILE limitKind lines before hashing", async () => {
    // WHY: the `lines` limitKind is exercised through the loader with an
    // WHY: explicit small cap — building `MAX_HASH_LINES + 1` lines is
    // WHY: scale-infeasible, and the small cap proves the seam enforces the
    // WHY: limit it is given before any hashing work.
    const content = Array.from({ length: 11 }, () => "x").join("\n");
    await withTempFile("eleven.ts", content, async ({ cwd }) => {
      let caught: unknown;
      try {
        await prepareFile("eleven.ts", cwd, { maxLines: 10 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      const err = caught as DomainError;
      expect(err.code).toBe("E_LARGE_FILE");
      expect(err.message).toContain("11 lines, exceeding the 10-line edit limit");
    });
  });

  it("reads a file well within the live seam limit without hashing errors", async () => {
    // WHY: the real seams pass `MAX_HASH_LINES` (read.ts), so a file far below
    // WHY: the fourteen-million-line cap must read cleanly — this proves the
    // WHY: seam tolerates a large load rather than imposing a smaller hidden cap.
    const content = Array.from({ length: 20_000 }, (_, i) => `x${i}`).join("\n");
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { path: "big.ts" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│x0");
      expect(text).toContain("[Showing lines 1-");
    });
  });
});
