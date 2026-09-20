import { describe, expect, it } from "vitest";
import { lineHashes, _lineHashesPure } from "../../src/hashline";
import { clearNoopLoop, runNoopPolicy } from "../../src/noop-guard";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";

function sessionCtx(base: any, id: string): any {
  return {
    ...base,
    sessionManager: { getSessionId: () => id },
  };
}

describe("edit noop-loop tracker session scope", () => {
  it("counts the identical noop edit independently per session", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const ctxA = sessionCtx(ctx, "noop-session-a");
      const ctxB = sessionCtx(ctx, "noop-session-b");
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctxA);
      await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctxB);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", `${cwd}/sample.ts`);
      const payload = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "bbb"]] };

      const a1 = await editTool.execute("a1", payload, undefined, undefined, ctxA);
      expect(a1.details.classification).toBe("noop");
      expect(getText(a1)).not.toContain("[W_NOOP]");

      const b1 = await editTool.execute("b1", payload, undefined, undefined, ctxB);
      expect(b1.details.classification).toBe("noop");
      expect(getText(b1)).not.toContain("[W_NOOP]");

      const a2 = await editTool.execute("a2", payload, undefined, undefined, ctxA);
      expect(a2.details.classification).toBe("noop");
      expect(getText(a2)).toContain("[W_NOOP]");
      expect(getText(a2)).not.toContain("[E_NOOP_LOOP]");

      const b2 = await editTool.execute("b2", payload, undefined, undefined, ctxB);
      expect(b2.details.classification).toBe("noop");
      expect(getText(b2)).toContain("[W_NOOP]");
      expect(getText(b2)).not.toContain("[E_NOOP_LOOP]");
    });
  });

  it("keeps one session counter when another session applies", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const ctxA = sessionCtx(ctx, "noop-session-a-apply");
      const ctxB = sessionCtx(ctx, "noop-session-b-apply");
      await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctxA);
      await readTool.execute("r2", { path: "sample.ts" }, undefined, undefined, ctxB);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", `${cwd}/sample.ts`);
      const noopPayload = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, "bbb"]] };

      await editTool.execute("a1", noopPayload, undefined, undefined, ctxA);
      await editTool.execute("b1", noopPayload, undefined, undefined, ctxB);

      await editTool.execute(
        "a2",
        { path: "sample.ts", edits: [[hashes[0]!, hashes[0]!, "AAA"]] },
        undefined,
        undefined,
        ctxA,
      );

      const b2 = await editTool.execute("b2", noopPayload, undefined, undefined, ctxB);
      expect(b2.details.classification).toBe("noop");
      expect(getText(b2)).toContain("[W_NOOP]");
      expect(getText(b2)).not.toContain("[E_NOOP_LOOP]");
    });
  });

  it("clears only the named session", async () => {
    const lines = ["aaa", "bbb", "ccc"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const absolutePath = "/tmp/noop-session-guard-a.ts";
    const base = {
      absolutePath,
      removeFrom: hashes[1]!,
      removeTo: hashes[1]!,
      replacementText: "bbb",
      ref: `edit[0] (${absolutePath})`,
      range: { startLine: 2, endLine: 2, startHash: hashes[1]!, endHash: hashes[1]!, delta: 0 },
      hashes,
      lines,
      contentHash: "C",
    };
    clearNoopLoop("guard-a");
    clearNoopLoop("guard-b");
    const a1 = await runNoopPolicy({ ...base, sessionKey: "guard-a", batch: false });
    expect(a1.action).toBe("proceed");
    const a2 = await runNoopPolicy({ ...base, sessionKey: "guard-a", batch: false });
    expect(a2.action).toBe("warn");
    const b1 = await runNoopPolicy({ ...base, sessionKey: "guard-b", batch: false });
    expect(b1.action).toBe("proceed");

    clearNoopLoop("guard-a");

    const aReset = await runNoopPolicy({ ...base, sessionKey: "guard-a", batch: false });
    expect(aReset.action).toBe("proceed");
    expect(aReset.count).toBe(1);
    const bKept = await runNoopPolicy({ ...base, sessionKey: "guard-b", batch: false });
    expect(bKept.action).toBe("warn");
    expect(bKept.count).toBe(2);
    clearNoopLoop("guard-a");
    clearNoopLoop("guard-b");
  });

  it("clears only the named file when both keys are given", async () => {
    const lines = ["aaa", "bbb", "ccc"];
    const hashes = _lineHashesPure(lines.join("\n"));
    const fileOne = "/tmp/noop-session-guard-p1.ts";
    const fileTwo = "/tmp/noop-session-guard-p2.ts";
    const sessionKey = "guard-path";
    const baseFor = (absolutePath: string) => ({
      absolutePath,
      removeFrom: hashes[1]!,
      removeTo: hashes[1]!,
      replacementText: "bbb",
      ref: `edit[0] (${absolutePath})`,
      range: { startLine: 2, endLine: 2, startHash: hashes[1]!, endHash: hashes[1]!, delta: 0 },
      hashes,
      lines,
      contentHash: "C",
      sessionKey,
      batch: false as const,
    });
    clearNoopLoop(sessionKey);
    await runNoopPolicy(baseFor(fileOne));
    await runNoopPolicy(baseFor(fileOne));
    await runNoopPolicy(baseFor(fileTwo));

    clearNoopLoop(sessionKey, fileOne);

    const oneReset = await runNoopPolicy(baseFor(fileOne));
    expect(oneReset.action).toBe("proceed");
    expect(oneReset.count).toBe(1);
    const twoKept = await runNoopPolicy(baseFor(fileTwo));
    expect(twoKept.action).toBe("warn");
    expect(twoKept.count).toBe(2);
    clearNoopLoop(sessionKey);
  });
});
