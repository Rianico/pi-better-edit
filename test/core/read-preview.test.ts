import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { fmtReadPreview } from "../../src/read";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("fmtReadPreview", () => {
  it("returns empty file marker for empty content", async () => {
    const result = await fmtReadPreview("", {}, undefined, home.testPath);
    expect(result.text).toContain("[File is empty. Use edit to insert content.]");
  });

  it("returns empty file marker for content with only newline", async () => {
    const result = await fmtReadPreview("\n", {}, undefined, home.testPath);
    expect(result.text).toMatch(/^[A-Za-z0-9]{4}│$/);
  });

  it("returns all lines when no offset or limit given", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", {}, undefined, home.testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).toContain("│c");
  });

  it("respects offset parameter", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { offset: 2 }, undefined, home.testPath);
    expect(result.text).toContain("│b");
    expect(result.text).toContain("│c");
    expect(result.text).not.toContain("│a");
  });

  it("respects limit parameter", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { limit: 2 }, undefined, home.testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│c");
  });

  it("carries no footer when limit is less than total lines", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { limit: 2 }, undefined, home.testPath);
    expect(result.text).not.toContain("Use windows");
    expect(result.nextOffset).toBe(3);
    expect(result.shownRange).toEqual({ startLine: 1, endLine: 2 });
  });

  it("carries no footer when offset is beyond start", async () => {
    const result = await fmtReadPreview(
      "a\nb\nc\nd\n",
      { offset: 2, limit: 2 },
      undefined,
      home.testPath,
    );
    expect(result.text).not.toContain("Use windows");
    expect(result.shownRange).toEqual({ startLine: 2, endLine: 3 });
    expect(result.nextOffset).toBe(4);
  });

  it("rejects non-positive offset", async () => {
    await expect(
      fmtReadPreview("a\nb\nc\n", { offset: 0 } as any, undefined, home.testPath),
    ).rejects.toThrow("positive integer");
  });

  it("rejects non-positive limit", async () => {
    await expect(
      fmtReadPreview("a\nb\nc\n", { limit: 0 } as any, undefined, home.testPath),
    ).rejects.toThrow("positive integer");
  });

  it("uses precomputed hashes when provided", async () => {
    const hashes = ["AAA", "BBB", "CCC"];
    const result = await fmtReadPreview("a\nb\nc\n", {}, hashes, home.testPath);
    expect(result.text).toContain("AAA│a");
    expect(result.text).toContain("BBB│b");
    expect(result.text).toContain("CCC│c");
  });

  it("skips an oversized first line and shows the rest with the neutral limit notice", async () => {
    const big = "X".repeat(60_000);
    const result = await fmtReadPreview(
      `${big}\na\nb\n`,
      {},
      undefined,
      home.testPath,
      DEFAULT_MAX_BYTES,
    );
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│X");
    expect(result.text).toContain("[Line 1: 58.6KB; not shown.]");
    expect(result.text).toContain(
      "[Line 1 exceeds the 50.0KB limit; the read tool cannot show it.]",
    );
  });

  it("marks an oversized middle line while keeping its neighbors hashable (auto-read budget)", async () => {
    const big = "Y".repeat(60_000);
    const result = await fmtReadPreview(
      `a\n${big}\nc\n`,
      {},
      undefined,
      home.testPath,
      DEFAULT_MAX_BYTES,
    );
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│c");
    expect(result.text).not.toContain("│Y");
    expect(result.text).toContain("[Line 2:");
  });

  it("returns only the warning when every line is oversized (auto-read budget)", async () => {
    const big = "Z".repeat(60_000);
    const result = await fmtReadPreview(
      `${big}\n`,
      {},
      undefined,
      home.testPath,
      DEFAULT_MAX_BYTES,
    );
    expect(result.text).not.toMatch(/[A-Za-z0-9]{4}│/);
    expect(result.text).toContain("exceeds the 50.0KB limit");
    expect(result.text).toContain("the read tool cannot show it");
    expect(result.nextOffset).toBeUndefined();
  });

  it("offers continuation past a skipped oversized line", async () => {
    const big = "W".repeat(210_000);
    const content = ["a", big, "b", "c", "d", "e"].join("\n");
    const result = await fmtReadPreview(content, { limit: 3 }, undefined, home.testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│W");
    expect(result.text).toContain("[Line 2:");
    expect(result.nextOffset).toBe(4);
    expect(result.text).not.toContain("Use windows");
  });

  it("withholds a 60KB line under the one default row budget (pi's 50KB)", async () => {
    const big = "V".repeat(60_000);
    const result = await fmtReadPreview(`${big}\nb\n`, {}, undefined, home.testPath);
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│V");
    expect(result.text).toContain("[Line 1:");
    expect(result.text).toContain("exceeds the 50.0KB limit");
  });

  it("shows a line just under the default budget in full", async () => {
    const big = "U".repeat(51_000);
    const result = await fmtReadPreview(`${big}\n`, {}, undefined, home.testPath);
    expect(result.text).toMatch(new RegExp(`^[A-Za-z0-9]{4}│U{51000}$`));
    expect(result.text).not.toContain("content not shown");
  });

  it("marks a line over the default budget with the neutral limit notice", async () => {
    const big = "T".repeat(210_000);
    const result = await fmtReadPreview(`${big}\n`, {}, undefined, home.testPath);
    expect(result.text).not.toMatch(/[A-Za-z0-9]{4}│/);
    expect(result.text).toContain("exceeds the 50.0KB limit");
    expect(result.text).toContain(
      "[Line 1 exceeds the 50.0KB limit; the read tool cannot show it.]",
    );
    expect(result.nextOffset).toBeUndefined();
  });

  it("states an oversized line without naming a shell or a path placeholder", async () => {
    const content = `a\n${"X".repeat(60_000)}\nb\n`;
    const served = await fmtReadPreview(content, {}, undefined, home.testPath, DEFAULT_MAX_BYTES);
    const verbatim = await fmtReadPreview(
      content,
      { render: "verbatim" },
      undefined,
      home.testPath,
      DEFAULT_MAX_BYTES,
    );
    for (const text of [served.text, verbatim.text]) {
      expect(text).not.toMatch(/\b(?:bash|sed|powershell)\b|head -c|<path>/i);
      expect(text).toContain("[Line 2: 58.6KB; not shown.]");
      expect(text).toContain("[Line 2 exceeds the 50.0KB limit; the read tool cannot show it.]");
    }
  });
});

