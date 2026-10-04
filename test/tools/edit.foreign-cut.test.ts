import { describe, expect, it, beforeAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { execute, isMutationSuccess, isMutationFailure } from "../../src/mutation-engine/index.js";
import { normReq, assertReq, type NormalizedEditRequest } from "../../src/payload-contract.js";
import { lineHashes, initHasher } from "../../src/hashline/index.js";
import { loadHashStore } from "../../src/hash-store.js";
import {
  withTempDir,
  setupIntegrationTest,
  TEST_SESSION_ID,
  useTestHome,
} from "../support/fixtures.js";

// TICKET-04b: a `text_ref` naming another served file with `mode: "cut"` succeeds as a CORRELATED
// MULTI-FILE TRANSACTION: the target insert and the source retirement mutate TWO files under one
// transaction. These tests drive the tool's own seam (normReq + assertReq, then `execute`), so
// every claim is witnessed through the entry point that reaches it.
//
// Guard history (deletion documented here, per the rework ruling): ticket-04 item (iv) refused a
// foreign `mode: "cut"` in the engine pre-pass ("A foreign-source reference supports mode: copy
// today..."). That refusal existed because the pre-pass collapsed every foreign reference to a
// COPY-shaped literal with no retirement target — enabling cut without a transaction would have
// reported success and LEFT THE SOURCE BEHIND. Ticket-04b supplies the missing half (the ordered
// two-file commit of ADR-0028), so the refusal is deleted deliberately in this commit; the tests
// below are its replacement witnesses, and `edit.wire-contract.test.ts` keeps the copy-path pins.
useTestHome();

beforeAll(async () => {
  await initHasher();
});

function admit(raw: unknown): NormalizedEditRequest {
  const canonical = normReq(raw);
  assertReq(canonical);
  return canonical as NormalizedEditRequest;
}

const SOURCE_BEFORE = "a\nb\nc\nd\n";
const TARGET_BEFORE = "1\n2\n3\n";

// WHY: the preview witness's oracle: a full serialization of every store table a live cut
// WHY: touches (plus the id counter and session meta). Row sets are sorted so the comparison is
// WHY: order-insensitive; the content is order-SENSITIVE where it matters (`updated_at`,
// WHY: `retired_at`, `line_id_counters.next_id` all change on any store write).
function dumpStoreState(db: DatabaseSync): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const table of [
    "file_snapshots",
    "line_lineage",
    "served_leases",
    "served",
    "file_undo",
    "cut_intent",
    "line_id_counters",
    "served_session_meta",
  ]) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<string, unknown>[];
    out[table] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

async function serveBoth(cwd: string) {
  const { ctx, readTool } = setupIntegrationTest(cwd);
  await readTool.execute("r1", { path: "source.txt" }, undefined, undefined, ctx);
  await readTool.execute("r2", { path: "target.txt" }, undefined, undefined, ctx);
  return ctx;
}

async function seed(cwd: string): Promise<void> {
  await writeFile(join(cwd, "source.txt"), SOURCE_BEFORE, "utf-8");
  await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
}

async function cutSpan(cwd: string, span: [string, string], targetAnchor: string) {
  return execute(
    admit({
      file: "target.txt",
      edits: [
        {
          anchor_from: targetAnchor,
          anchor_to: targetAnchor,
          text_ref: { anchor_from: span[0], anchor_to: span[1], file: "source.txt", mode: "cut" },
        },
      ],
    }),
    cwd,
    { sessionKey: TEST_SESSION_ID },
  );
}

