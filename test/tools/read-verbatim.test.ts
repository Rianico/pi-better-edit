import { describe, expect, it } from "vitest";
import { fmtReadPreview } from "../../src/read";
import { loadHashStore } from "../../src/hash-store";
import { servedHashEchoDenial } from "../../src/write-hook";
import { resolveTarget } from "../../src/fs-write";
import { setupIntegrationTest, useTestHome, withTempFile } from "../support/fixtures";

const home = useTestHome();

const ANCHOR_ROW = /^[A-Za-z0-9]{3}│/;

describe("fmtReadPreview — mode: verbatim rendering", () => {
  it("served keeps the anchor prefix while verbatim drops it", async () => {
    const text = "alpha\nbeta\n";
    const served = await fmtReadPreview(text, {}, undefined, home.testPath);
    const verbatim = await fmtReadPreview(text, { render: "verbatim" }, undefined, home.testPath);
    expect(served.text).toMatch(/^[A-Za-z0-9]{3}│alpha$/m);
    expect(served.text).toMatch(/^[A-Za-z0-9]{3}│beta$/m);
    expect(verbatim.text).toBe("alpha\nbeta");
  });

  it("verbatim hides the terminal newline sentinel exactly like served", async () => {
    const verbatim = await fmtReadPreview(
      "alpha\nbeta\n",
      { render: "verbatim" },
      undefined,
      home.testPath,
    );
    expect(verbatim.text).toBe("alpha\nbeta");
    expect(verbatim.text.endsWith("\n")).toBe(false);
  });

  it("verbatim keeps the same pagination contract", async () => {
    const text = "a\nb\nc\nd\n";
    const verbatim = await fmtReadPreview(
      text,
      { render: "verbatim", offset: 2, limit: 2 },
      undefined,
      home.testPath,
    );
    expect(verbatim.text).toBe("b\nc\n\n[Showing lines 2-3 of 4. Use offset=4 to continue.]");
  });

  it("renders [File is empty.] for an empty file with no anchor row", async () => {
    const verbatim = await fmtReadPreview("", { render: "verbatim" }, undefined, home.testPath);
    expect(verbatim.text).toBe("[File is empty.]");
    expect(verbatim.served).toEqual([]);
  });

  it("does not sanitize literal anchor-shaped content", async () => {
    const verbatim = await fmtReadPreview(
      "Ab3│kept literally\n",
      { render: "verbatim" },
      undefined,
      home.testPath,
    );
    expect(verbatim.text).toBe("Ab3│kept literally");
  });
});

describe("read tool — served (default) mode", () => {
  it("renders anchored rows for each line", async () => {
    await withTempFile("served.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "served.txt" },
        undefined,
        undefined,
        ctx,
      );
      const text = result.content[0].text as string;
      expect(text).toMatch(/^[A-Za-z0-9]{3}│alpha$/m);
      expect(text).toMatch(/^[A-Za-z0-9]{3}│beta$/m);
      expect(result.details.snapshotId).toBeTruthy();
    });
  });

  it("creates an active lease for the file (positive control)", async () => {
    await withTempFile("served.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "served.txt" }, undefined, undefined, ctx);

      const absolute = await resolveTarget(path);
      const store = await loadHashStore();
      const leases = store.db
        .prepare("SELECT anchor FROM served_leases WHERE file_path = ? AND retired_at IS NULL")
        .all(absolute) as Array<{ anchor: string }>;
      expect(leases.length).toBeGreaterThan(0);
    });
  });
});

describe("read tool — mode: verbatim", () => {
  it("returns plain text with no anchor prefix and no snapshotId", async () => {
    await withTempFile("verbatim.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "verbatim.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      const text = result.content[0].text as string;
      expect(text).toBe("alpha\nbeta");
      expect(text.split("\n").some((line) => ANCHOR_ROW.test(line))).toBe(false);
      expect(result.details.snapshotId).toBeUndefined();
    });
  });

  it("returns [File is empty.] for an empty file", async () => {
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "empty.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toBe("[File is empty.]");
    });
  });

  it("keeps literal content that looks like an anchor", async () => {
    await withTempFile("literal.txt", "Ab3│kept literally\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "literal.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toBe("Ab3│kept literally");
    });
  });

  it("writes no lease and no snapshot for the file", async () => {
    await withTempFile("verbatim.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute(
        "r1",
        { file: "verbatim.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );

      const absolute = await resolveTarget(path);
      const store = await loadHashStore();
      const leases = store.db
        .prepare("SELECT anchor FROM served_leases WHERE file_path = ? AND retired_at IS NULL")
        .all(absolute);
      expect(leases).toEqual([]);
      const snapshots = store.db
        .prepare("SELECT snapshot_id FROM file_snapshots WHERE path = ?")
        .all(absolute);
      expect(snapshots).toEqual([]);
    });
  });
});

describe("read verbatim — served-row reproduction guard", () => {
  it("a write reproducing verbatim output is NOT denied", async () => {
    await withTempFile("echo.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "echo.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      const verbatimText = result.content[0].text as string;
      const denial = await servedHashEchoDenial(null, path, verbatimText, cwd, "fixture-session");
      expect(denial).toBeUndefined();
    });
  });

  it("a write reproducing served output IS denied (positive control)", async () => {
    await withTempFile("echo.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute("r1", { file: "echo.txt" }, undefined, undefined, ctx);
      const servedText = result.content[0].text as string;
      const denial = await servedHashEchoDenial(null, path, servedText, cwd, "fixture-session");
      expect(denial).toContain("[E_SUSPICIOUS_TEXT]");
    });
  });
});