describe("fmtReadPreview — oversized marker truncation", () => {
  it("continues past a truncated marker list without skipping hidden rows", async () => {
    const big1 = "X".repeat(1000);
    const big2 = "Y".repeat(1000);
    const content = `a\n${big1}\n${big2}\nb\n`;
    const budget = 40;

    const first = await fmtReadPreview(content, {}, undefined, home.testPath, budget);
    expect(first.text).toContain("│a");
    expect(first.text).toContain("[Line 2:");
    expect(first.text).not.toContain("│b");
    expect(first.text).not.toContain("Line 3");
    expect(first.text).not.toContain("Use windows");
    expect(first.nextOffset).toBe(3);

    const second = await fmtReadPreview(content, { offset: 3 }, undefined, home.testPath, budget);
    expect(second.text).toContain("[Line 3:");
    expect(second.text).toContain("│b");
    expect(second.nextOffset).toBeUndefined();
  });
});

describe("fmtReadPreview — maxTruncLines budget", () => {
  it("caps truncated output lines via maxTruncLines", async () => {
    const content = ["l1", "l2", "l3", "l4", "l5"].join("\n") + "\n";
    const result = await fmtReadPreview(content, {}, undefined, home.testPath, undefined, 3);
    expect(result.text).toContain("│l1");
    expect(result.text).toContain("│l3");
    expect(result.text).not.toContain("│l4");
    expect(result.text).not.toContain("Use windows");
    expect(result.nextOffset).toBe(4);
    expect(result.shownRange).toEqual({ startLine: 1, endLine: 3 });
  });

  it("caps oversized-marker rows via maxTruncLines with continuation", async () => {
    const big = "X".repeat(60_000);
    const content = `${big}\n${big}\n${big}\nb\n`;
    const result = await fmtReadPreview(
      content,
      {},
      undefined,
      home.testPath,
      DEFAULT_MAX_BYTES,
      2,
    );
    expect(result.text).toContain("[Line 1:");
    expect(result.text).toContain("[Line 2:");
    expect(result.text).not.toContain("[Line 3:");
    expect(result.text).not.toContain("│b");
    expect(result.text).not.toContain("Use windows");
    expect(result.nextOffset).toBe(3);
  });
});

