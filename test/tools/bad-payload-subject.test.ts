import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DomainError,
  ERROR_REGISTRY,
  isPayloadSubject,
  withPayloadSubject,
} from "../../src/domain-errors.js";
import { buildToolDef } from "../../src/edit.js";
import { ANCHOR_GENERATION, initHasher, lineHashes } from "../../src/hashline/hash-identity.js";
import { loadHashStore } from "../../src/hash-store.js";
import { snapshotHashFor } from "../../src/snapshot-store";
import { upsertUndo } from "../../src/undo-store.js";
import {
  clearDiagnostics,
  getText,
  readDiagnostics,
  setupIntegrationTest,
  withTempDir,
  withTempFile,
} from "../support/fixtures.js";

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
      expect(text).toContain('Schema validation failed for tool "read"');
      expect(text).not.toContain("edit");
    });
  });

  it("stamps a lone read refusal with the same read name", async () => {
    await withTempDir("bad-payload-read-nul-", async (cwd) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const failure = await readTool
        .execute("r1", { file: "nul\u0000byte.ts" }, undefined, undefined, ctx)
        .then(
          () => undefined,
          (error: Error) => error,
        );
      expect(failure?.message).toContain("[E_INTERNAL_INVARIANT]");
      expect(failure?.message).toContain("The read invariant failed:");
      expect(failure?.message).not.toContain("The edit payload");
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
      expect(text).toContain("[E_INTERNAL_INVARIANT]");
      expect(text).toContain("The undo_last_edit invariant failed:");
      expect(text).not.toContain("The undo payload");
      expect(text).not.toContain("Fix the payload fields and retry.");
    });
  });
  it("stamps an engine-level edit refusal the engine had to route as a failure", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      await readTool.execute("r1", { file: "sample.txt" }, undefined, undefined, ctx);
      const h = await lineHashes(content, path);
      const text = await modelVisibleText(() =>
        editTool.execute(
          "e1",
          {
            file: "sample.txt",
            edits: [{ anchor_from: h[0]!, anchor_to: h[2]!, text: "Z", at: "before" }],
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(text).toContain("[E_BAD_PAYLOAD]");
      expect(text).toContain("The edit payload is not valid:");
      expect(text).not.toContain("The payload is not valid:");
      expect(text.match(/\[E_BAD_PAYLOAD\]/g)?.length).toBe(1);
    });
  });

  it("stamps the execute-level edit refusal for a payload that skips prepareArguments", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\n", async ({ cwd }) => {
      const tool = buildToolDef();
      const text = await modelVisibleText(() =>
        tool.execute(
          "e1",
          { file: "sample.ts", edits: [{ anchor_from: "bad" }] } as never,
          undefined,
          undefined,
          { cwd } as never,
        ),
      );
      expect(text).toContain("[E_BAD_PAYLOAD]");
      expect(text).toContain("The edit payload is not valid:");
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
    expect(unstamped.message).not.toContain("The read payload");
    expect(ERROR_REGISTRY.E_BAD_PAYLOAD.options).toBeUndefined();
  });

  it("renders the neutral clause for a subject outside the union", () => {
    expect(isPayloadSubject("read")).toBe(true);
    expect(isPayloadSubject("undo_last_edit")).toBe(true);
    expect(isPayloadSubject("write")).toBe(false);
    expect(isPayloadSubject("")).toBe(false);
    expect(isPayloadSubject(undefined)).toBe(false);
    const empty = new DomainError("E_BAD_PAYLOAD", {
      message: "probe refused.",
      subject: "" as never,
    });
    expect(empty.message).toBe("[MODEL] [E_BAD_PAYLOAD] The payload is not valid: probe refused.");
    const foreign = new DomainError("E_BAD_PAYLOAD", {
      message: "probe refused.",
      subject: "write" as never,
    });
    expect(foreign.message).toBe(
      "[MODEL] [E_BAD_PAYLOAD] The payload is not valid: probe refused.",
    );
  });
});

describe("withPayloadSubject re-wraps payload-shaped refusals only (#86, #93)", () => {
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
      clearDiagnostics();
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
      expect(text).not.toContain("[E_UNKNOWN]");
      const trace = readDiagnostics().find((record) =>
        record.message.includes("Unexpected failure in correlated undo:"),
      );
      expect(trace?.error?.message).toContain("injected inside the arm.");
      await expect(readFile(target, "utf-8")).resolves.toBe(post);
    });
  });
});
