import { describe, expect, it, beforeAll } from "vitest";
import { writeFile } from "fs/promises";
import { initHasher } from "../../src/hashline/hasher";
import { _lineHashesPure } from "../../src/hashline/hash";
import { lineHashes } from "../../src/hashline";
import { fmtMismatchWithServes, resEdit, valEdit } from "../../src/hashline/resolve";
import { resolveLeasedEdit } from "../../src/hashline/lease-resolve";
import type { LeaseSpanSource } from "../../src/hashline/resolve";
import { runNoopPolicy, clearNoopLoop } from "../../src/noop-guard";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";

beforeAll(async () => {
  await initHasher();
});

function countMatches(text: string, re: RegExp): number {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  return (text.match(new RegExp(re.source, flags)) ?? []).length;
}

describe("task-147 rejection diagnostics", () => {
  it("counts one anchor used as both bounds once with singular label (content path)", () => {
    const lines = ["alpha", "beta"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const snapshot = { fileHashes: hashes, fileLines: lines, filePath: "sample.ts" };
    const edit = resEdit({ anchor_from: "ZZZ", anchor_to: "ZZZ", replace_with: "x" });
    const { mismatches } = valEdit(edit, snapshot, undefined);
    const { message } = fmtMismatchWithServes(mismatches, snapshot);
    expect(message).toContain("1 stale anchor in sample.ts");
    expect(message).not.toContain("2 stale anchors");
    expect(countMatches(message, /"ZZZ"/)).toBe(1);
  });

  it("counts one anchor used as both bounds once with singular label (lease path)", () => {
    const emptySource: LeaseSpanSource = {
      currentSnapshotHash: "C",
      leaseFor: () => undefined,
      rebasedLineOf: () => undefined,
    };
    let caught: Error | undefined;
    try {
      resolveLeasedEdit({
        edit: resEdit({ anchor_from: "AAA", anchor_to: "AAA", replace_with: "x" }),
        snapshot: { fileHashes: ["AAA", "BBB"], fileLines: ["a", "b"], filePath: "sample.ts" },
        served: [],
        source: emptySource,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('anchor "AAA" is not present');
    expect(caught!.message).not.toContain('anchors "AAA"');
    expect(caught!.message).not.toContain('"AAA", "AAA"');
    expect(countMatches(caught!.message, /"AAA"/)).toBe(1);
  });

  it("aborts a batched call with one serve block and one audience tag", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", path);
      await writeFile(path, "alpha\nBETA\ngamma\n", "utf-8");
      const rejection = (await editTool
        .execute(
          "e1",
          {
            path: "sample.ts",
            edits: [
              [hashes[0]!, hashes[0]!, "ALPHA"],
              [hashes[1]!, hashes[2]!, "BETA\ngamma"],
            ],
          },
          undefined,
          undefined,
          ctx,
        )
        .catch((error: unknown) => error)) as Error;
      expect(countMatches(rejection.message, /\bCurrent range\b/)).toBe(1);
      expect(countMatches(rejection.message, /\bMODEL\b/)).toBe(1);
    });
  });

  it("marks noop-loop rejects for the model and keeps notices on the dimmed channel", async () => {
    const lines = ["aaa", "bbb", "ccc"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const base = {
      absolutePath: "/tmp/task147-noop.ts",
      removeFrom: hashes[1]!,
      removeTo: hashes[1]!,
      replacementText: "bbb",
      ref: "edit[0] (/tmp/task147-noop.ts)",
      range: { startLine: 2, endLine: 2, startHash: hashes[1]!, endHash: hashes[1]!, delta: 0 },
      hashes,
      lines,
      sessionKey: "task147-noop",
      contentHash: "C",
    };
    clearNoopLoop(base.absolutePath);
    await runNoopPolicy({ ...base, batch: false });
    const notice = await runNoopPolicy({ ...base, batch: false });
    expect(notice.action).toBe("warn");
    if (notice.action === "warn") {
      expect(notice.notice).toContain("[USER]");
      expect(notice.notice).toContain("[E_NOOP_LOOP]");
      expect(notice.notice).not.toContain("[MODEL]");
    }
    const rejectSingle = await runNoopPolicy({ ...base, batch: false });
    expect(rejectSingle.action).toBe("reject");
    if (rejectSingle.action === "reject") {
      expect(rejectSingle.message).toContain("[MODEL]");
      expect(rejectSingle.message).toContain("[E_NOOP_LOOP]");
      expect(rejectSingle.message).toContain("resend will reject.");
      expect(rejectSingle.message).not.toContain("resend will reject the batch");
    }
    clearNoopLoop(`${base.absolutePath}-batch`);
    const batchBase = { ...base, absolutePath: `${base.absolutePath}-batch` };
    await runNoopPolicy({ ...batchBase, batch: true });
    await runNoopPolicy({ ...batchBase, batch: true });
    const rejectBatch = await runNoopPolicy({ ...batchBase, batch: true });
    expect(rejectBatch.action).toBe("reject");
    if (rejectBatch.action === "reject") {
      expect(rejectBatch.message).toContain("[MODEL]");
      expect(rejectBatch.message).toContain("resend will reject the batch");
    }
  });

  it("routes the pipeline noop guard by call arity", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", `${cwd}/sample.ts`);
      const payload = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "bbb"]] };
      await editTool.execute("e1", payload, undefined, undefined, ctx);
      await editTool.execute("e2", payload, undefined, undefined, ctx);
      const err = (await editTool
        .execute("e3", payload, undefined, undefined, ctx)
        .catch((e: unknown) => e)) as Error;
      expect(err.message).toContain("[MODEL]");
      expect(err.message).toContain("[E_NOOP_LOOP]");
      expect(err.message).not.toContain("the batch");
    });
  });

  it("marks undo staleness refusal for the model audience", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", `${cwd}/sample.ts`);
      await editTool.execute(
        "e1",
        { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "BBB"]] },
        undefined,
        undefined,
        ctx,
      );
      await writeFile(`${cwd}/sample.ts`, "aaa\nEXTERNAL\nccc\n", "utf-8");
      const reg = setupIntegrationTest(cwd);
      const undoTool = reg.getTool("undo_last_edit");
      const result = await undoTool.execute("u1", { path: "sample.ts" }, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("[MODEL]");
      expect(getText(result)).toContain("[E_UNDO_STALE]");
    });
  });
});
