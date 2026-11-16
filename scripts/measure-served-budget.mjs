#!/usr/bin/env node
/**
 * Re-measurable probe behind the served admission budget in `src/constants.ts`
 * (SERVED_MAX_LINES = 200,000): at the live anchor width it measures the walked per-line
 * anchor array, the spelling memo bounded by HASH_CACHE_MAX_ENTRIES (same cap, holding the
 * SAME string objects — shared references, so entry overhead only), and the fixed bitset.
 *
 * Width and alphabet are asserted against `src/hashline/alphabet.ts`, so a bump that forgets
 * this probe fails loudly. Methodology: one warmup, double-GC per reading, and a final
 * liveness touch (an untouched structure reads back as freed; that mis-measurement once
 * showed the memo as -6.1 MB). Run by hand with `node --expose-gc`, from the repo root.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const N = 200_000;

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

  function spelling(i) {
    let out = "";
    let m = i;
    for (let j = 0; j < WIDTH; j++) {
      out = ALPHA[m % ALPHA.length] + out;
      m = Math.floor(m / ALPHA.length);
    }
    return out;
  }

  for (let i = 0; i < 20000; i++) spelling(i);

  const base = heapMB();

  const walked = Array.from({ length: N }, (_, i) => spelling(i));
  const afterWalked = heapMB();

  const memo = new Map();
  for (let i = 0; i < N; i++) memo.set(i, walked[i]);
  const afterMemo = heapMB();

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

  console.log(
    `(live: ${walked.length} anchors, ${memo.size} memo entries, sample ${walked[12345]})`,
  );
}

function heapMB() {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed / 1048576;
}
