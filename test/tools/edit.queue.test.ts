import { symlink } from "fs/promises";
import { readFile } from "fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { lineHash } from "../../src/hashline";
import { withTempFile } from "../support/fixtures";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...original,
    withFileMutationQueue: vi.fn(async (path: string, work: () => Promise<unknown>) => {
      return work();
    }),
  };
});

vi.mock("../../src/read", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/read")>();
  return {
    ...original,
    fmtReadPreview: (text: string) => ({ text }),
  };
});

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { makeFakeReplaceRegistry } from "../support/fixtures";
describe("edit tool file mutation queue", () => {
  beforeEach(() => {
    vi.mocked(withFileMutationQueue).mockClear();
  });

  it("uses the same queue key for repeated edits to the same path", async () => {
    await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { tool } = makeFakeReplaceRegistry();
      const ctx = { cwd };

      await tool.execute(
        "call-1",
        {
          path: "race.ts",
          changes: [
            {
              hash_range_inclusive: [`${lineHash(1, "alpha")}`, `${lineHash(1, "alpha")}`], content_lines: ["ALPHA"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      await tool.execute(
        "call-2",
        {
          path: "race.ts",
          changes: [
            {
              hash_range_inclusive: [`${lineHash(2, "beta")}`, `${lineHash(2, "beta")}`], content_lines: ["BETA"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const queueKeys = vi.mocked(withFileMutationQueue).mock.calls.map(([key]) => key);
      const finalContent = await readFile(path, "utf-8");

      expect({ finalContent, queueKeys }).toEqual({
        finalContent: "ALPHA\nBETA\ngamma\n",
        queueKeys: [path, path],
      });
    });
  });

  it("canonicalizes the queue key when a symlink points at the same file", async () => {
    await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      await symlink("race.ts", `${cwd}/linked-race.ts`);

      const { tool } = makeFakeReplaceRegistry();
      const ctx = { cwd };

      await tool.execute(
        "call-1",
        {
          path: "race.ts",
          changes: [
            {
              hash_range_inclusive: [`${lineHash(1, "alpha")}`, `${lineHash(1, "alpha")}`], content_lines: ["ALPHA"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      await tool.execute(
        "call-2",
        {
          path: "linked-race.ts",
          changes: [
            {
              hash_range_inclusive: [`${lineHash(2, "beta")}`, `${lineHash(2, "beta")}`], content_lines: ["BETA"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const queueKeys = vi.mocked(withFileMutationQueue).mock.calls.map(([key]) => key);
      const finalContent = await readFile(path, "utf-8");

      expect({ finalContent, queueKeys }).toEqual({
        finalContent: "ALPHA\nBETA\ngamma\n",
        queueKeys: [path, path],
      });
    });
  });

  it("canonicalizes the queue key when a parent directory is a symlink", async () => {
    await withTempFile("race.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      await symlink(".", `${cwd}/aliasdir`);

      const { tool } = makeFakeReplaceRegistry();
      const ctx = { cwd };

      await tool.execute(
        "call-1",
        {
          path: "race.ts",
          changes: [
            {
              hash_range_inclusive: [`${lineHash(1, "alpha")}`, `${lineHash(1, "alpha")}`], content_lines: ["ALPHA"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      await tool.execute(
        "call-2",
        {
          path: "aliasdir/race.ts",
          changes: [
            {
              hash_range_inclusive: [`${lineHash(2, "beta")}`, `${lineHash(2, "beta")}`], content_lines: ["BETA"],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      const queueKeys = vi.mocked(withFileMutationQueue).mock.calls.map(([key]) => key);
      const finalContent = await readFile(path, "utf-8");

      expect({ finalContent, queueKeys }).toEqual({
        finalContent: "ALPHA\nBETA\ngamma\n",
        queueKeys: [path, path],
      });
    });
  });
});