describe("foreign-source cut mutates both files as one transaction (ticket-04b §1)", () => {
  it("a foreign cut inserts into the target AND retires the span in the source", async () => {
    await withTempDir("foreign-cut-", async (cwd) => {
      await seed(cwd);
      await serveBoth(cwd);
      const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
      const ht = await lineHashes(TARGET_BEFORE, join(cwd, "target.txt"));
      const result = await cutSpan(cwd, [hs[1]!, hs[2]!], ht[0]!);
      expect(isMutationSuccess(result), "the foreign-source cut must succeed").toBe(true);
      // In-place: the target span [ht0,ht0] (line `1`) is replaced by the cut bytes.
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\nc\n2\n3\n");
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe("a\nd\n");
    });
  });

  it("the response covers BOTH files: two sections, both served-block sets (§5)", async () => {
    await withTempDir("foreign-cut-response-", async (cwd) => {
      await seed(cwd);
      await serveBoth(cwd);
      const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
      const ht = await lineHashes(TARGET_BEFORE, join(cwd, "target.txt"));
      const result = await cutSpan(cwd, [hs[1]!, hs[2]!], ht[0]!);
      expect(isMutationSuccess(result)).toBe(true);
      if (!isMutationSuccess(result)) return;
      const text = result.toolResult.content.map((c) => c.text).join("\n");
      // Supersedes ticket-04's target-only served set for the CUT path: the model must see fresh
      // anchors for the retired source as well as the inserted target.
      expect(text).toContain("Successfully edited 2 file(s)");
      const paths = result.toolResult.details.servedByPath?.map((e) => e.path) ?? [];
      expect(paths).toEqual(["target.txt", "source.txt"]);
      expect(result.toolResult.details.diff).toContain("--- target.txt ---");
      expect(result.toolResult.details.diff).toContain("--- source.txt ---");
    });
  });

  it("a cut whose SOURCE drifted after the serve rejects and writes NEITHER file", async () => {
    await withTempDir("foreign-cut-drift-", async (cwd) => {
      await seed(cwd);
      await serveBoth(cwd);
      const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
      const ht = await lineHashes(TARGET_BEFORE, join(cwd, "target.txt"));
      // Disturb the leased interior of the source only — the same recipe as the attribution tests.
      await writeFile(join(cwd, "source.txt"), "a\nB\nc\nd\n", "utf-8");
      const result = await cutSpan(cwd, [hs[1]!, hs[2]!], ht[0]!);
      expect(isMutationFailure(result), "the drifted leased span must refuse").toBe(true);
      if (!isMutationFailure(result)) return;
      // Refuse for the DRIFT, not for the retired item-(iv) shape refusal. The drifted line IS a
      // bound anchor here, so the leased arm surfaces `E_UNVERIFIED_RANGE` (the rows-ABSENT wrap
      // naming the foreign file) — the interior-drift-with-live-bounds recipe of
      // `edit.foreign-attribution.test.ts` is the `E_STALE_RANGE` twin. The cause is OBSERVED,
      // not assumed: the refusal itself must name the file that drifted.
      expect(result.code).toBe("E_UNVERIFIED_RANGE");
      expect(result.message).toContain("source.txt");
      // The pre-pass read saw `b` at line 2, the re-resolve saw `B`: refuse before ANY write.
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe("a\nB\nc\nd\n");
    });
  });

  it("two items cutting OVERLAPPING source spans abort with no write anywhere", async () => {
    await withTempDir("foreign-cut-overlap-", async (cwd) => {
      await seed(cwd);
      await writeFile(join(cwd, "target.txt"), "1\n2\n3\n4\n5\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "source.txt" }, undefined, undefined, ctx);
      await readTool.execute("r2", { path: "target.txt" }, undefined, undefined, ctx);
      const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
      const ht = await lineHashes("1\n2\n3\n4\n5\n", join(cwd, "target.txt"));
      const result = await execute(
        admit({
          file: "target.txt",
          edits: [
            {
              anchor_from: ht[0]!,
              anchor_to: ht[0]!,
              text_ref: {
                anchor_from: hs[0]!,
                anchor_to: hs[2]!,
                file: "source.txt",
                mode: "cut",
              },
            },
            {
              anchor_from: ht[1]!,
              anchor_to: ht[1]!,
              text_ref: {
                anchor_from: hs[1]!,
                anchor_to: hs[3]!,
                file: "source.txt",
                mode: "cut",
              },
            },
          ],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID },
      );
      expect(isMutationFailure(result), "overlapping source spans must abort").toBe(true);
      if (!isMutationFailure(result)) return;
      expect(result.code).toBe("E_BATCH_ABORT");
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("1\n2\n3\n4\n5\n");
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
    });
  });

  it("the source retirement write shares the canonical serializer: CRLF source keeps CRLF", async () => {
    await withTempDir("foreign-cut-crlf-", async (cwd) => {
      await writeFile(join(cwd, "source.txt"), "a\r\nb\r\nc\r\n", "utf-8");
      await writeFile(join(cwd, "target.txt"), TARGET_BEFORE, "utf-8");
      await serveBoth(cwd);
      const hs = await lineHashes("a\nb\nc\n", join(cwd, "source.txt"));
      const ht = await lineHashes(TARGET_BEFORE, join(cwd, "target.txt"));
      const result = await cutSpan(cwd, [hs[1]!, hs[1]!], ht[0]!);
      expect(isMutationSuccess(result)).toBe(true);
      // One convention, no third path: the retirement re-serializes through the source's own
      // detected ending, exactly like every other write through `writeAtomic`.
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe("a\r\nc\r\n");
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe("b\n2\n3\n");
    });
  });

  it("a noPersist preview touches NEITHER file NOR the store: table state before == after", async () => {
    await withTempDir("foreign-cut-preview-", async (cwd) => {
      await seed(cwd);
      await serveBoth(cwd);
      const hs = await lineHashes(SOURCE_BEFORE, join(cwd, "source.txt"));
      const ht = await lineHashes(TARGET_BEFORE, join(cwd, "target.txt"));
      const store = await loadHashStore();
      // WHY: the store-side witness for the preview path (ticket-04b falsifiers): the oracle is
      // WHY: the table-state comparison itself — every row of every store table the live cut
      // WHY: mutates (snapshots + lineage + leases + served mirror + undo + intent) captured
      // WHY: before and after. A preview that wrote ANYTHING store-side reddens here even if
      // WHY: the files stay untouched.
      const stateBefore = dumpStoreState(store.db);
      const result = await execute(
        admit({
          file: "target.txt",
          edits: [
            {
              anchor_from: ht[1]!,
              anchor_to: ht[1]!,
              text_ref: {
                anchor_from: hs[0]!,
                anchor_to: hs[1]!,
                file: "source.txt",
                mode: "cut",
              },
            },
          ],
        }),
        cwd,
        { sessionKey: TEST_SESSION_ID, noPersist: true },
      );
      expect(
        isMutationSuccess(result),
        "the preview must still compute the target-side result",
      ).toBe(true);
      if (!isMutationSuccess(result)) return;
      // The preview shows the TARGET-ONLY insert: the source retirement lives in the commit
      // path's second plan, which preview never runs.
      expect(result.result).toBe("1\na\nb\n3\n");
      expect(await readFile(join(cwd, "target.txt"), "utf-8")).toBe(TARGET_BEFORE);
      expect(await readFile(join(cwd, "source.txt"), "utf-8")).toBe(SOURCE_BEFORE);
      expect(dumpStoreState(store.db)).toEqual(stateBefore);
    });
  });
});
