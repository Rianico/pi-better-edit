import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import register from "../../index";
import { lineHashes } from "../../src/hashline";
import {
  withTempFile,
  getText,
  extractHash,
  makeFakePiRegistry,
  testSessionManager,
} from "../support/fixtures";

// WHY: per-scenario verdicts recovered from the deleted comparator
// WHY: (`f6c83a7:scripts/eval-compare.mjs` EXPECTED + `verdict()`). `outcome` and
// WHY: `preserve` semantics mirror `verdict()`; `byteIdentity` pins noop
// WHY: scenarios to byte-identical content (their `preserve` would be a
// WHY: substring of the pre-edit file and could never fail).
// WHY: `preserve` entries below are verbatim from that table except the
// WHY: two noop scenarios, which use `byteIdentity` instead (see above);
// WHY: entries on applied scenarios are derived from each scenario's own
// WHY: replacement text in this file (marked DERIVED). Without them the
// WHY: battery records outcomes it never compares and cannot fail.
type Verdict = { outcome: "success" | "rejected"; preserve?: string; byteIdentity?: boolean };
const EXPECTED: Record<string, Verdict> = {
  "B1 single-line replace": { outcome: "success", preserve: "BBB" }, // DERIVED
  "B2 range replace": { outcome: "success", preserve: "X\nY" }, // DERIVED
  "B3 interior drift must-not-silently-overwrite": {
    outcome: "rejected",
    preserve: "CCC",
  },
  "B4 out-of-range in-place change": { outcome: "success", preserve: "X\nY" }, // DERIVED
  "B5 deletion-above-range positional-shift": { outcome: "success", preserve: "X\nY" }, // DERIVED
  "B6 change-then-revert interior": { outcome: "success", preserve: "X\nY" }, // DERIVED
  "B7 unread interior paged-read-gap now applies (ADR-0024)": {
    outcome: "success",
    preserve: "X\nY\nZ\nW\nV",
  }, // DERIVED: behavior changed since the deleted table (ADR-0024)
  "B8 blind-edit no-read never-served-boundary": {
    outcome: "rejected",
    preserve: "aaa\nbbb\nccc\n",
  },
  "B9 boundary-changed stale-anchor": { outcome: "rejected" },
  "B10 duplicate-content drift must-still-reject": {
    outcome: "rejected",
    preserve: "\nb\nd\n",
  },
  "B11 noop replace": { outcome: "success", byteIdentity: true },
  "B12 noop-with-out-of-range-drift": { outcome: "success", byteIdentity: true },
  "B13 chained-edit-from-diff-rows-no-reread": { outcome: "success", preserve: "B2" }, // DERIVED
  "B14 empty-file insert": { outcome: "success", preserve: "first\nsecond" }, // DERIVED
  "B15 large-range drift capped-feedback": {
    outcome: "rejected",
    preserve: "line 1",
  },
  "B16a undo after replace": { outcome: "success", preserve: "bbb" }, // DERIVED
  "B16b undo after external change": { outcome: "rejected" },
  "B17 reversed-range autocorrect": { outcome: "success", preserve: "X\nY" }, // DERIVED
  "B18 boundary-dup autocorrect": { outcome: "success", preserve: "a\nX" }, // DERIVED
  "B19 sub-agent-session-does-not-wipe-main": { outcome: "success", preserve: "BBB" }, // DERIVED
  "B20 main-and-sub-agent-both-edit": { outcome: "success", preserve: "B\nC" }, // DERIVED
  "B21 same-session-restart-keeps-served-state": {
    outcome: "success",
    preserve: "BBB",
  }, // DERIVED
  "B22 sub-agent-serves-not-visible-to-main": { outcome: "rejected" },
  "B23 duplicate-canon silent-miswrite prevention (Probe E / #61)": {
    outcome: "rejected",
    preserve: "int f2",
  },
  "B24 symmetric contested-swap fail-closed (Probe K)": {
    outcome: "rejected",
    preserve: "function beta",
  },
  "B25 foreign-anchor foreign-source isolation (#145)": {
    outcome: "rejected",
    preserve: "charlie\ndelta\n",
  },
  "B26 UTF-8 BOM preservation across edit (#23/#60)": {
    outcome: "success",
    preserve: "\uFEFFfirst\nSECOND\nthird\n",
  },
};
interface Call {
  tool: string;
  outLen: number;
}

