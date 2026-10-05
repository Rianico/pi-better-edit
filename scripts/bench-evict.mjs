#!/usr/bin/env node
/**
 * Dev-only micro-benchmark behind the clear-on-full eviction choice in
 * src/hashline/hash-identity.ts (HASH_CACHE_MAX_ENTRIES): an unbounded Map vs
 * per-entry FIFO eviction via keys().next() vs clear-on-full at the served
 * admission budget. Not wired into any gate or package.json script — run by
 * hand with `node scripts/bench-evict.mjs`.
 */
const N = 1_000_000,
  MAX = 200_000;
let m = new Map();
let t = performance.now();
for (let i = 0; i < N; i++) m.set(i, "abcd");
console.log("unbounded set:", (performance.now() - t).toFixed(0), "ms, size", m.size);
m = new Map();
t = performance.now();
for (let i = 0; i < N; i++) {
  if (m.size >= MAX) {
    const o = m.keys().next();
    if (!o.done) m.delete(o.value);
  }
  m.set(i, "abcd");
}
console.log("fifo-evict:", (performance.now() - t).toFixed(0), "ms, size", m.size);
m = new Map();
t = performance.now();
for (let i = 0; i < N; i++) {
  if (m.size >= MAX) m.clear();
  m.set(i, "abcd");
}
console.log("clear-on-full:", (performance.now() - t).toFixed(0), "ms, size", m.size);
