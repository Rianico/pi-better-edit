import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain-errors.js";
import { prepareFile } from "../../src/file-content/index.js";
import { readFileSync } from "node:fs";
import {
  contentOnlyHashes,
  HASH_LEN,
  HASH_SPACE,
  USABLE_HASH_SPACE,
  lineHashes,
  MAX_HASH_LINES,
} from "../../src/hashline";
import { HASH_SPACE_EXHAUSTED_PAYLOAD } from "../../src/hashline/hash-identity.js";
import { SERVED_MAX_LINES } from "../../src/constants.js";
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
    // WHY: the raw space cannot be materialized, so it is pinned algebraically —
    // WHY: a restated literal here would let the cap drift from the width the
    // WHY: leases actually enforce. The usable space (minus the reserved
    // WHY: all-digit subcube) is pinned in the reservation test.
    expect(HASH_SPACE).toBe(62 ** HASH_LEN);
    expect(MAX_HASH_LINES).toBe(USABLE_HASH_SPACE);
  });

  it("hashes a bounded line count with unique anchors", () => {
    // WHY: full-space enumeration is scale-infeasible at width 4, so a bounded
    // WHY: uniqueness run stands in — it exercises allocation without building
    // WHY: fourteen million lines.
    const content = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n");
    const hashes = contentOnlyHashes(content);
    expect(hashes).toHaveLength(50_000);
    expect(new Set(hashes).size).toBe(50_000);
  });

  it("formats the hash-space E_LARGE_FILE naming the live limit", () => {
    // WHY: space exhaustion cannot be triggered (see above), so the error is
    // WHY: constructed directly — the assertion pins that the formatted copy
    // WHY: names the live usable-space limit and the live width, not a stale 3.
    const error = new DomainError("E_LARGE_FILE", {
      limitKind: "hash-space",
      limit: USABLE_HASH_SPACE,
    });
    expect(error.code).toBe("E_LARGE_FILE");
    expect(error.message).toContain(`${USABLE_HASH_SPACE}-line limit`);
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
        limit: USABLE_HASH_SPACE,
      });
      const producer = stripComments(readFileSync("src/hashline/hash-identity.ts", "utf-8"));
      expect(
        /^\s*throw new DomainError\(\s*"E_LARGE_FILE",\s*HASH_SPACE_EXHAUSTED_PAYLOAD\s*,?\s*\)/m.test(
          producer,
        ),
      ).toBe(true);
    });

    it("pins the served admission budget binding", () => {
      // WHY: ordinary multi-thousand-line reads pass under the served budget — the
      // WHY: seam binding is pinned directly: the read seam passes the memory
      // WHY: budget, not the anchor-space ceiling. The first pin below refutes a
      // WHY: hidden re-derivation only through its consequence (a moved value);
      // WHY: the declaration-shape pin refutes the spelling (a derived
      // WHY: expression or a re-export stays green on the value assert).
      expect(SERVED_MAX_LINES).toBe(200_000);
      expect(SERVED_MAX_LINES).not.toBe(MAX_HASH_LINES);
      const seam = readFileSync("src/read.ts", "utf-8");
      expect(/maxLines:\s*SERVED_MAX_LINES/.test(seam)).toBe(true);
      const budgetSrc = stripComments(readFileSync("src/constants.ts", "utf-8"));
      // WHY: the declaration is the literal itself — a re-export or a derived
      // WHY: expression reddens here even while the value assert stays green.
      expect(/^export const SERVED_MAX_LINES = 200_000;$/m.test(budgetSrc)).toBe(true);
      // WHY: and the budget's source must not reference the anchor space — the
      // WHY: match runs on comment-stripped source, so the rationale's mention
      // WHY: of the anchor figures cannot satisfy it.
      expect(/ALPHA|HASH_LEN|HASH_SPACE|USABLE_HASH_SPACE|MAX_HASH_LINES/.test(budgetSrc)).toBe(
        false,
      );
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
    // WHY: the real seams pass the served admission budget, so a 20 000-line
    // WHY: file — an order of magnitude under the budget — must read cleanly.
    // WHY: This proves the seams admit realistic large files while the budget,
    // WHY: not the anchor-space ceiling, is the binding cap.
    const content = Array.from({ length: 20_000 }, (_, i) => `x${i}`).join("\n");
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { file: "big.ts" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│x0");
      expect(text).toContain("[Showing lines 1-");
    });
  });
  it("rejects oversized files with E_LARGE_FILE before hashing", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      await expect(
        readTool.execute("r1", { file: "huge.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow("E_LARGE_FILE");
    });
  });

  it("refuses a CR-only file above the cap with the line cap's refusal, not the anchor space's", async () => {
    // WHY: `toLF` rewrites a lone `\r` into a line break, so the count that decides this cap has to be
    // WHY: the NORMALIZED text's. Counting the raw bytes lets a 238,329-line CR-only file through the
    // WHY: cap and into the anchor space, which then refuses the same read with the same error code and
    // WHY: a different reason — after allocating every anchor it was going to refuse.
    const content = "x\r".repeat(MAX_HASH_LINES + 1);
    await withTempFile("cr-only.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const error = await readTool
        .execute("r1", { file: "cr-only.ts" }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (thrown: unknown) => thrown as Error,
        );
      expect(error?.message).toBe(
        `[MODEL] [E_LARGE_FILE] cr-only.ts has ${MAX_HASH_LINES + 1} lines, exceeding the ${MAX_HASH_LINES}-line edit limit. ` +
          "Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.",
      );
    });
  }, 300_000);
  it("reads a file at the limit without hashing errors", async () => {
    const content = Array.from({ length: MAX_HASH_LINES }, (_, i) => `x${i}`).join("\n");
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { file: "big.ts" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│x0");
      expect(text).toContain("[Showing lines 1-");
    });
  }, 300_000);

  it("rejects an over-budget file without stating a false total", async () => {
    // WHY: the boundary file is ~2 MB — comfortably under MAX_BYTES but over the
    // WHY: budget. This is the exposure the widening must not move: admission
    // WHY: refuses on lines long before the anchor space could matter.
    const over =
      Array.from({ length: SERVED_MAX_LINES + 100 }, (_, i) => `x${i}`).join("\n") + "\n";
    await withTempFile("over.ts", over, async ({ cwd }) => {
      let caught: unknown;
      try {
        await prepareFile("over.ts", cwd, {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      const err = caught as DomainError;
      expect(err.code).toBe("E_LARGE_FILE");
      const payload = err.payload as { limitKind: string; limit: number; lineCount?: number };
      expect(payload.limitKind).toBe("lines");
      expect(payload.limit).toBe(SERVED_MAX_LINES);
      // WHY: the streaming counter reports a trip-instant count, not a total — the
      // WHY: payload carries no lineCount and the copy says "more than", never a number.
      expect("lineCount" in payload).toBe(false);
      expect(err.message).toContain(
        `more than ${SERVED_MAX_LINES} lines, exceeding the ${SERVED_MAX_LINES}-line edit limit`,
      );
    });
  });

  it("reports the exact count on the preloaded path for the same file", async () => {
    // WHY: the honest distinction — the preloaded gate counts the materialized
    // WHY: text, so it names the exact total where the streaming path may only say
    // WHY: "more than". Same bytes, same budget, different surfaces.
    const over =
      Array.from({ length: SERVED_MAX_LINES + 100 }, (_, i) => `x${i}`).join("\n") + "\n";
    await withTempFile("over.ts", over, async ({ cwd }) => {
      let caught: unknown;
      try {
        await prepareFile("over.ts", cwd, {
          preloadedFile: { kind: "text", text: over },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      const err = caught as DomainError;
      expect(err.code).toBe("E_LARGE_FILE");
      const payload = err.payload as { limitKind: string; limit: number; lineCount?: number };
      expect(payload.limitKind).toBe("lines");
      expect(payload.limit).toBe(SERVED_MAX_LINES);
      expect(payload.lineCount).toBe(SERVED_MAX_LINES + 100);
      expect(err.message).toContain(
        `has ${SERVED_MAX_LINES + 100} lines, exceeding the ${SERVED_MAX_LINES}-line edit limit`,
      );
    });
  });

  it("admits a file exactly at the budget", async () => {
    // WHY: the boundary is exclusive — budget lines read cleanly, over-budget
    // WHY: refuses. Same ~2 MB scale as the rejection above.
    const at = Array.from({ length: SERVED_MAX_LINES }, (_, i) => `x${i}`).join("\n");
    await withTempFile("at.ts", at, async ({ cwd }) => {
      const prepared = await prepareFile("at.ts", cwd, {});
      expect(prepared.kind).toBe("text");
    });
  });

  it("renders distinct messages for the two limitKinds", () => {
    // WHY: one shape, two ceilings — the copy must tell the served budget
    // WHY: apart from the anchor-space ceiling.
    const lines = new DomainError("E_LARGE_FILE", {
      limitKind: "lines",
      limit: SERVED_MAX_LINES,
      lineCount: SERVED_MAX_LINES + 1,
    });
    const space = new DomainError("E_LARGE_FILE", HASH_SPACE_EXHAUSTED_PAYLOAD);
    expect(lines.message).toContain(
      `${SERVED_MAX_LINES + 1} lines, exceeding the ${SERVED_MAX_LINES}-line edit limit`,
    );
    expect(space.message).toContain(`${USABLE_HASH_SPACE}-line limit`);
    expect(lines.message).not.toBe(space.message);
  });

  it("verbatim pages a file above the anchor-space cap; served still refuses it (one seam)", async () => {
    const content = Array.from({ length: MAX_HASH_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge-verbatim.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const verbatim = await readTool.execute(
        "v1",
        { file: "huge-verbatim.ts", mode: "verbatim", limit: 3 },
        undefined,
        undefined,
        ctx,
      );
      const text = verbatim.content?.[0]?.text ?? "";
      expect(text).toBe(
        `x\nx\nx\n\n[Showing lines 1-3 of ${MAX_HASH_LINES + 1}. Use offset=4 to continue.]`,
      );
      expect(verbatim.details?.snapshotId).toBeUndefined();

      await expect(
        readTool.execute("s1", { file: "huge-verbatim.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow(
        new RegExp(`\\[E_LARGE_FILE\\].*exceeding the ${MAX_HASH_LINES}-line edit limit`),
      );
    });
  }, 300_000);
});

describe("read tool row budget", () => {
  it("withholds a 60KB line through the real read path (pi's 50KB budget)", async () => {
    const big = "X".repeat(60_000);
    await withTempFile("wide.txt", `${big}\nsmall\n`, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { file: "wide.txt" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│small");
      expect(text).not.toContain("│X");
      expect(text).toContain("exceeds 50.0KB");
    });
  });
});
