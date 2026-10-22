/**
 * Ticket #162 benchmark: what an unchanged 100k-line file costs a READ, before and after the
 * stat-identity fast path (ADR-0043). Dev-only, not gated — run `node scripts/bench-adopt.mjs`.
 *
 * Every number below is measured through the real read tool (`register` + a fake pi registry), so it
 * includes the store transaction, the served mirror, and the lease grant an actual read performs.
 * Run it on a commit without the fast path and with one; the printed table is directly comparable.
 *
 * The store lives in `PI_BETTER_EDIT_CONFIG_DIR` (set by the runner), so runs never touch a real store.
 */
import { mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index";
import { initHasher } from "../src/hashline/hash-identity.js";
import { shutdownHashStore } from "../src/hash-store";

const LINES = 100_000;
const SAMPLES = 5;
const CONTENT =
  Array.from(
    { length: LINES },
    (_, index) => `line ${index} lorem ipsum dolor sit amet consectetur adipiscing`,
  ).join("\n") + "\n";

type Tool = {
  execute: (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text?: string }> }>;
};

type ReadTool = Tool & {
  name: string;
  prepareArguments?: (params: unknown) => unknown;
};

function makeReadTool(): Tool {
  const tools = new Map<string, ReadTool>();
  let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const pi = {
    registerTool(tool: ReadTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === "session_start") sessionStart = handler;
    },
  };
  register(pi as never);
  const tool = tools.get("read");
  if (tool === undefined) throw new Error("bench: the read tool did not register");
  // WHY: the served-state hooks run on session start; without them the read has no store context.
  return {
    execute: (id, params, signal, onUpdate, ctx) => {
      void sessionStart?.({ type: "session_start", reason: "startup" }, ctx);
      return tool.execute(id, tool.prepareArguments?.(params) ?? params, signal, onUpdate, ctx);
    },
  };
}

const ctxFor = (cwd: string) => ({
  cwd,
  ui: { notify() {} },
  sessionManager: { getSessionId: () => "bench-adopt" },
});

const dir = await mkdtemp(join(tmpdir(), "pi-bench-adopt-"));
const path = join(dir, "big.txt");
await writeFile(path, CONTENT, "utf-8");
await initHasher();
const tool = makeReadTool();
const ctx = ctxFor(dir);
let request = 0;

// WHY: a page read is the read this ticket measures — the builtin read tool asks for a bounded page,
// WHY: and the page is the work an adoption must keep. `PAGE` is the same request every run makes.
const PAGE = { file: "big.txt", windows: [{ offset: 1, limit: 2_000 }] };

async function read(label: string, params: Record<string, unknown> = PAGE): Promise<number> {
  const started = performance.now();
  const result = await tool.execute(`r${request++}`, params, undefined, undefined, ctx);
  const elapsed = performance.now() - started;
  if (result.content[0]?.text === undefined) throw new Error(`bench: ${label} returned no content`);
  return elapsed;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

async function samples(
  label: string,
  before: () => Promise<void>,
  params: Record<string, unknown> = PAGE,
): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    await before();
    times.push(await read(label, params));
  }
  const value = median(times);
  console.log(`${label.padEnd(34)} ${value.toFixed(1).padStart(8)} ms  (median of ${SAMPLES})`);
  return value;
}

const fixed = (value: number) => `${value.toFixed(1)} ms`;

console.log(`fixture: ${LINES.toLocaleString()} lines, ${(CONTENT.length / 1e6).toFixed(2)} MB\n`);

const cold = await read("cold");
// WHY: a page-sized read must not resolve the file's remaining anchors; the whole-file read below
// WHY: checks that it still renders (it retains every line before truncating by design).
console.log(`${"first read (cold materialization)".padEnd(34)} ${fixed(cold).padStart(8)}`);

const adopt = await samples("unchanged adoption (page)", async () => {});
const wholeFile = await samples("unchanged adoption (whole file)", async () => {}, {
  file: "big.txt",
});
const untouched = await samples("unchanged adoption (page, repeat)", async () => {});

const touch = await samples("touch, then adopt", async () => {
  await utimes(path, new Date(), new Date(Date.now() + 1_000));
});

const replace = await samples("atomic replace, then adopt", async () => {
  const next = join(dir, "big.next");
  await writeFile(next, CONTENT, "utf-8");
  await rename(next, path);
});

let mutations = 0;
const changed = await samples("one-line content change", async () => {
  // WHY: every sample writes new bytes (a plain edit, no mtime restore), so each one pays the
  // WHY: content-hash path — the cost ADR-0043 deliberately leaves alone.
  await writeFile(path, CONTENT.replace("line 50000 ", `line 50000_${mutations++}`), "utf-8");
});

console.log(`\nsummary: page adoption ${fixed(adopt)} vs first read ${fixed(cold)}`);
console.log(`         touch fallback ${fixed(touch)}, rename fallback ${fixed(replace)}`);
console.log(`         changed ${fixed(changed)} (content-hash path, unchanged by ADR-0043)`);
console.log(
  `         repeat adoption ${fixed(untouched)}, whole-file adoption ${fixed(wholeFile)}`,
);

shutdownHashStore();
await rm(dir, { recursive: true, force: true });
