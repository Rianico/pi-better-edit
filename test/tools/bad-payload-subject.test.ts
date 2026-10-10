import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DomainError, ERROR_REGISTRY, withPayloadSubject } from "../../src/domain-errors.js";
import { ANCHOR_GENERATION, initHasher, lineHashes } from "../../src/hashline/index.js";
import { loadHashStore } from "../../src/hash-store.js";
import { snapshotHashFor } from "../../src/snapshot-store";
import { upsertUndo } from "../../src/undo-store.js";
import {
  getText,
  setupIntegrationTest,
  testSessionManager,
  withTempDir,
} from "../support/fixtures.js";

// WHY (#86, OPTION B): one E_BAD_PAYLOAD code reaches the model from three registered tools. The
// WHY: header the model reads is composed inside the DomainError constructor, so the invoking tool
// WHY: must be IN the payload before construction — a later render point does not exist.
beforeAll(async () => {
  await initHasher();
});

/** The model-visible text of a tool call, whether the tool threw or reported the refusal inline. */
async function modelVisibleText(run: () => Promise<unknown>): Promise<string> {
  try {
    const result = await run();
    return getText(result as { content: Array<{ text?: string }> });
  } catch (error) {
    return (error as Error).message;
  }
}

describe("E_BAD_PAYLOAD names the invoking tool (#86)", () => {
  it("stamps a refused read with the read tool's own registered name", async () => {
    await withTempDir("bad-payload-read-", async (cwd) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const text = await modelVisibleText(() =>
        readTool.execute("r1", {}, undefined, undefined, ctx),
      );
      expect(text).toContain("[E_BAD_PAYLOAD]");
      expect(text).toContain("The read payload is not valid:");
      // The defect this ticket removes: a bad read call told the model to fix an edit.
      expect(text).not.toContain("edit");
    });
  });

  it("stamps a per-file read refusal in a multi-file call with the same read name", async () => {
    await withTempDir("bad-payload-read-multi-", async (cwd) => {
      await writeFile(join(cwd, "a.ts"), "alpha\n", "utf-8");
      const { ctx, readTool } = setupIntegrationTest(cwd);
      // WHY: the null-byte path is refused deeper than admission, so this refusal is rendered as
      // WHY: one file's own section (spec section 4.4) instead of aborting its sibling.
      const text = await modelVisibleText(() =>
        readTool.execute(
          "r1",
          { files: [{ file: "a.ts" }, { file: "nul\u0000byte.ts" }] },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain("[E_BAD_PAYLOAD]");
      expect(text).toContain("The read payload is not valid:");
      expect(text).not.toContain("The edit payload");
    });
  });

  it("keeps the edit tool's own registered name on an edit admission refusal", async () => {
    await withTempDir("bad-payload-edit-", async (cwd) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const text = await modelVisibleText(() =>
        editTool.execute("e1", { file: "probe.ts", edits: [] }, undefined, undefined, ctx),
      );
      expect(text).toContain("[E_BAD_PAYLOAD]");
      expect(text).toContain("The edit payload is not valid:");
      expect(text).not.toContain("The read payload");
      expect(text).not.toContain("undo_last_edit");
    });
  });

  it("stamps a refused undo_last_edit with its registered name, never its short form", async () => {
    await withTempDir("bad-payload-undo-", async (cwd) => {
      const { ctx, undoTool } = setupIntegrationTest(cwd);
      const text = await modelVisibleText(() =>
        undoTool.execute("u1", { path: "nul\u0000byte.ts" }, undefined, undefined, ctx),
      );
      expect(text).toContain("[E_BAD_PAYLOAD]");
      expect(text).toContain("The undo_last_edit payload is not valid:");
      // WHY: the model reads `undo_last_edit` in its tool list; a `The undo payload` clause would
      // WHY: name a tool that does not exist.
      expect(text).not.toContain("The undo payload");
    });
  });
});

