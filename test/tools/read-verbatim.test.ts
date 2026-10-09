import { describe, expect, it, vi } from "vitest";
import register from "../../index";
import { fmtReadPreview } from "../../src/read";
import { loadHashStore } from "../../src/hash-store";
import { servedHashEchoDenial } from "../../src/write-hook";
import { resolveTarget } from "../../src/fs-write";
import { addServedSpanObserver } from "../../src/served-spans";
import {
  setupIntegrationTest,
  testSessionManager,
  TEST_SESSION_ID,
  useTestHome,
  withTempFile,
} from "../support/fixtures";

const home = useTestHome();

const ANCHOR_ROW = /^[A-Za-z0-9]{4}│/;

describe("fmtReadPreview — mode: verbatim rendering", () => {
  it("served keeps the anchor prefix while verbatim drops it", async () => {
    const text = "alpha\nbeta\n";
    const served = await fmtReadPreview(text, {}, undefined, home.testPath);
    const verbatim = await fmtReadPreview(text, { render: "verbatim" }, undefined, home.testPath);
    expect(served.text).toMatch(/^[A-Za-z0-9]{4}│alpha$/m);
    expect(served.text).toMatch(/^[A-Za-z0-9]{4}│beta$/m);
    expect(verbatim.text).toBe("alpha\nbeta");
  });

  it("verbatim hides the terminal newline sentinel exactly like served", async () => {
    const text = "alpha\nbeta\n";
    const served = await fmtReadPreview(text, {}, undefined, home.testPath);
    const verbatim = await fmtReadPreview(text, { render: "verbatim" }, undefined, home.testPath);
    expect(served.text.split("\n")).toHaveLength(2);
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
    expect(verbatim.text).toBe(
      "b\nc\n\n[lines 2-3 of 4. Use windows: [{ offset: 4, limit: 2 }] to continue.]",
    );
  });

  it("sizes verbatim rows without the anchor prefix they never emit (fix 5)", async () => {
    const line = "x".repeat(51198);
    const text = `${line}\n`;
    const verbatim = await fmtReadPreview(
      text,
      { render: "verbatim" },
      undefined,
      home.testPath,
      51200,
    );
    expect(verbatim.text).toBe(line);
    expect(verbatim.text).not.toContain("content not shown");

    const served = await fmtReadPreview(text, {}, undefined, home.testPath, 51200);
    expect(served.text).toContain("content not shown");
  });

  it("renders [File is empty.] for an empty file with no anchor row", async () => {
    const verbatim = await fmtReadPreview("", { render: "verbatim" }, undefined, home.testPath);
    expect(verbatim.text).toBe("[File is empty.]");
    expect(verbatim.served).toEqual([]);
  });

  it("renders [File is empty.] for an empty file even past the start (fix 4)", async () => {
    const verbatim = await fmtReadPreview(
      "",
      { render: "verbatim", offset: 2 },
      undefined,
      home.testPath,
    );
    expect(verbatim.text).toBe("[File is empty.]");
    expect(verbatim.text).not.toContain("Use edit to insert content");
  });

  it("marks a lone empty line so it is not confused with an empty result (fix 3)", async () => {
    const verbatim = await fmtReadPreview("\n", { render: "verbatim" }, undefined, home.testPath);
    expect(verbatim.text).toBe("[1 empty line]");
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

  it("returns served: [] at the seam for a normal verbatim range (fix 2)", async () => {
    const verbatim = await fmtReadPreview(
      "alpha\nbeta\n",
      { render: "verbatim" },
      undefined,
      home.testPath,
    );
    expect(verbatim.text).toBe("alpha\nbeta");
    expect(verbatim.served).toEqual([]);
  });

  it("renders multiple verbatim windows plainly and returns served: [] (fix 6)", async () => {
    const text = "a\nb\nc\nd\n";
    const verbatim = await fmtReadPreview(
      text,
      {
        render: "verbatim",
        windows: [
          { offset: 1, limit: 2 },
          { offset: 4, limit: 1 },
        ],
      },
      undefined,
      home.testPath,
    );
    expect(verbatim.text).toContain("=== Lines 1-2 of 4 ===");
    expect(verbatim.text).toContain("a\nb");
    expect(verbatim.text).toContain("=== Lines 4-4 of 4 ===");
    expect(verbatim.text.split("\n").some((line) => ANCHOR_ROW.test(line))).toBe(false);
    expect(verbatim.served).toEqual([]);
  });

  it("uses a mode-neutral oversize clause under verbatim (fix 5)", async () => {
    const text = `${"x".repeat(40)}\n${"y".repeat(40)}\n`;
    const verbatim = await fmtReadPreview(
      text,
      { render: "verbatim" },
      undefined,
      home.testPath,
      10,
    );
    expect(verbatim.text).toContain("content not shown; line exceeds the read byte budget");
    expect(verbatim.text).not.toContain("hashline anchors require full lines");
    expect(verbatim.served).toEqual([]);

    const served = await fmtReadPreview(text, {}, undefined, home.testPath, 10);
    expect(served.text).toContain("content not shown because hashline anchors require full lines");
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
      expect(text).toMatch(/^[A-Za-z0-9]{4}│alpha$/m);
      expect(text).toMatch(/^[A-Za-z0-9]{4}│beta$/m);
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
      expect(text).toBe("[verbatim.txt (verbatim, 2 lines, no anchors)]\nalpha\nbeta");
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
      expect(result.content[0].text).toBe(
        "[empty.txt (verbatim, 0 lines, no anchors)]\n[File is empty.]",
      );
    });
  });

  it("distinguishes a file that is exactly one empty line (fix 3)", async () => {
    await withTempFile("oneblank.txt", "\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        { file: "oneblank.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.content[0].text).toBe(
        "[oneblank.txt (verbatim, 1 lines, no anchors)]\n[1 empty line]",
      );
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
      expect(result.content[0].text).toBe(
        "[literal.txt (verbatim, 1 lines, no anchors)]\nAb3│kept literally",
      );
    });
  });

  it("renders verbatim windows plainly through the tool (fix 6)", async () => {
    await withTempFile("windows.txt", "a\nb\nc\nd\n", async ({ cwd }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute(
        "r1",
        {
          file: "windows.txt",
          mode: "verbatim",
          windows: [
            { offset: 1, limit: 2 },
            { offset: 4, limit: 1 },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const text = result.content[0].text as string;
      expect(text).toContain("=== Lines 1-2 of 4 ===");
      expect(text).toContain("=== Lines 4-4 of 4 ===");
      expect(text.split("\n").some((line) => ANCHOR_ROW.test(line))).toBe(false);
      expect(result.details.snapshotId).toBeUndefined();
    });
  });

  it("writes no lease and no snapshot for a never-served file", async () => {
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

  it("touches no served mirror, epoch, drift clear, or span notification (fix 6)", async () => {
    await withTempFile("state.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const absolute = await resolveTarget(path);
      const store = await loadHashStore();
      const mirrorCount = () =>
        (
          store.db
            .prepare("SELECT COUNT(*) AS n FROM served WHERE session_id = ? AND path = ?")
            .get(TEST_SESSION_ID, absolute) as { n: number }
        ).n;

      const seen: unknown[] = [];
      const off = addServedSpanObserver((notification) => seen.push(notification));
      const sessionSpy = vi.spyOn(ctx.sessionManager, "getSessionId");
      try {
        await readTool.execute(
          "r1",
          { file: "state.txt", mode: "verbatim" },
          undefined,
          undefined,
          ctx,
        );
        expect(mirrorCount()).toBe(0);
        expect(seen).toEqual([]);
        expect(sessionSpy).not.toHaveBeenCalled();

        await readTool.execute("r2", { file: "state.txt" }, undefined, undefined, ctx);
        expect(mirrorCount()).toBeGreaterThan(0);
        expect(seen.length).toBeGreaterThan(0);
        expect(sessionSpy).toHaveBeenCalled();
      } finally {
        off();
        sessionSpy.mockRestore();
      }
    });
  });

  it("leaves an already-served file's leases and snapshots byte-identical and keeps the anchor guard closed (fix 1)", async () => {
    await withTempFile("reserved.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const servedResult = await readTool.execute(
        "r1",
        { file: "reserved.txt" },
        undefined,
        undefined,
        ctx,
      );
      const servedText = servedResult.content[0].text as string;

      const absolute = await resolveTarget(path);
      const store = await loadHashStore();
      const leaseRows = () =>
        store.db
          .prepare(
            "SELECT anchor, retired_at FROM served_leases WHERE file_path = ? ORDER BY anchor",
          )
          .all(absolute);
      const snapshotCount = () =>
        (
          store.db
            .prepare("SELECT COUNT(*) AS n FROM file_snapshots WHERE path = ?")
            .get(absolute) as { n: number }
        ).n;

      const leasesBefore = leaseRows();
      const snapshotsBefore = snapshotCount();
      expect(leasesBefore.length).toBeGreaterThan(0);
      expect(snapshotsBefore).toBeGreaterThan(0);

      const verbatimResult = await readTool.execute(
        "r2",
        { file: "reserved.txt", mode: "verbatim" },
        undefined,
        undefined,
        ctx,
      );

      expect(verbatimResult.details.snapshotId).toBeUndefined();
      expect(leaseRows()).toEqual(leasesBefore);
      expect(snapshotCount()).toBe(snapshotsBefore);
      const denial = await servedHashEchoDenial(null, path, servedText, cwd, TEST_SESSION_ID);
      expect(denial).toContain("[E_SUSPICIOUS_TEXT]");
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
      const denial = await servedHashEchoDenial(null, path, verbatimText, cwd, TEST_SESSION_ID);
      expect(denial).toBeUndefined();
    });
  });

  it("a write reproducing served output IS denied (positive control)", async () => {
    await withTempFile("echo.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const result = await readTool.execute("r1", { file: "echo.txt" }, undefined, undefined, ctx);
      const servedText = result.content[0].text as string;
      const denial = await servedHashEchoDenial(null, path, servedText, cwd, TEST_SESSION_ID);
      expect(denial).toContain("[E_SUSPICIOUS_TEXT]");
    });
  });
});

describe("read verbatim — exhaustiveness guard", () => {
  it("fails closed on a mode outside the union", async () => {
    await withTempFile("guard.txt", "alpha\nbeta\n", async ({ cwd }) => {
      const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
      const pi = {
        registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
          tools.set(tool.name, tool);
        },
        registerCommand() {},
        on() {},
      };
      register(pi as unknown as Parameters<typeof register>[0]);
      const tool = tools.get("read");
      if (!tool) throw new Error("read not registered");

      await expect(
        tool.execute("r1", { file: "guard.txt", mode: "__bogus__" }, undefined, undefined, {
          cwd,
          sessionManager: testSessionManager,
        }),
      ).rejects.toThrow(/Unexpected value/);
    });
  });
});