describe("fmtReadPreview — multi-window budget vs intrinsic line cap", () => {
  const BIG = 40_000;
  const MID = 25_000;

  function page(): string {
    return ["x".repeat(BIG), "short two", "y".repeat(MID), "tiny"].join("\n") + "\n";
  }

  it("omits a recoverable window under the default budget and keeps a later window renderable", async () => {
    const result = await fmtReadPreview(
      page(),
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 1 },
          { offset: 4, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain(
      "[Window does not fit in the remaining 10.9KB read budget; not shown. Re-read it on its own.]",
    );
    expect(result.text).not.toContain("exceeds the");
    expect(result.text).not.toContain("cannot show");
    expect(result.text).toContain("[Lines 4-4 of 4 total]");
    expect(result.served.map((row) => row.position)).toEqual([0, 3]);
    expect(result.truncation?.truncated).toBe(true);
    expect(result.truncation?.truncatedBy).toBe("bytes");
    expect(result.text).not.toContain("y".repeat(1000));
    expect(result.text.length).toBeLessThan(41_000);
  });

  it("omits a recoverable window under a custom 200KB budget (160KB then 100KB)", async () => {
    const content =
      ["a".repeat(160 * 1024), "short two", "c".repeat(100 * 1024), "tiny"].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
      200 * 1024,
    );
    expect(result.text).toContain(
      "[Window does not fit in the remaining 40.0KB read budget; not shown. Re-read it on its own.]",
    );
    expect(result.text).not.toContain("exceeds the");
    expect(result.text).not.toContain("cannot show");
    expect(result.served.map((row) => row.position)).toEqual([0]);
    expect(result.truncation?.truncatedBy).toBe("bytes");
    expect(result.text).not.toContain("c".repeat(1000));
  });

  it("stops a mixed later window at the budget in its header and serves only the rows shown", async () => {
    const content = ["x".repeat(BIG), "short two", "y".repeat(MID), "after"].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 2, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toMatch(
      /\[Lines 2-2 of 4 total; stopped at 10\.9KB\]\n[A-Za-z0-9]{4}│short two$/,
    );
    expect(result.text).not.toContain("[Line 3: ");
    expect(result.text).not.toContain("exceeds the");
    expect(result.served.map((row) => row.position)).toEqual([0, 1]);
    expect(result.truncation?.truncatedBy).toBe("bytes");
  });

  it("cites the intrinsic cap for an oversized line in a later window", async () => {
    const content = ["x".repeat(BIG), "short two", "z".repeat(60_000), "after"].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("[Line 3: 58.6KB; not shown.]");
    expect(result.text).toContain(
      "[Line 3 exceeds the 50.0KB limit; the read tool cannot show it.]",
    );
    expect(result.text).not.toContain("10.9KB limit");
    expect(result.served.map((row) => row.position)).toEqual([0]);
  });

  it("treats a mixed window with a leading recoverable row over budget as an omission", async () => {
    const content =
      ["x".repeat(BIG), "short two", "y".repeat(MID), "z".repeat(60_000)].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 3, limit: 2 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain(
      "[Window does not fit in the remaining 10.9KB read budget; not shown. Re-read it on its own.]",
    );
    expect(result.text).not.toContain("exceeds the");
    expect(result.text).not.toContain("[Line 4: ");
    expect(result.served.map((row) => row.position)).toEqual([0]);
    expect(result.truncation?.truncatedBy).toBe("bytes");
  });

  it("shows a mixed window's placeholder plus the intrinsic warning and stops before the next row", async () => {
    const content =
      ["x".repeat(BIG), "short two", "z".repeat(60_000), "y".repeat(MID)].join("\n") + "\n";
    const result = await fmtReadPreview(
      content,
      {
        windows: [
          { offset: 1, limit: 1 },
          { offset: 2, limit: 3 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(result.text).toContain("[Lines 2-3 of 4 total; stopped at 10.9KB]");
    expect(result.text).toContain("[Line 3: 58.6KB; not shown.]");
    expect(result.text).toContain(
      "[Line 3 exceeds the 50.0KB limit; the read tool cannot show it.]",
    );
    expect(result.text).not.toContain("[Line 4: ");
    expect(result.served.map((row) => row.position)).toEqual([0, 1]);
  });
});
