import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { withTempFile, setupIntegrationTest, getText, extractHash } from "../support/fixtures.js";
import { loadHashStore } from "../../src/hash-store.js";
import { createSessionHandle, sessionKeyFor } from "../../src/served-session/session.js";

/** The atomicity trailer every item failure in a multi-item call must carry (spec §3.2.3). */
const ATOMICITY_TRAILER =
  "The whole edit call was rejected and NOTHING was written — the file is unchanged and earlier items in the call were NOT applied.";

async function servedHashes(ctx: unknown, readTool: any, path: string): Promise<string[]> {
  const result = await readTool.execute("r1", { file: path }, undefined, undefined, ctx);
  return getText(result)
    .split("\n")
    .filter((line) => /^[A-Za-z0-9]{4}│/.test(line))
    .map(extractHash);
}

describe("batch legacy blocked-hashes atomicity (#117)", () => {
  it("a batch that fails on a later item leaves the legacy blocked-hashes set unchanged", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("legacy-fail.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "legacy-fail.txt");
      const store = await loadHashStore();
      const sessionKey = sessionKeyFor(
        ctx as unknown as { sessionManager?: { getSessionId(): string } },
      );
      const before = await createSessionHandle(sessionKey, path, store).loadBlockedHashes();
      expect([...before]).toEqual([]);

      const rejection = (await editTool
        .execute(
          "e1",
          {
            file: "legacy-fail.txt",
            edits: [
              { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" },
              { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: `${hashes[1]}│beta` },
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;

      expect(rejection.message).toContain("[E_SUSPICIOUS_TEXT]");
      expect(rejection.message).toContain(ATOMICITY_TRAILER);
      expect(await readFile(path, "utf-8")).toBe(content);

      const after = await createSessionHandle(sessionKey, path, store).loadBlockedHashes();
      expect([...after].sort()).toEqual([...before].sort());
    });
  });

  it("a successful batch retires the removed hashes into the legacy blocked-hashes set", async () => {
    const content = "alpha\nbeta\ngamma\n";
    await withTempFile("legacy-ok.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const hashes = await servedHashes(ctx, readTool, "legacy-ok.txt");
      const removedFirst = hashes[0]!;
      const removedLast = hashes[2]!;

      await editTool.execute(
        "e1",
        {
          file: "legacy-ok.txt",
          edits: [
            { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "ALPHA" },
            { anchor_from: hashes[2]!, anchor_to: hashes[2]!, text: "GAMMA" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );

      expect(await readFile(path, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\n");
      const store = await loadHashStore();
      const sessionKey = sessionKeyFor(
        ctx as unknown as { sessionManager?: { getSessionId(): string } },
      );
      const blockedHashes = await createSessionHandle(sessionKey, path, store).loadBlockedHashes();
      expect(blockedHashes.has(removedFirst)).toBe(true);
      expect(blockedHashes.has(removedLast)).toBe(true);
    });
  });
});
