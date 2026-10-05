#!/usr/bin/env node
/**
 * Re-measurable probe behind the served admission budget in
 * src/constants.ts (SERVED_MAX_LINES = 200,000).
 *
 * Measures, at the live anchor width, the three retained structures the WHY
 * names: the per-line anchor array the paged walk still retains, the spelling
 * memo bounded by HASH_CACHE_MAX_ENTRIES (same 200,000-entry cap, holding the
 * SAME string objects — shared references, so its marginal cost is entry
 * overhead only), and the fixed allocator bitset (computed, not allocated).
 *
 * Self-checking: the width and alphabet measured here are asserted against
 * the live source of truth (src/hashline/alphabet.ts, re-exported through
 * src/hashline/hash-identity.ts). A width bump that forgets this probe fails
 * loudly instead of silently measuring the old width. The pass/fail target
 * lives with the budget (SERVED_MAX_LINES in src/constants.ts) and is echoed
 * below for comparison.
 *
 * Methodology: one warmup to stabilize the heap, double-GC before every
 * reading, and a final liveness touch — V8 collects bindings with no
 * subsequent use, so an untouched structure reads back as freed (that
 * mis-measurement showed the memo as -6.1 MB). Figures are retained-heap
 * deltas in MB; re-run to re-derive after any width or budget change.
 *
 * Run by hand with `node --expose-gc scripts/measure-served-budget.mjs`.
 * Not wired into any gate or package.json script.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const N = 200_000;

// Live width and alphabet, asserted against src/hashline/alphabet.ts below.
const WIDTH = 4;
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const alphabetSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "hashline", "alphabet.ts"),
  "utf8",
);
const liveWidth = Number(alphabetSrc.match(/export const HASH_LEN = (\d+);/)?.[1]);
const liveAlpha = alphabetSrc.match(/export const ALPHA = "([^"]+)";/)?.[1];

if (!Number.isInteger(liveWidth) || typeof liveAlpha !== "string") {
  console.error("measure-served-budget: cannot parse HASH_LEN/ALPHA from src/hashline/alphabet.ts");
  process.exitCode = 1;
} else if (liveWidth !== WIDTH || liveAlpha !== ALPHA) {
  console.error(
    `measure-served-budget: stale probe literals (probe WIDTH=${WIDTH} ALPHA[${ALPHA.length}] vs live HASH_LEN=${liveWidth} ALPHA[${liveAlpha.length}]); update the probe to the live width and re-run.`,
  );
  process.exitCode = 1;
} else {
  main();
}

function main() {
  console.log(
    `width check: HASH_LEN=${WIDTH}, alphabet=${ALPHA.length} chars (matches src/hashline/alphabet.ts)`,
  );

  // Distinct WIDTH-char spellings over the live 62-char alphabet.
  function spelling(i) {
    let out = "";
    let m = i;
    for (let j = 0; j < WIDTH; j++) {
      out = ALPHA[m % ALPHA.length] + out;
      m = Math.floor(m / ALPHA.length);
    }
    return out;
  }

  // Warmup: stabilize the heap and collect compile debris before the baseline.
  for (let i = 0; i < 20000; i++) spelling(i);

  const base = heapMB();

  // 1. The walked anchor array: one entry per hashed line, retained even for an
  // unshown window (src/file-content/preview.ts walkPage).
  const walked = new Array(N);
  for (let i = 0; i < N; i++) walked[i] = spelling(i);
  const afterWalked = heapMB();

  // 2. The spelling memo over the same strings (HASH_CACHE_MAX_ENTRIES =
  // SERVED_MAX_LINES, src/hashline/hash-identity.ts): Map<idx, spelling> where
  // each value IS the walked array's string (shared reference, no duplicate
  // string bytes) — the delta below is entry overhead only.
  const memo = new Map();
  for (let i = 0; i < N; i++) memo.set(i, walked[i]);
  const afterMemo = heapMB();

  // 3. The allocator bitset is fixed: ceil(ALPHA^WIDTH / 32) words x 4 B.
  const bitsetMB = (Math.ceil(ALPHA.length ** WIDTH / 32) * 4) / 1048576;

  console.log(`walked anchor array (${N}): ${(afterWalked - base).toFixed(1)} MB`);
  console.log(`spelling memo (${N}, shared refs):  ${(afterMemo - afterWalked).toFixed(1)} MB`);
  console.log(`allocator bitset (fixed):   ${bitsetMB.toFixed(2)} MB`);
  console.log(
    `marginal total:               ${(afterMemo - base + bitsetMB).toFixed(1)} MB over the loaded text`,
  );
  console.log(
    `target: ~15 MB (200,000 lines x ~77 B/line pre-paging basis; see SERVED_MAX_LINES in src/constants.ts)`,
  );

  // Liveness touch: bindings with no subsequent use read back as freed.
  console.log(
    `(live: ${walked.length} anchors, ${memo.size} memo entries, sample ${walked[12345]})`,
  );
}

function heapMB() {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed / 1048576;
}