interface ScenarioResult {
  scenario: string;
  outcome: "success" | "rejected" | "error";
  code?: string;
  calls: Call[];
  finalContent: string;
  preEdit?: string;
}

interface Ctx {
  cwd: string;
}

function codeOf(text: string): string | undefined {
  const m = text.match(/\[E_[A-Z_]+\]/);
  return m ? m[0] : undefined;
}

async function call(
  rec: ScenarioResult,
  tool: unknown,
  name: string,
  params: unknown,
  ctx: Ctx,
): Promise<{ ok: boolean; text: string; code?: string; r?: any }> {
  try {
    const r = await (tool as any).execute("x", params, undefined, undefined, ctx);
    const text = getText(r);
    rec.calls.push({ tool: name, outLen: text.length });
    const isError = (r as any)?.isError === true;
    return isError ? { ok: false, text, code: codeOf(text), r } : { ok: true, text, r };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rec.calls.push({ tool: name, outLen: msg.length });
    return { ok: false, text: msg, code: codeOf(msg) };
  }
}

function readAnchor(text: string, marker: string): string {
  const line = text.split("\n").find((l) => l.includes(marker));
  expect(line, `read output should contain "${marker}"`).toBeDefined();
  return extractHash(line!);
}

function setupTarget(cwd: string): {
  ctx: Ctx;
  getTool: (name: string) => unknown;
  handlers: Map<string, (...args: unknown[]) => unknown>;
} {
  const { pi, getTool } = makeFakePiRegistry();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const origOn = pi.on.bind(pi);
  const wrapped = ((event: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(event, handler);
    return origOn(event, handler);
  }) as typeof pi.on;
  pi.on = wrapped;
  register(pi);
  return { ctx: { cwd, sessionManager: testSessionManager } as Ctx, getTool, handlers };
}

async function deliverDiff(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  ctx: Ctx,
  event: {
    toolName: string;
    isError: boolean;
    input: unknown;
    details: unknown;
    content: unknown;
  },
): Promise<string> {
  const h = handlers.get("tool_result");
  expect(h).toBeDefined();
  const out = await h!(event, ctx);
  const text = (out as any)?.content?.[0]?.text ?? "";
  return text;
}

async function fireSessionStart(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  ctx: Ctx,
): Promise<void> {
  const h = handlers.get("session_start");
  if (h) await h({ reason: "startup" }, ctx);
}

function sessionCtx(cwd: string, id: string): Ctx {
  return { cwd, sessionManager: { getSessionId: () => id } } as Ctx;
}

