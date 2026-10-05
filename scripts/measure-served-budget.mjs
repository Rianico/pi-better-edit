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
 * Methodology: one warmup to stabilize the heap, double-GC before every
 * reading, and a final liveness touch — V8 collects bindings with no
 * subsequent use, so an untouched structure reads back as freed (that
 * mis-measurement showed the memo as -6.1 MB). Figures are retained-heap
 * deltas in MB; re-run to re-derive after any width or budget change.
 *
 * Run by hand with `node --expose-gc scripts/measure-served-budget.mjs`.
 * Not wired into any gate or package.json script.
 */
const N = 200_000;

function heapMB() {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed / 1048576;
}

// Distinct 4-char spellings over the live 62-char alphabet.
const ALPHA = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function spelling(i) {
  let out = "";
  let m = i;
  for (let j = 0; j < 4; j++) {
    out = ALPHA[m % 62] + out;
    m = Math.floor(m / 62);
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

// 3. The allocator bitset is fixed: ceil(62^4 / 32) words x 4 B.
const bitsetMB = (Math.ceil(62 ** 4 / 32) * 4) / 1048576;

console.log(`walked anchor array (${N}): ${(afterWalked - base).toFixed(1)} MB`);
console.log(`spelling memo (${N}, shared refs):  ${(afterMemo - afterWalked).toFixed(1)} MB`);
console.log(`allocator bitset (fixed):   ${bitsetMB.toFixed(2)} MB`);
console.log(
  `marginal total:               ${(afterMemo - base + bitsetMB).toFixed(1)} MB over the loaded text`,
);

// Liveness touch: bindings with no subsequent use read back as freed.
console.log(`(live: ${walked.length} anchors, ${memo.size} memo entries, sample ${walked[12345]})`);