describe("E_BAD_PAYLOAD renders the neutral wording with no subject (#86)", () => {
  it("renders the neutral clause for a producer that claims no tool", () => {
    const unstamped = new DomainError("E_BAD_PAYLOAD", { message: "probe refused." });
    expect(unstamped.message).toBe(
      "[MODEL] [E_BAD_PAYLOAD] The payload is not valid: probe refused.",
    );
    expect(unstamped.message).not.toContain("edit");
    // WHY: the remedy is the registry's, unchanged by this ticket.
    expect(ERROR_REGISTRY.E_BAD_PAYLOAD.remedy).toBe("Fix the payload fields and retry.");
  });

  it("renders the neutral clause when a tool name is absent but a stamp ran elsewhere", () => {
    const neutral = new DomainError("E_BAD_PAYLOAD", { message: "probe refused." });
    expect(neutral.message.startsWith("[MODEL] [E_BAD_PAYLOAD] The payload is not valid: ")).toBe(
      true,
    );
    expect(neutral.message).not.toContain("The read payload");
  });
});

describe("withPayloadSubject is transparent except for E_BAD_PAYLOAD (#86)", () => {
  it("returns the same object for a foreign domain failure and for a non-domain throw", () => {
    const stale = new DomainError("E_STALE_ANCHOR", {
      headline: "anchor gone.",
      cause: "never-served",
    });
    expect(withPayloadSubject(stale, "read")).toBe(stale);

    const plain = new Error("boom");
    expect(withPayloadSubject(plain, "read")).toBe(plain);

    const notAnError = { message: "boom" };
    expect(withPayloadSubject(notAnError, "read")).toBe(notAnError);

    const undefinedThrow = undefined;
    expect(withPayloadSubject(undefinedThrow, "edit")).toBe(undefinedThrow);
  });

  it("re-wraps an unstamped E_BAD_PAYLOAD with the subject, keeping its message field", () => {
    const unstamped = new DomainError("E_BAD_PAYLOAD", { message: "probe refused." });
    const stamped = withPayloadSubject(unstamped, "read") as DomainError<"E_BAD_PAYLOAD">;
    expect(stamped).not.toBe(unstamped);
    expect(stamped.payload).toEqual({ message: "probe refused.", subject: "read" });
    expect(stamped.message).toBe(
      "[MODEL] [E_BAD_PAYLOAD] The read payload is not valid: probe refused.",
    );
  });
});

describe("the subject survives the undo correlated arm (#86)", () => {
  it("keeps the subject instead of the E_UNKNOWN envelope that arm converts to", async () => {
    await withTempDir("bad-payload-undo-arm-", async (cwd) => {
      const target = join(cwd, "target.txt");
      const pre = "l1\nl2\n";
      const post = "l1\nchanged\n";
      await writeFile(target, post, "utf-8");
      // WHY: the arm only runs for a correlated row, so the crafted state is a row carrying the
      // WHY: transaction id — written through the store's own public upsert, never raw SQL.
      upsertUndo(await loadHashStore(), target, {
        content: pre,
        bom: "",
        ending: "\n",
        hashes: await lineHashes(pre, target),
        resultContent: post,
        snapshotHash: snapshotHashFor(pre),
        anchorGeneration: ANCHOR_GENERATION,
        transactionId: "txn-subject-86",
      });

      const { ctx, undoTool } = setupIntegrationTest(cwd);
      // SAFETY: the arm's own catches convert every unexpected failure into the E_UNKNOWN envelope,
      // SAFETY: so the injected failure stands for any E_BAD_PAYLOAD the arm's body could raise.
      // SAFETY: `onBeforeUndoWrites` is the documented fault-injection seam for that body.
      const text = await modelVisibleText(() =>
        undoTool.execute("u1", { path: "target.txt" }, undefined, undefined, {
          ...ctx,
          onBeforeUndoWrites: () => {
            throw new DomainError("E_BAD_PAYLOAD", { message: "injected inside the arm." });
          },
        }),
      );
      expect(text).toContain("[E_BAD_PAYLOAD]");
      expect(text).toContain("The undo_last_edit payload is not valid: injected inside the arm.");
      // WHY: the landmine — the arm's E_UNKNOWN conversion must not replace the subject.
      expect(text).not.toContain("[E_UNKNOWN]");
      expect(testSessionManager.getSessionId()).toBe("fixture-session");
    });
  });
});
