/**
 * Ticket #163 benchmark: the cost of a one-region change to a large file, before/after the
 * unchanged-boundary trim in patience pairing (ADR-0044). Dev-only, not gated — run
 * `node scripts/bench-pair-trim.mjs`.
 *
 * Two numbers are recorded:
 * - end-to-end: a 100k-line file is materialized, then one line is rewritten (a plain edit, not a
 *   tool call) and the following READ is timed — that read is the cache-miss fallback that hashes
 *   the file and runs patience pairing against the previous snapshot;
 * - pairing alone: `pairSnapshots` over the same two snapshots, with `{ trim: false }` (the full
 *   scan the shortcut replaces) against the default (trimmed) path, in the same process.
 *
 * Anchor stability is checked on every sample: the anchors of every unchanged line must be
 * identical before and after the rewrite; only the edited line may move.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index";
import { initHasher, lineHashes } from "../src/hashline/hash-identity.js";
import { shutdownHashStore } from "../src/hash-store";
import { pairSnapshots, type LineDescriptor } from "../src/hashline/patience-pairing";

const LINES = 100_000;
const EDITED = 50_000;
const SAMPLES = 5;
const BASE = Array.from(
  { length: LINES },
  (_, index) => `line ${index} lorem ipsum dolor sit amet consectetur adipiscing`,
);

type Tool = {
  name: string;
  prepareArguments?: (params: unknown) => unknown;
  execute: (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text?: string }> }>;
};

function makeTool(name: string): Tool {
  const tools = new Map<string, Tool>();
  let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const pi = {
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === "session_start") sessionStart = handler;
    },
  };
  register(pi as never);
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`bench: the ${name} tool did not register`);
  return {
    name,
    ...(tool.prepareArguments !== undefined ? { prepareArguments: tool.prepareArguments } : {}),
    execute: (id, params, signal, onUpdate, ctx) => {
      void sessionStart?.({ type: "session_start", reason: "startup" }, ctx);
      return tool.execute(id, tool.prepareArguments?.(params) ?? params, signal, onUpdate, ctx);
    },
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

const dir = await mkdtemp(join(tmpdir(), "pi-bench-pair-"));
const path = join(dir, "big.txt");
const baseContent = BASE.join("\n") + "\n";
await writeFile(path, baseContent, "utf-8");
await initHasher();
const readTool = makeTool("read");
const ctx = { cwd: dir, ui: { notify() {} }, sessionManager: { getSessionId: () => "bench-pair" } };
const PAGE = { file: "big.txt", windows: [{ offset: 1, limit: 500 }] };
let request = 0;

async function read(): Promise<number> {
  const started = performance.now();
  const result = await readTool.execute(
    `r${request++}`,
    readTool.prepareArguments?.(PAGE) ?? PAGE,
    undefined,
    undefined,
    ctx,
  );
  if (result.content[0]?.text === undefined) throw new Error("bench: read returned no content");
  return performance.now() - started;
}

const anchorsOf = (content: string): Promise<string[]> => lineHashes(content, path);

// Materialize the base content; this cold read is the "first materialization" reference row.
const firstMaterialization = await read();
const baseAnchors = await anchorsOf(baseContent);

const readTimes: number[] = [];
let unstable = 0;
for (let sample = 0; sample < SAMPLES; sample++) {
  // Fixed-width rewrites keep the size equal; only the bytes of one line (and the stat identity) move.
  const tag = String.fromCharCode(97 + sample).repeat(4);
  const changed = [...BASE];
  changed[EDITED] = `line ${EDITED} lorem ipsum dolor sit amet consectetur ${tag}`;
  const changedContent = changed.join("\n") + "\n";
  await writeFile(path, changedContent, "utf-8");
  readTimes.push(await read());

  const changedAnchors = await anchorsOf(changedContent);
  for (let line = 0; line < LINES; line++) {
    if (line === EDITED) continue;
    if (changedAnchors[line] !== baseAnchors[line]) unstable++;
  }
}

const changedContent =
  [...BASE]
    .map((line, index) =>
      index === EDITED ? `${line.slice(0, line.lastIndexOf(" "))} zzzz` : line,
    )
    .join("\n") + "\n";
const prev: LineDescriptor[] = BASE.map((line, index) => ({
  lineNumber: index + 1,
  canonHash: line.replace(/\s+/g, ""),
}));
const curr: LineDescriptor[] = changedContent
  .split("\n")
  .slice(0, -1)
  .map((line, index) => ({ lineNumber: index + 1, canonHash: line.replace(/\s+/g, "") }));

const quickest = (run: () => Map<number, number>): number => {
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
};
pairSnapshots(prev.slice(0, 50), curr.slice(0, 50));
pairSnapshots(prev.slice(0, 50), curr.slice(0, 50), { trim: false });
const fullPairing = quickest(() => pairSnapshots(prev, curr, { trim: false }));
const trimmedPairing = quickest(() => pairSnapshots(prev, curr));
const samePairing =
  [...pairSnapshots(prev, curr).entries()].join() ===
  [...pairSnapshots(prev, curr, { trim: false }).entries()].join();

console.log(`fixture: ${LINES.toLocaleString()} lines, one line rewritten`);
console.log(`first materialization (reference)             ${firstMaterialization.toFixed(1)} ms`);
console.log(`read after the change (median of ${SAMPLES})  ${median(readTimes).toFixed(1)} ms`);
console.log(`pairing, full scan                            ${fullPairing.toFixed(1)} ms`);
console.log(`pairing, unchanged-boundary trim              ${trimmedPairing.toFixed(1)} ms`);
console.log(
  `pairing speedup                               ${(fullPairing / trimmedPairing).toFixed(1)}x`,
);
console.log(`pairing identical to the full scan            ${samePairing ? "yes" : "NO"}`);
console.log(`unchanged-line anchors that moved             ${unstable} (must be 0)`);

shutdownHashStore();
await rm(dir, { recursive: true, force: true });
