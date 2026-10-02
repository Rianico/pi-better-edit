import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, isMutationFailure, isMutationSuccess } from "../../src/mutation-engine/index.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { lineHashes, initHasher } from "../../src/hashline/index.js";
import { getUndo } from "../../src/edit-undo.js";
import { resolveTarget } from "../../src/fs-write.js";
import {
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";

// TICKET-04b REMEDIATION, ruling 1 (P2-2/P2-3 amended): a file whose bytes do not survive the
// UTF-8 decode/encode round-trip is NOT losslessly line-addressable — anchors are derived from
// the DECODED text, so an edit would rewrite the lossy form. The honest answer at admission is a
// typed refusal, not a silent U+FFFD. The witness set:
//   1. target lossy   → refusal, file bytes untouched, ZERO undo rows (Option-A consistent);
//   2. foreign lossy  → the cut refuses, NEITHER file is touched;
//   3. legal U+FFFD   → the BYTES round-trip (EF BF BD is valid UTF-8), so the edit APPLIES and
//      no disclosure warning rides along — this is the round-trip oracle, not the old
//      "decoded text contains U+FFFD" heuristic, which could not tell the two apart.
const home = useTestHome();

beforeAll(async () => {
  await initHasher();
});

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

// "alpha\n<0xff>\nbeta\n": the middle line's byte 0xFF is not a UTF-8 start sequence, so decode
// replaces it with U+FFFD and the re-encode differs from the original — the round-trip fails.
const LOSSY_BYTES = Buffer.concat([
  Buffer.from("alpha\n"),
  Buffer.from([0xff]),
  Buffer.from("\nbeta\n"),
]);
const LOSSY_DECODED = "alpha\n\uFFFD\nbeta\n";

const TARGET_BEFORE = "1\n2\n3\n";

describe("lossy-admission: non-round-tripping bytes are refused before any mutation", () => {
  it("an edit whose TARGET file does not round-trip UTF-8 is refused, unchanged, with zero undo rows", async () => {
    await withTempDir("lossy-target-", async (cwd) => {
      await writeFile(join(cwd, "lossy.txt"), LOSSY_BYTES);
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "lossy.txt" }, undefined, undefined, ctx);
      const h = await lineHashes(LOSSY_DECODED, `${home.testPath}/lossy.txt`);
      const result = await execute(
        admit({
          file: "lossy.txt",
          edits: [{ anchor_from: h[2]!, anchor_to: h[2]!, text: "BETA" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result), "a lossy target must be refused at admission").toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_LOSSY_TEXT");
      expect(result.message).toContain("lossy.txt");
      expect(await readFile(join(cwd, "lossy.txt"))).toEqual(LOSSY_BYTES);
      expect(await getUndo(await resolveTarget(join(cwd, "lossy.txt")))).toBeUndefined();
    });
  });

  it("a foreign-cut whose SOURCE file does not round-trip UTF-8 refuses the call; neither file is touched", async () => {
    await withTempDir("lossy-foreign-", async (cwd) => {
      await writeFile(join(cwd, "lossy.txt"), LOSSY_BYTES);
      await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "lossy.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { path: "target.txt" }, undefined, undefined, ctx);
      const hs = await lineHashes(LOSSY_DECODED, `${home.testPath}/lossy.txt`);
      const ht = await lineHashes(TARGET_BEFORE, `${home.testPath}/target.txt`);
      const result = await execute(
        admit({
          file: "target.txt",
          edits: [
            {
              anchor_from: ht[0]!,
              anchor_to: ht[0]!,
              text_ref: { anchor_from: hs[0]!, anchor_to: hs[1]!, file: "lossy.txt", mode: "cut" },
            },
          ],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result), "a lossy foreign source must refuse the whole cut").toBe(
        true,
      );
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_LOSSY_TEXT");
      // The cause is OBSERVED, not assumed: the refusal names the member that broke the round-trip.
      expect(result.message).toContain("lossy.txt");
      expect(await readFile(join(cwd, "lossy.txt"))).toEqual(LOSSY_BYTES);
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
    });
  });

  it("a legal U+FFFD CHARACTER round-trips and edits normally — the oracle is the BYTES", async () => {
    await withTempDir("lossy-legit-replacement-", async (cwd) => {
      // EF BF BD is valid UTF-8 for U+FFFD; the old decode-heuristic could not tell this file
      // apart from a corrupt one, and a heuristic admission guard would refuse it — wrongly.
      await writeFile(join(cwd, "rep.txt"), "x\n\uFFFD\ny\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "rep.txt" }, undefined, undefined, ctx);
      const h = await lineHashes("x\n\uFFFD\ny\n", `${home.testPath}/rep.txt`);
      const result = await execute(
        admit({
          file: "rep.txt",
          edits: [{ anchor_from: h[2]!, anchor_to: h[2]!, text: "Y" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationSuccess(result), "a byte-lossless file must NOT be refused").toBe(true);
      expect(await readFile(join(cwd, "rep.txt"), "utf-8")).toBe("x\n\uFFFD\nY\n");
      const details = (result as { details?: { warnings?: string[] } }).details;
      const warnings = details?.warnings ?? [];
      expect(
        warnings.some((w) => w.includes("Non-UTF-8")),
        "no lossy-decode disclosure may ride a byte-exact edit",
      ).toBe(false);
    });
  });

  // REMEDIATION-2 R4: the INTERSECTION the single-feature cases miss — a file that is BOTH
  // BOM-prefixed AND carries a legal U+FFFD. The BOM makes the decoded text start with U+FEFF;
  // the FFFD triggers SUSPICION, so the round-trip oracle actually runs and must compare the
  // WHOLE byte image. Mutation refuted: N6 (strip the BOM at the oracle site) makes the
  // comparison mismatch on exactly this file and the edit is wrongly refused.
  it("a BOM-prefixed file that ALSO contains a legal U+FFFD edits normally — the oracle compares the whole byte image", async () => {
    await withTempDir("lossy-bom-replacement-", async (cwd) => {
      const bytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]), // UTF-8 BOM
        Buffer.from("alpha\n"),
        Buffer.from([0xef, 0xbf, 0xbd]), // legal U+FFFD (valid UTF-8)
        Buffer.from("\nbeta\n"),
      ]);
      await writeFile(join(cwd, "bomrep.txt"), bytes);
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "bomrep.txt" }, undefined, undefined, ctx);
      const decoded = "alpha\n\uFFFD\nbeta\n";
      const h = await lineHashes(decoded, `${home.testPath}/bomrep.txt`);
      const result = await execute(
        admit({
          file: "bomrep.txt",
          edits: [{ anchor_from: h[2]!, anchor_to: h[2]!, text: "BETA" }],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(
        isMutationSuccess(result),
        "BOM + legal U+FFFD round-trips losslessly: suspicion must NOT become refusal",
      ).toBe(true);
      const after = await readFile(join(cwd, "bomrep.txt"));
      expect(
        after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
        "the BOM is preserved through the canonical serializer",
      ).toBe(true);
      expect(after.toString("utf-8").slice(1)).toBe("alpha\n\uFFFD\nBETA\n");
    });
  });
});
