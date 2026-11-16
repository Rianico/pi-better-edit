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
} from "../../src/hashline/hash-identity.js";
import { HASH_SPACE_EXHAUSTED_PAYLOAD } from "../../src/hashline/hash-identity.js";
import { SERVED_MAX_LINES } from "../../src/constants.js";
import { useTestHome, withTempFile, setupReadTest } from "../support/fixtures";

const home = useTestHome();

/**
 * The two ceilings this file pins apart: `MAX_HASH_LINES` (the anchor-space bound, whose full
 * space is scale-infeasible to materialize and trips `MAX_BYTES` first) and
 * `SERVED_MAX_LINES` (the call-wide served budget, derived from the constant and never from the
 * anchor space). Boundary runs therefore sit at `SERVED_MAX_LINES` through the real seams, and
 * the producer bindings are matched against source that is comment- and literal-blanked first,
 * so neither a block comment, a line comment nor a quoted or template body quoting the throw
 * can satisfy `stripComments`' pin.
 */
function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  let blanking = false;
  while (i < code.length) {
    const ch = code[i]!;
    const next = code[i + 1] ?? "";
    if (quote !== null) {
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
    expect(HASH_SPACE).toBe(62 ** HASH_LEN);
    expect(MAX_HASH_LINES).toBe(USABLE_HASH_SPACE);
  });

  it("hashes a bounded line count with unique anchors", () => {
    const content = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n");
    const hashes = contentOnlyHashes(content);
    expect(hashes).toHaveLength(50_000);
    expect(new Set(hashes).size).toBe(50_000);
  });

  it("formats the hash-space E_LARGE_FILE naming the live limit", () => {
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
      expect(SERVED_MAX_LINES).toBe(200_000);
      expect(SERVED_MAX_LINES).not.toBe(MAX_HASH_LINES);
      const seam = readFileSync("src/read.ts", "utf-8");
      expect(/let remainingServedLines = SERVED_MAX_LINES;/.test(seam)).toBe(true);
      expect(/maxLines:\s*remainingServedLines/.test(seam)).toBe(true);
      const budgetSrc = stripComments(readFileSync("src/constants.ts", "utf-8"));
      expect(/^export const SERVED_MAX_LINES = 200_000;$/m.test(budgetSrc)).toBe(true);
      expect(/ALPHA|HASH_LEN|HASH_SPACE|USABLE_HASH_SPACE|MAX_HASH_LINES/.test(budgetSrc)).toBe(
        false,
      );
    });
  });
  it("preserves unique hashes at the boundary through the store path", async () => {
    const content = Array.from({ length: 5_000 }, (_, i) => `x${i}`).join("\n");
    const hashes = await lineHashes(content, home.testPath);
    expect(hashes).toHaveLength(5_000);
    expect(new Set(hashes).size).toBe(5_000);
  });
});

describe("read tool line cap", () => {
  it("rejects over-maxLines files with E_LARGE_FILE limitKind lines before hashing", async () => {
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
    const content = Array.from({ length: 20_000 }, (_, i) => `x${i}`).join("\n");
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { file: "big.ts" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│x0");
      expect(text).toContain("[big.ts (lines 1-2000 of ");
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

  it("refuses a CR-only file above the served budget with the line cap's refusal, not the anchor space's", async () => {
    const content = "x\r".repeat(SERVED_MAX_LINES + 1);
    await withTempFile("cr-only.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const error = await readTool
        .execute("r1", { file: "cr-only.ts" }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (thrown: unknown) => thrown as Error,
        );
      expect(error?.message).toBe(
        `[MODEL] [E_LARGE_FILE] cr-only.ts has ${SERVED_MAX_LINES + 1} lines, exceeding the ${SERVED_MAX_LINES}-line edit limit.`,
      );
    });
  });
  it("reads a file at the served budget without hashing errors", async () => {
    const content = Array.from({ length: SERVED_MAX_LINES }, (_, i) => `x${i}`).join("\n");
    await withTempFile("big.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const result = await readTool.execute("r1", { file: "big.ts" }, undefined, undefined, ctx);
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain("│x0");
      expect(text).toContain("[big.ts (lines 1-2000 of ");
    });
  }, 60_000);

  it("rejects an over-budget file without stating a false total", async () => {
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
      expect("lineCount" in payload).toBe(false);
      expect(err.message).toContain(
        `more than ${SERVED_MAX_LINES} lines, exceeding the ${SERVED_MAX_LINES}-line edit limit`,
      );
    });
  });

  it("reports the exact count on the preloaded path for the same file", async () => {
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
    const at = Array.from({ length: SERVED_MAX_LINES }, (_, i) => `x${i}`).join("\n");
    await withTempFile("at.ts", at, async ({ cwd }) => {
      const prepared = await prepareFile("at.ts", cwd, {});
      expect(prepared.kind).toBe("text");
    });
  });

  it("renders distinct messages for the two limitKinds", () => {
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

  it("verbatim pages a file above the served budget; served still refuses it (one seam)", async () => {
    const content = Array.from({ length: SERVED_MAX_LINES + 1 }, () => "x").join("\n");
    await withTempFile("huge-verbatim.ts", content, async ({ cwd }) => {
      const { readTool, ctx } = setupReadTest(cwd);
      const verbatim = await readTool.execute(
        "v1",
        { file: "huge-verbatim.ts", windows: [{ offset: 1, limit: 3 }], mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      const text = verbatim.content?.[0]?.text ?? "";
      expect(text).toBe(
        `[huge-verbatim.ts (verbatim, lines 1-3 of ${SERVED_MAX_LINES + 1} total)]\nx\nx\nx`,
      );
      expect(verbatim.details?.snapshotId).toBeUndefined();

      await expect(
        readTool.execute("s1", { file: "huge-verbatim.ts" }, undefined, undefined, ctx),
      ).rejects.toThrow(
        new RegExp(`\\[E_LARGE_FILE\\].*exceeding the ${SERVED_MAX_LINES}-line edit limit`),
      );
    });
  });
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
