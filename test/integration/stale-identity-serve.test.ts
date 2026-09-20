import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures";

function servedRowRe(): RegExp {
  return /^[A-Za-z0-9]{3}│/m;
}

describe("stale-identity target-lost rejection (spec stale-identity-reject-and-serve D1-D3/D5-D6)", () => {
  it("external deletion of the target line rejects [E_TARGET_LOST] with no rows and leaves the file byte-identical", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);

      await writeFile(path, "alpha\nbeta\ndelta\n", "utf-8");

      const rejected = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [{ anchor_from: gammaRef, anchor_to: gammaRef, replace_with: "GAMMA_NEW" }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((e: unknown) => e)) as Error;

      expect(rejected.message).toMatch(/\[MODEL\] \[E_TARGET_LOST\]/);
      expect(rejected.message).not.toContain("Current range:");
      expect(rejected.message).not.toContain("Retry with these anchors");
      expect(rejected.message).not.toMatch(servedRowRe());
      expect(rejected.message).toMatch(/line 3 in sample\.ts/);
      expect(rejected.message).toMatch(/Read the file and re-target/);
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ndelta\n");
    });
  });

  it("a retry with no fresh read cannot write the occupying line (D2 leases nothing)", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);

      await writeFile(path, "alpha\nbeta\ndelta\n", "utf-8");

      const first = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [{ anchor_from: gammaRef, anchor_to: gammaRef, replace_with: "GAMMA_NEW" }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((e: unknown) => e)) as Error;
      expect(first.message).toMatch(/\[E_TARGET_LOST\]/);

      const second = (await editTool
        .execute(
          "e2",
          {
            path: "sample.ts",
            edits: [{ anchor_from: gammaRef, anchor_to: gammaRef, replace_with: "GAMMA_NEW" }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((e: unknown) => e)) as Error;
      expect(second.message).toMatch(/\[E_TARGET_LOST\]/);
      expect(second.message).not.toMatch(servedRowRe());
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ndelta\n");
    });
  });

  it("after a read the same edit at the correct anchors applies (recovery terminates)", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);
      await writeFile(path, "alpha\nbeta\ndelta\n", "utf-8");

      const rejected = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [{ anchor_from: gammaRef, anchor_to: gammaRef, replace_with: "GAMMA_NEW" }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((e: unknown) => e)) as Error;
      expect(rejected.message).toMatch(/\[E_TARGET_LOST\]/);

      const fresh = await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctx);
      const freshText = getText(fresh);
      const deltaRef = extractHash(freshText.split("\n").find((l) => l.includes("│delta"))!);
      const result = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          edits: [{ anchor_from: deltaRef, anchor_to: deltaRef, replace_with: "DELTA2" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(result)).toContain("Successfully edited");
      expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\nDELTA2\n");
    });
  });

  it("Probe P: retired text re-added elsewhere rejects [E_TARGET_LOST] naming the served coordinate", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const betaRef = extractHash(text.split("\n").find((l) => l.includes("│beta"))!);

      await writeFile(path, "alpha\nBETA\ngamma\nbeta\n", "utf-8");

      const rejected = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [{ anchor_from: betaRef, anchor_to: betaRef, replace_with: "X" }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((e: unknown) => e)) as Error;

      expect(rejected.message).toMatch(/\[MODEL\] \[E_TARGET_LOST\]/);
      expect(rejected.message).toMatch(/line 2 in sample\.ts/);
      expect(rejected.message).not.toMatch(/line 4/);
      expect(rejected.message).not.toMatch(servedRowRe());
      expect(rejected.message).not.toContain("Current range:");
      expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\nbeta\n");
    });
  });
});

describe("target-lost leases nothing (D2 seam)", () => {
  it("the occupying neighbour keeps its own lease: editing it needs no read", async () => {
    const { readFile: readF, writeFile: writeF } = await import("fs/promises");
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const firstRead = await readTool.execute(
        "r1",
        { path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(firstRead);
      const gammaRef = extractHash(text.split("\n").find((l) => l.includes("│gamma"))!);
      const deltaRef = extractHash(text.split("\n").find((l) => l.includes("│delta"))!);

      await writeF(path, "alpha\nbeta\ndelta\n", "utf-8");

      const rejected = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [{ anchor_from: gammaRef, anchor_to: gammaRef, replace_with: "GAMMA_NEW" }],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((e: unknown) => e)) as Error;
      expect(rejected.message).toMatch(/\[E_TARGET_LOST\]/);

      const neighbour = await editTool.execute(
        "e2",
        {
          path: "sample.ts",
          edits: [{ anchor_from: deltaRef, anchor_to: deltaRef, replace_with: "DELTA2" }],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(getText(neighbour)).toContain("Successfully edited");
      expect(await readF(path, "utf-8")).toBe("alpha\nbeta\nDELTA2\n");
    });
  });
});
