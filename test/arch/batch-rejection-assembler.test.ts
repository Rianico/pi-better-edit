import { readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DomainError, type ServedRow } from "../../src/domain-errors.js";
import { initHasher, lineHashes } from "../../src/hashline/hash-identity.js";
import { throwBatchRejection } from "../../src/mutation-engine/batch-rejection.js";
import {
  addServedSpanObserver,
  clearServedSpanObserversForTests,
  type ServedSpanNotification,
} from "../../src/served-spans.js";
import { setupIntegrationTest, withTempDir } from "../support/fixtures.js";

/**
 * Batch-rejection assembler ratchet (#334): `batchAbort` and the serve
 * recorder run in exactly one place (the seam), the `Batch rejected:`
 * verdict is built in exactly one place (the formatter), and every seam
 * call that passes no recorder is a frozen allowlist entry with a one-line reason.
 * Detection is literal: whole-line `Batch rejected:` matches plus
 * importing/calling symbol names (`batchAbort`, `recordRejectionServe`,
 * `throwBatchRejection`). It does NOT see a verdict assembled by
 * concatenation (no token heuristic).
 */
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function callEnd(source: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced parens");
}

function enclosingFunction(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const matches = [...before.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  const last = matches[matches.length - 1];
  if (last?.[1] === undefined) throw new Error("no enclosing function");
  return last[1];
}

function seamCalls(): { file: string; fn: string; hasRecord: boolean }[] {
  const calls: { file: string; fn: string; hasRecord: boolean }[] = [];
  for (const file of tsFiles("src")) {
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(/throwBatchRejection\(/g)) {
      const offset = match.index ?? 0;
      if (/function\s*$/.test(source.slice(0, offset))) continue;
      const body = source.slice(offset, callEnd(source, offset + "throwBatchRejection".length));
      calls.push({
        file,
        fn: enclosingFunction(source, offset),
        hasRecord: /\brecord\s*:/.test(body),
      });
    }
  }
  return calls;
}

function producerCalls(name: string): string[] {
  const hits: string[] = [];
  for (const file of tsFiles("src")) {
    for (const [index, line] of readFileSync(file, "utf-8").split("\n").entries()) {
      if (!new RegExp(`\\b${name}\\b`).test(line) || line.includes(`function ${name}(`)) continue;
      const trimmed = line.trim();
      if (
        trimmed.startsWith("import ") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*")
      )
        continue;
      hits.push(`${file}:${index + 1}`);
    }
  }
  return hits;
}

function batchAbortImporters(): string[] {
  const hits: string[] = [];
  for (const file of tsFiles("src")) {
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(
      /import\s+([\s\S]*?)\s+from\s+["'][^"']*edit-response(?:\.js)?["']/g,
    )) {
      const clause = match[1] ?? "";
      if (/\*\s*as\b/.test(clause) || /\bbatchAbort\b/.test(clause)) {
        hits.push(file);
        break;
      }
    }
  }
  return hits;
}
const ROWLESS_ALLOWLIST: { key: string; reason: string }[] = [];
const VERDICT_ALLOWLIST: { key: string; reason: string }[] = [
  {
    key: "src/edit-response.ts",
    reason: "batchAbort's own verdict renderer; every other site routes through it",
  },
];

describe("batch rejection assembler (#334)", () => {
  it("calls batchAbort in exactly one place in src/, inside the seam", () => {
    const hits = producerCalls("batchAbort");
    expect(hits.map((hit) => hit.replace(/:\d+$/, ""))).toEqual([
      "src/mutation-engine/batch-rejection.ts",
    ]);
    expect(hits).toHaveLength(1);
  });

  it("imports batchAbort in exactly one place in src/, inside the seam", () => {
    expect(batchAbortImporters()).toEqual(["src/mutation-engine/batch-rejection.ts"]);
  });

  it("builds the Batch rejected: verdict in exactly one place in src/, inside the formatter", () => {
    expect(VERDICT_ALLOWLIST).toHaveLength(1);
    for (const entry of VERDICT_ALLOWLIST) expect(entry.reason.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of tsFiles("src")) {
      for (const [index, line] of readFileSync(file, "utf-8").split("\n").entries()) {
        if (line.includes("Batch rejected:")) hits.push(`${file}:${index + 1}`);
      }
    }
    expect(hits.map((hit) => hit.replace(/:\d+$/, ""))).toEqual(
      VERDICT_ALLOWLIST.map((entry) => entry.key),
    );
    expect(hits).toHaveLength(VERDICT_ALLOWLIST.length);
  });

  it("calls recordRejectionServe in exactly one place in src/, inside the seam", () => {
    const hits = producerCalls("recordRejectionServe");
    expect(hits).toEqual(["src/mutation-engine/batch-rejection.ts:79"]);
  });

  it("pins the seam-call set itself (file+function) before the recorder filter", () => {
    expect(seamCalls().map((call) => `${call.file}#${call.fn}`)).toEqual([
      "src/mutation-engine/pipeline.ts#runMutations",
      "src/mutation-engine/pipeline.ts#runMutations",
      "src/mutation-engine/pipeline.ts#runMutations",
    ]);
  });

  it("keeps the no-recorder allowlist empty: every seam call carries a recorder", () => {
    expect(ROWLESS_ALLOWLIST).toHaveLength(0);
    const bare = seamCalls().filter((call) => !call.hasRecord);
    expect(bare).toEqual([]);
  });

  it("throws TypeError, never a silent skip, when rows arrive with no recorder", async () => {
    const error = new DomainError("E_STALE_RANGE", {
      headline: "line 2 drifted",
      servedRows: [{ position: 1, hash: "abcd" }],
      servedBlock: "abcd│beta",
      cause: "served-range staleness",
    });
    await expect(
      throwBatchRejection({ failures: [{ error, index: 0 }], total: 2, path: "s.txt" }),
    ).rejects.toThrow(TypeError);
    await expect(
      throwBatchRejection({ failures: [{ error, index: 0 }], total: 2, path: "s.txt" }),
    ).rejects.toThrow(/must record them/);
  });

  it("builds the verdict for a rowless batch and throws the bare error for total 1", async () => {
    const rowless = (): DomainError =>
      new DomainError("E_MALFORMED_ANCHOR", { rawAnchor: "ZZ", reason: "bad" });
    await expect(
      throwBatchRejection({ failures: [{ error: rowless(), index: 0 }], total: 2, path: "s.txt" }),
    ).rejects.toThrow("[MODEL] Batch rejected: 1 of 2 edits failed; nothing was written.");
    const bare = rowless();
    await expect(
      throwBatchRejection({ failures: [{ error: bare, index: 0 }], total: 1, path: "s.txt" }),
    ).rejects.toBe(bare);
  });
});