describe("tool battery (deterministic edit scenarios)", () => {
  it("runs all 27 scenarios without harness errors", async () => {
    const results: ScenarioResult[] = [];
    await withTempFile("b1.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B1 single-line replace",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b1.ts" }, ctx);
      const anchor = readAnchor(r1.text, "│bbb");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b1.ts", edits: [{ anchor_from: anchor, anchor_to: anchor, text: "BBB" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b2.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B2 range replace",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b2.ts" }, ctx);
      const a = readAnchor(r1.text, "│bbb");
      const b = readAnchor(r1.text, "│ccc");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b2.ts", edits: [{ anchor_from: a, anchor_to: b, text: "X\nY" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b3.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B3 interior drift must-not-silently-overwrite",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b3.ts" }, ctx);
      const a = readAnchor(r1.text, "│bbb");
      const b = readAnchor(r1.text, "│ddd");
      await writeFile(path, "aaa\nbbb\nCCC\nddd\n", "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b3.ts", edits: [{ anchor_from: a, anchor_to: b, text: "X\nY\nZ" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b4.ts", "aaa\nbbb\nccc\nddd\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B4 out-of-range in-place change",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b4.ts" }, ctx);
      const a = readAnchor(r1.text, "│bbb");
      const b = readAnchor(r1.text, "│ccc");
      await writeFile(path, "AAA\nbbb\nccc\nddd\n", "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b4.ts", edits: [{ anchor_from: a, anchor_to: b, text: "X\nY" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b5.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B5 deletion-above-range positional-shift",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b5.ts" }, ctx);
      const a = readAnchor(r1.text, "│b");
      const b = readAnchor(r1.text, "│c");
      await writeFile(path, "b\nc\nd\ne\n", "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b5.ts", edits: [{ anchor_from: a, anchor_to: b, text: "X\nY" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b6.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B6 change-then-revert interior",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b6.ts" }, ctx);
      const a = readAnchor(r1.text, "│b");
      const b = readAnchor(r1.text, "│c");
      await writeFile(path, "a\nB\nc\nd\n", "utf-8");
      await writeFile(path, "a\nb\nc\nd\n", "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b6.ts", edits: [{ anchor_from: a, anchor_to: b, text: "X\nY" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile(
      "b7.ts",
      Array.from({ length: 9 }, (_, i) => `l${i + 1}`).join("\n"),
      async ({ cwd, path }) => {
        const rec: ScenarioResult = {
          scenario: "B7 unread interior paged-read-gap now applies (ADR-0024)",
          outcome: "success",
          calls: [],
          finalContent: "",
        };
        const { ctx, getTool } = setupTarget(cwd);
        const r1 = await call(rec, getTool("read"), "read", { file: "b7.ts", limit: 3 }, ctx);
        const r2 = await call(rec, getTool("read"), "read", { file: "b7.ts", offset: 7 }, ctx);
        const a = readAnchor(r1.text, "│l3");
        const b = readAnchor(r2.text, "│l7");
        const e1 = await call(
          rec,
          getTool("edit"),
          "edit",
          { file: "b7.ts", edits: [{ anchor_from: a, anchor_to: b, text: "X\nY\nZ\nW\nV" }] },
          ctx,
        );
        rec.outcome = e1.ok ? "success" : "rejected";
        rec.code = e1.code;
        rec.finalContent = await readFile(path, "utf-8");
        results.push(rec);
      },
    );

    await withTempFile("b8.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B8 blind-edit no-read never-served-boundary",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const hashes = await lineHashes("aaa\nbbb\nccc\n", join(cwd, "b8.ts"));
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b8.ts", edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "BBB" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b9.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B9 boundary-changed stale-anchor",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b9.ts" }, ctx);
      const a = readAnchor(r1.text, "│bbb");
      await writeFile(path, "aaa\nBBB\nccc\n", "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b9.ts", edits: [{ anchor_from: a, anchor_to: a, text: "X" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b10.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B10 duplicate-content drift must-still-reject",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b10.ts" }, ctx);
      const a = readAnchor(r1.text, "│a");
      const b = readAnchor(r1.text, "│d");
      await writeFile(path, "a\nb\nb\nd\n", "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b10.ts", edits: [{ anchor_from: a, anchor_to: b, text: "X\nY\nZ\nW" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b11.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B11 noop replace",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b11.ts" }, ctx);
      const a = readAnchor(r1.text, "│bbb");
      rec.preEdit = await readFile(path, "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b11.ts", edits: [{ anchor_from: a, anchor_to: a, text: "bbb" }] },
        ctx,
      );
      rec.outcome = e1.ok ? (e1.text.includes("noop") ? "success" : "error") : "rejected";
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b12.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B12 noop-with-out-of-range-drift",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b12.ts" }, ctx);
      const a = readAnchor(r1.text, "│a");
      await writeFile(path, "a\nb\nc\nD\n", "utf-8");
      rec.preEdit = await readFile(path, "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b12.ts", edits: [{ anchor_from: a, anchor_to: a, text: "a" }] },
        ctx,
      );
      rec.outcome = e1.ok ? (e1.text.includes("noop") ? "success" : "error") : "rejected";
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b13.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B13 chained-edit-from-diff-rows-no-reread",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool, handlers } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b13.ts" }, ctx);
      const a = readAnchor(r1.text, "│b");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b13.ts", edits: [{ anchor_from: a, anchor_to: a, text: "B" }] },
        ctx,
      );
      const diff = await deliverDiff(handlers, ctx, {
        toolName: "edit",
        isError: false,
        input: { file: "b13.ts" },
        details: e1.r?.details,
        content: e1.r?.content,
      });
      const plusRow = diff.split("\n").find((l) => l.startsWith("+") && l.includes("│B"));
      if (plusRow) {
        const plusHash = plusRow.replace(/^\+/, "").split("│")[0]!;
        const e2 = await call(
          rec,
          getTool("edit"),
          "edit",
          { file: "b13.ts", edits: [{ anchor_from: plusHash, anchor_to: plusHash, text: "B2" }] },
          ctx,
        );
        if (!e2.ok) {
          rec.outcome = "rejected";
          rec.code = e2.code;
        }
      } else {
        rec.outcome = "error";
      }
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b14.ts", "", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B14 empty-file insert",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b14.ts" }, ctx);
      const emptyHash = r1.text.split("\n")[0]!.split("│")[0]!;
      expect(emptyHash).toMatch(/^[A-Za-z0-9]{4}$/);
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        {
          file: "b14.ts",
          edits: [{ anchor_from: emptyHash, anchor_to: emptyHash, text: "first\nsecond" }],
        },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile(
      "b15.ts",
      Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"),
      async ({ cwd, path }) => {
        const rec: ScenarioResult = {
          scenario: "B15 large-range drift capped-feedback",
          outcome: "success",
          calls: [],
          finalContent: "",
        };
        const { ctx, getTool } = setupTarget(cwd);
        const r1 = await call(rec, getTool("read"), "read", { file: "b15.ts" }, ctx);
        const a = readAnchor(r1.text, "│line 1");
        const b = readAnchor(r1.text, "│line 200");
        await writeFile(
          path,
          Array.from({ length: 200 }, (_, i) => (i === 99 ? "LINE 100" : `line ${i + 1}`)).join(
            "\n",
          ),
          "utf-8",
        );
        const e1 = await call(
          rec,
          getTool("edit"),
          "edit",
          { file: "b15.ts", edits: [{ anchor_from: a, anchor_to: b, text: "replacement" }] },
          ctx,
        );
        rec.outcome = e1.ok ? "success" : "rejected";
        rec.code = e1.code;
        rec.finalContent = await readFile(path, "utf-8");
        results.push(rec);
      },
    );

    await withTempFile("b16.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B16a undo after replace",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b16.ts" }, ctx);
      const a = readAnchor(r1.text, "│bbb");
      await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b16.ts", edits: [{ anchor_from: a, anchor_to: a, text: "BBB" }] },
        ctx,
      );
      const u1 = await call(rec, getTool("undo_last_edit"), "undo", { path: "b16.ts" }, ctx);
      rec.outcome = u1.ok ? "success" : "rejected";
      rec.code = u1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b16b.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B16b undo after external change",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b16b.ts" }, ctx);
      const a = readAnchor(r1.text, "│bbb");
      await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b16b.ts", edits: [{ anchor_from: a, anchor_to: a, text: "BBB" }] },
        ctx,
      );
      await writeFile(path, "AAA\nBBB\nccc\n", "utf-8");
      const u1 = await call(rec, getTool("undo_last_edit"), "undo", { path: "b16b.ts" }, ctx);
      rec.outcome = u1.ok ? "success" : "rejected";
      rec.code = u1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b17.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B17 reversed-range autocorrect",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b17.ts" }, ctx);
      const a = readAnchor(r1.text, "│b");
      const b = readAnchor(r1.text, "│c");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b17.ts", edits: [{ anchor_from: b, anchor_to: a, text: "X\nY" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b18.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B18 boundary-dup autocorrect",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b18.ts" }, ctx);
      const a = readAnchor(r1.text, "│b");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b18.ts", edits: [{ anchor_from: a, anchor_to: a, text: "a\nX" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b19.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B19 sub-agent-session-does-not-wipe-main",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { getTool, handlers } = setupTarget(cwd);
      const mainCtx = sessionCtx(cwd, "eval-main");
      const subCtx = sessionCtx(cwd, "eval-sub");
      const r1 = await call(rec, getTool("read"), "read", { file: "b19.ts" }, mainCtx);
      const a = readAnchor(r1.text, "│bbb");
      await fireSessionStart(handlers, subCtx);
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b19.ts", edits: [{ anchor_from: a, anchor_to: a, text: "BBB" }] },
        mainCtx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b20.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B20 main-and-sub-agent-both-edit",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { getTool, handlers } = setupTarget(cwd);
      const mainCtx = sessionCtx(cwd, "eval-main");
      const subCtx = sessionCtx(cwd, "eval-sub");
      const r1 = await call(rec, getTool("read"), "read", { file: "b20.ts" }, mainCtx);
      const aC = readAnchor(r1.text, "│c");
      await fireSessionStart(handlers, subCtx);
      const s1 = await call(rec, getTool("read"), "read", { file: "b20.ts", limit: 2 }, subCtx);
      const sB = readAnchor(s1.text, "│b");
      const se = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b20.ts", edits: [{ anchor_from: sB, anchor_to: sB, text: "B" }] },
        subCtx,
      );
      if (se.ok) {
        await deliverDiff(handlers, subCtx, {
          toolName: "edit",
          isError: false,
          input: { file: "b20.ts" },
          details: se.r?.details,
          content: se.r?.content,
        });
      }
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b20.ts", edits: [{ anchor_from: aC, anchor_to: aC, text: "C" }] },
        mainCtx,
      );
      rec.outcome = se.ok ? (e1.ok ? "success" : "rejected") : "error";
      rec.code = se.ok ? e1.code : se.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b21.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B21 same-session-restart-keeps-served-state",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { getTool, handlers } = setupTarget(cwd);
      const mainCtx = sessionCtx(cwd, "eval-main");
      await fireSessionStart(handlers, mainCtx);
      const r1 = await call(rec, getTool("read"), "read", { file: "b21.ts" }, mainCtx);
      const a = readAnchor(r1.text, "│bbb");
      await fireSessionStart(handlers, mainCtx);
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b21.ts", edits: [{ anchor_from: a, anchor_to: a, text: "BBB" }] },
        mainCtx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b22.ts", "a\nb\nc\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B22 sub-agent-serves-not-visible-to-main",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { getTool } = setupTarget(cwd);
      const mainCtx = sessionCtx(cwd, "eval-main");
      const subCtx = sessionCtx(cwd, "eval-sub");
      await call(rec, getTool("read"), "read", { file: "b22.ts" }, subCtx);
      const hashes = await lineHashes("a\nb\nc\n", join(cwd, "b22.ts"));
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b22.ts", edits: [{ anchor_from: hashes[1]!, anchor_to: hashes[1]!, text: "B" }] },
        mainCtx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    const B23_SMALL_CPP =
      "int f1(int x) {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n\treturn -x;\n}\n\nint f2(int x) {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n\treturn -x;\n}\n";
    const B23_F2_ONLY = "int f2(int x) {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n\treturn -x;\n}\n";

    await withTempFile("b23.cpp", B23_SMALL_CPP, async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B23 duplicate-canon silent-miswrite prevention (Probe E / #61)",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b23.cpp" }, ctx);
      const line2Hash = readAnchor(r1.text, "│\tif (x > 0) {");
      await writeFile(path, B23_F2_ONLY, "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        {
          file: "b23.cpp",
          edits: [{ anchor_from: line2Hash, anchor_to: line2Hash, text: "\tif (x > 100) {" }],
        },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    const B24_ORIGINAL =
      'function alpha() {\n  return "alpha";\n} // end alpha\n\nfunction beta() {\n  return "beta";\n} // end beta\n';
    const B24_SWAPPED =
      'function beta() {\n  return "beta";\n} // end beta\n\nfunction alpha() {\n  return "alpha";\n} // end alpha\n';

    await withTempFile("b24.js", B24_ORIGINAL, async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B24 symmetric contested-swap fail-closed (Probe K)",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b24.js" }, ctx);
      const a = readAnchor(r1.text, "│function alpha() {");
      const b = readAnchor(r1.text, "│} // end alpha");
      await writeFile(path, B24_SWAPPED, "utf-8");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        {
          file: "b24.js",
          edits: [
            {
              anchor_from: a,
              anchor_to: b,
              text: "function alpha() {\n  return 'alpha-modified';\n} // end alpha",
            },
          ],
        },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    await withTempFile("b25a.ts", "alpha\nbravo\n", async ({ cwd }) => {
      const pathB = join(cwd, "b25b.ts");
      await writeFile(pathB, "charlie\ndelta\n", "utf-8");
      const rec: ScenarioResult = {
        scenario: "B25 foreign-anchor foreign-source isolation (#145)",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b25a.ts" }, ctx);
      const anchorBravo = readAnchor(r1.text, "│bravo");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        {
          file: "b25b.ts",
          edits: [{ anchor_from: anchorBravo, anchor_to: anchorBravo, text: "MODIFIED" }],
        },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(pathB, "utf-8");
      results.push(rec);
    });

    await withTempFile("b26.txt", "\uFEFFfirst\nsecond\nthird\n", async ({ cwd, path }) => {
      const rec: ScenarioResult = {
        scenario: "B26 UTF-8 BOM preservation across edit (#23/#60)",
        outcome: "success",
        calls: [],
        finalContent: "",
      };
      const { ctx, getTool } = setupTarget(cwd);
      const r1 = await call(rec, getTool("read"), "read", { file: "b26.txt" }, ctx);
      const anchor = readAnchor(r1.text, "│second");
      const e1 = await call(
        rec,
        getTool("edit"),
        "edit",
        { file: "b26.txt", edits: [{ anchor_from: anchor, anchor_to: anchor, text: "SECOND" }] },
        ctx,
      );
      rec.outcome = e1.ok ? "success" : "rejected";
      rec.code = e1.code;
      rec.finalContent = await readFile(path, "utf-8");
      results.push(rec);
    });

    expect(results).toHaveLength(27);
    expect(results.filter((r) => r.outcome === "error")).toEqual([]);
    // WHY: the recovered comparator — every recorded outcome, code, and
    // WHY: preserved content is compared, not just counted. `verdict()`
    // WHY: semantics: outcome must match; a rejection must carry a code;
    // WHY: preserved content must survive in the final file.
    for (const rec of results) {
      const exp = EXPECTED[rec.scenario];
      expect(exp, `missing expectation for ${rec.scenario}`).toBeDefined();
      expect(rec.outcome).toBe(exp!.outcome);
      if (exp!.outcome === "rejected") {
        expect(rec.code).toBeDefined();
      }
      if (exp!.preserve !== undefined) {
        expect(rec.finalContent).toContain(exp!.preserve);
      }
      if (exp!.byteIdentity === true) {
        expect(rec.finalContent).toBe(rec.preEdit);
      }
    }
  });
});
