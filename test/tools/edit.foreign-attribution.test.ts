import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { lineHashes, initHasher } from "../../src/hashline/index.js";
import {
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";

// REMEDIATION-2 item A: a foreign-source reference that fails under a LEASED code must render its
// rows SERVED or ABSENT — never unattributable foreign rows under the target-side fresh-read
// heading. These tests drive the same seam pair the tool uses (normReq + assertReq, then the
// engine `execute`), so each refusal is witnessed through the entry point that reaches it.
useTestHome();

beforeAll(async () => {
  await initHasher();
});

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

type ForeignFailure = {
  code: string;
  message: string;
  sourceBytes: string;
  targetBytes: string;
};

// Fixture: `source.txt` served, a disturbance that invalidates part of its served state, then a
// `target.txt` edit whose text_ref names a stale span of the foreign file. The leased shapes are
// red-first verified against the pre-fix tree: the pass-through returned the leased code with the
// FOREIGN file's fresh rows rendered under `Current range (fresh read):` and no file name.
async function foreignLeasedFailure(
  disturb: (cwd: string, hs: string[]) => Promise<[string, string]>,
  expectSourceAfter: string,
): Promise<ForeignFailure> {
  const sourceBefore = "a\nb\nc\nd\n";
  let failure!: ForeignFailure;
  await withTempDir("foreign-attribution-", async (cwd) => {
    await writeFile(join(cwd, "source.txt"), sourceBefore, "utf-8");
    await writeFile(join(cwd, "target.txt"), "1\n2\n3\n", "utf-8");
    const { ctx, readTool } = setupIntegrationTest(cwd);
    await readTool.execute("r1", { path: "source.txt" }, undefined, undefined, ctx);
    await readTool.execute("r2", { path: "target.txt" }, undefined, undefined, ctx);
    const hs = await lineHashes(sourceBefore, join(cwd, "source.txt"));
    const ht = await lineHashes("1\n2\n3\n", join(cwd, "target.txt"));
    const span = await disturb(cwd, hs);
    const result = await execute(
      admit({
        file: "target.txt",
        edits: [
          {
            anchor_from: ht[0]!,
            anchor_to: ht[0]!,
            text_ref: {
              anchor_from: span[0],
              anchor_to: span[1],
              file: "source.txt",
              mode: "copy",
            },
          },
        ],
      }),
      cwd,
      { sessionKey: TEST_SESSION_ID },
    );
    expect(isMutationFailure(result), "the foreign reference must be refused").toBe(true);
    if (!isMutationFailure(result)) return;
    failure = {
      code: result.code,
      message: result.message,
      sourceBytes: await readFile(join(cwd, "source.txt"), "utf-8"),
      targetBytes: await readFile(join(cwd, "target.txt"), "utf-8"),
    };
    // Pin the disturbance landed: refusing with the source already back at its served bytes
    // would make the failure hollow.
    expect(failure.sourceBytes).toBe(expectSourceAfter);
  });
  return failure;
}

async function retireByEdit(cwd: string, edit: { from: string; to: string; text: string }) {
  const retired = await execute(
    admit({
      file: "source.txt",
      edits: [{ anchor_from: edit.from, anchor_to: edit.to, text: edit.text }],
    }),
    cwd,
    { sessionKey: TEST_SESSION_ID },
  );
  // Pin the fixture itself: if the retirement did not land, the leased failure below is fake.
  expect(isMutationSuccess(retired), "fixture retirement must succeed").toBe(true);
}

describe("foreign leased rejections render rows served or absent (remediation-2 item A)", () => {
  it("E_UNVERIFIED_RANGE names the foreign file and renders no foreign rows", async () => {
    const { code, message, sourceBytes, targetBytes } = await foreignLeasedFailure(
      async (_cwd, hs) => {
        await retireByEdit(_cwd, { from: hs[0]!, to: hs[0]!, text: "B" });
        return [hs[0]!, hs[2]!] as [string, string];
      },
      "B\nb\nc\nd\n",
    );
    // §0 exact-code pins hold: the leased code passes through unchanged.
    expect(code).toBe("E_UNVERIFIED_RANGE");
    // (a) the foreign failure names the foreign path.
    expect(message).toContain("source.txt");
    // (b) rows not in the served set are ABSENT: no fresh-read heading, no row glyphs at all.
    expect(message).not.toContain("Current range (fresh read)");
    expect(message).not.toContain("│");
    expect(sourceBytes).toBe("B\nb\nc\nd\n");
    expect(targetBytes).toBe("1\n2\n3\n");
  });

  it("E_STALE_RANGE names the foreign file and renders no foreign rows", async () => {
    // WHY: an EXTERNAL same-length rewrite of one interior line kills that line's identity without
    // WHY: moving anything: the boundaries stay live at their served coordinates, but the interior
    // WHY: served line `b` is retired in the fresh snapshot, so `verifyRebasedSpan` fails closed
    // WHY: with [E_STALE_RANGE] (served-verification.ts:362, the recipe of the target-side
    // WHY: served-range-verification.test.ts:15-44). A pure shift is NOT enough: the foreign
    // WHY: pre-pass rebases it back into agreement and the copy succeeds.
    const { code, message, sourceBytes, targetBytes } = await foreignLeasedFailure(
      async (cwd, hs) => {
        await writeFile(join(cwd, "source.txt"), "a\nB\nc\nd\n", "utf-8");
        return [hs[0]!, hs[3]!] as [string, string];
      },
      "a\nB\nc\nd\n",
    );
    expect(code).toBe("E_STALE_RANGE");
    expect(message).toContain("source.txt");
    expect(message).not.toContain("Current range (fresh read)");
    expect(message).not.toContain("│");
    expect(sourceBytes).toBe("a\nB\nc\nd\n");
    expect(targetBytes).toBe("1\n2\n3\n");
  });

  it("E_TARGET_LOST already names the foreign file and carries no rows (compliant arm)", async () => {
    const { code, message, sourceBytes, targetBytes } = await foreignLeasedFailure(
      async (cwd, hs) => {
        await retireByEdit(cwd, { from: hs[1]!, to: hs[2]!, text: "Z" });
        return [hs[1]!, hs[2]!] as [string, string];
      },
      "a\nZ\nd\n",
    );
    expect(code).toBe("E_TARGET_LOST");
    expect(message).toContain("source.txt");
    expect(message).not.toContain("Current range");
    expect(message).not.toContain("│");
    expect(sourceBytes).toBe("a\nZ\nd\n");
    expect(targetBytes).toBe("1\n2\n3\n");
  });
});