describe("noop-loop notification pins (#334-rework-2)", () => {
  beforeAll(async () => {
    await initHasher();
  });

  const notifications: ServedSpanNotification[] = [];

  afterEach(() => {
    clearServedSpanObserversForTests();
    notifications.length = 0;
  });

  it("pins the 1-item noop-loop rejection mirror (noop-loop-1item)", async () => {
    await withTempDir("batch-noop-1item-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const path = join(cwd, "sample.ts");
      const content = "aaa\nbbb\nccc\n";
      await writeFile(path, content, "utf-8");
      const hashes = await lineHashes(content, path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const payload = {
        file: "sample.ts",
        edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" }],
      };
      clearServedSpanObserversForTests();
      notifications.length = 0;
      addServedSpanObserver((notification) => notifications.push(notification));
      try {
        await editTool.execute("e1", payload, undefined, undefined, ctx);
        await editTool.execute("e2", payload, undefined, undefined, ctx);
        notifications.length = 0;
        const rejection = await editTool
          .execute("e3", payload, undefined, undefined, ctx)
          .catch((error: unknown) => error);
        expect((rejection as { code?: unknown }).code).toBe("E_NOOP_LOOP");
        expect((rejection as Error).message).not.toContain("Batch rejected:");
        const servedRows = (rejection as { servedRows: ServedRow[] }).servedRows;
        expect(servedRows.map((row) => row.position)).toEqual([1]);
        expect(notifications).toHaveLength(1);
        expect(notifications).toEqual([
          {
            filePath: path,
            spans: [{ startLine: 2, lineCount: 1 }],
            source: "reject-and-serve",
          },
        ]);
      } finally {
        clearServedSpanObserversForTests();
      }
    });
  });

  it("pins the 2-item noop-loop rejection mirror (noop-loop-2item)", async () => {
    await withTempDir("batch-noop-2item-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const path = join(cwd, "sample.ts");
      const content = "aaa\nbbb\nccc\nddd\n";
      await writeFile(path, content, "utf-8");
      const hashes = await lineHashes(content, path);
      await readTool.execute("r1", { file: "sample.ts" }, undefined, undefined, ctx);
      const payload = {
        file: "sample.ts",
        edits: [
          { anchor_from: hashes[0]!, anchor_to: hashes[0]!, text: "aaa" },
          { anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "bbb" },
        ],
      };
      clearServedSpanObserversForTests();
      notifications.length = 0;
      addServedSpanObserver((notification) => notifications.push(notification));
      try {
        await editTool.execute("e1", payload, undefined, undefined, ctx);
        await editTool.execute("e2", payload, undefined, undefined, ctx);
        notifications.length = 0;
        const rejection = await editTool
          .execute("e3", payload, undefined, undefined, ctx)
          .catch((error: unknown) => error);
        expect((rejection as { code?: unknown }).code).toBe("E_NOOP_LOOP");
        expect((rejection as Error).message).toContain("Batch rejected:");
        const servedRows = (rejection as { servedRows: ServedRow[] }).servedRows;
        expect(servedRows.map((row) => row.position)).toEqual([0]);
        expect(notifications).toHaveLength(1);
        expect(notifications).toEqual([
          {
            filePath: path,
            spans: [{ startLine: 1, lineCount: 1 }],
            source: "reject-and-serve",
          },
        ]);
      } finally {
        clearServedSpanObserversForTests();
      }
    });
  });

  it("emits nothing for a rowless rejection (seam early-return)", async () => {
    await withTempDir("batch-noop-rowless-", async (cwd) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const path = join(cwd, "q.txt");
      await writeFile(path, "one\ntwo\n", "utf-8");
      await readTool.execute("r1", { file: "q.txt" }, undefined, undefined, ctx);
      clearServedSpanObserversForTests();
      notifications.length = 0;
      addServedSpanObserver((notification) => notifications.push(notification));
      try {
        const rejection = await editTool
          .execute(
            "e1",
            { file: "q.txt", edits: [{ anchor_from: "ZZZZ", anchor_to: "ZZZZ", text: "NEW" }] },
            undefined,
            undefined,
            ctx,
          )
          .catch((error: unknown) => error);
        expect((rejection as { code?: unknown }).code).toBe("E_UNKNOWN_ANCHOR");
        expect((rejection as { servedRows: ServedRow[] }).servedRows).toEqual([]);
        expect(notifications).toEqual([]);
      } finally {
        clearServedSpanObserversForTests();
      }
    });
  });
});
