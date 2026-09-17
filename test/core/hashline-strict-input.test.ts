import { describe, expect, it } from "vitest";
import { applyEdit, lineHashes, resEdit, type HTEdit } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("edit input validation", () => {
  it("writes bare HASH│ bytes through byte-exact", async () => {
    const file = "foo\nbar";
    const hashes = await lineHashes(file, home.testPath);
    const toolEdit: HTEdit = {
      anchor_from: hashes[0]!,
      anchor_to: hashes[0]!,
      replace_with: `${hashes[0]!}│FOO`,
    };
    const result = applyEdit(file, resEdit(toolEdit));
    expect(result.content).toBe(`${hashes[0]!}│FOO\nbar`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("rejects array replace_with before patch-prefix validation", () => {
    const toolEdit: HTEdit = {
      anchor_from: "ZZZ",
      anchor_to: "ZZZ",
      replace_with: ["+ZZZ:foo"],
    } as unknown as HTEdit;
    expect(() => resEdit(toolEdit)).toThrow(
      /must be a string with \\n line separators, not an array/i,
    );
  });

  it("passes through numbered deletion rows as literal content", () => {
    const toolEdit: HTEdit = {
      anchor_from: "ZZZ",
      anchor_to: "ZZZ",
      replace_with: "-1    foo",
    };
    const resolved = resEdit(toolEdit);
    expect(resolved.content_lines).toEqual(["-1    foo"]);
  });

  it("accepts plain literal content unchanged", () => {
    const toolEdit: HTEdit = {
      anchor_from: "ZZZ",
      anchor_to: "ZZZ",
      replace_with: "bar",
    };
    const resolved = resEdit(toolEdit);
    expect(resolved.content_lines).toEqual(["bar"]);
  });

  it("preserves '#' comment lines that do not match the strict prefix", () => {
    const toolEdit: HTEdit = {
      anchor_from: "ZZZ",
      anchor_to: "ZZZ",
      replace_with: "# keep me",
    };
    const resolved = resEdit(toolEdit);
    expect(resolved.content_lines).toEqual(["# keep me"]);
  });
});

describe("partial hash prefixes copied into content (issue #24)", () => {
  const file = "alpha\nbeta\ngamma\ndelta";

  function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
    return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
  }

  it("writes a bare prefix matching a file hash through byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const betaHash = hashes[1]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: `${betaHash}│### heading\nreal content`,
      },
      hashes,
    );
    expect(result.content).toBe(`${betaHash}│### heading\nreal content\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("writes a bare prefix from the file hash set through byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const gammaHash = hashes[2]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: `${gammaHash}│text`,
      },
      hashes,
    );
    expect(result.content).toBe(`${gammaHash}│text\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("writes never-served HASH│ lines through byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "ZZZ│one\nZZP│two",
      },
      hashes,
    );
    expect(result.content).toBe("ZZZ│one\nZZP│two\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([]);
  });

  it("writes mixed literal and HASH│ lines through byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "ZZZ│one\nreal\nZZP│two",
      },
      hashes,
    );
    expect(result.content).toBe("ZZZ│one\nreal\nZZP│two\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([]);
  });

  it("writes leading-space HASH│ bytes through byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: `  ${hashes[1]!}│  indented`,
      },
      hashes,
    );
    expect(result.content).toBe(`  ${hashes[1]!}│  indented\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("accepts a single legit 'TS: TypeScript' line without warning", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "TS: TypeScript",
      },
      hashes,
    );
    expect(result.warnings ?? []).toEqual([]);
    expect(result.content).toContain("TS: TypeScript");
  });

  it("does not false-positive on shorter valid-content prefixes like '#' or '+'", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      { anchor_from: anchor, anchor_to: anchor, replace_with: "# heading" },
      hashes,
    );
    expect(result.warnings ?? []).toEqual([]);
  });

  it("writes long HASH│ lines through byte-exact without truncation", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const betaHash = hashes[1]!;
    const longLine = `${betaHash}│${"y".repeat(500)}`;
    const result = applyTool(
      { anchor_from: anchor, anchor_to: anchor, replace_with: longLine },
      hashes,
    );
    expect(result.content).toBe(`${longLine}\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });
});

describe("diff preview rows copied into content", () => {
  const file = "alpha\nbeta\ngamma\ndelta";

  function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
    return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
  }

  it("writes +HASH│ bytes through byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: `+${hashes[1]!}│### heading\nreal content`,
      },
      hashes,
    );
    expect(result.content).toBe(`+${hashes[1]!}│### heading\nreal content\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("writes -HASH│ and -   │ bytes through byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: `-${hashes[1]!}│one\n-   │two`,
      },
      hashes,
    );
    expect(result.content).toBe(`-${hashes[1]!}│one\n-   │two\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("leaves numbered deletion rows as literal content without warning", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      { anchor_from: anchor, anchor_to: anchor, replace_with: "-1    foo" },
      hashes,
    );
    expect(result.content).toBe("-1    foo\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([]);
  });

  it("leaves plain +x / -x unified-diff lines as literal content without warning", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "+added\n-removed",
      },
      hashes,
    );
    expect(result.content).toBe("+added\n-removed\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([]);
  });
});

describe("diff-prefix false-positive guards (tightened shapes)", () => {
  const file = "alpha\nbeta\ngamma\ndelta";

  function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
    return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
  }

  it("leaves literal '+ HASH│' content with a space after the plus untouched", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: `+ ${hashes[1]!}│one`,
      },
      hashes,
    );
    expect(result.content).toBe(`+ ${hashes[1]!}│one\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("leaves literal '- HASH│' content with a space after the minus untouched", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: `- ${hashes[1]!}│one`,
      },
      hashes,
    );
    expect(result.content).toBe(`- ${hashes[1]!}│one\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("leaves literal '+ abc│' / '- xyz│' lines untouched", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: "+ abc│def\n- xyz│uvw",
      },
      hashes,
    );
    expect(result.content).toBe("+ abc│def\n- xyz│uvw\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([]);
  });

  it("writes exact +HASH│ rows through byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: `+${hashes[1]!}│one`,
      },
      hashes,
    );
    expect(result.content).toBe(`+${hashes[1]!}│one\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("writes exact -HASH│ and -   │ rows through byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const result = applyTool(
      {
        anchor_from: anchor,
        anchor_to: anchor,
        replace_with: `-${hashes[1]!}│one\n-   │two`,
      },
      hashes,
    );
    expect(result.content).toBe(`-${hashes[1]!}│one\n-   │two\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
  });
});

describe("literal bytes reach disk unchanged (#126)", () => {
  const file = "alpha\nbeta\ngamma\ndelta";

  function applyTool(toolEdit: import("../../src/hashline").HTEdit, precomputedHashes?: string[]) {
    return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
  }

  it("writes abc│text, leading-space, KEY│value, bullet, and ASCII pipe byte-exact", async () => {
    const hashes = await lineHashes(file, home.testPath);
    const anchor = hashes[0]!;
    const cases = ["abc│text", "   abc│text", "KEY│value", "- wUp│    pass", "abc|text"];
    for (const literal of cases) {
      const result = applyTool(
        { anchor_from: anchor, anchor_to: anchor, replace_with: literal },
        hashes,
      );
      expect(result.content).toBe(`${literal}\nbeta\ngamma\ndelta`);
      expect(result.warnings ?? []).toEqual([]);
    }
  });
});
