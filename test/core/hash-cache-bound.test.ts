import { beforeAll, describe, expect, it } from "vitest";
import { HashIdentity } from "../../src/hashline/hash-identity.js";
import { HASH_CACHE_MAX_ENTRIES } from "../../src/hashline/hash-identity.js";
import { SERVED_MAX_LINES } from "../../src/constants.js";
import { initHasher } from "../../src/hashline/hasher.js";

// WHY: `xxh32` throws until the module's `xxhash()` promise resolves, and this file derives anchors
// WHY: synchronously (`contentOnlyHashes`) — the import graph used to buy that time, an explicit init
// WHY: is what makes it deterministic instead of a race the CI host lost.
beforeAll(async () => {
  await initHasher();
});

function cacheSize(id: HashIdentity): number {
  return (id as unknown as { hashCache: Map<number, string> }).hashCache.size;
}

describe("hashCache bound", () => {
  it("pins the bound to the served admission budget", () => {
    expect(HASH_CACHE_MAX_ENTRIES).toBe(SERVED_MAX_LINES);
  });

  it("stays within the served admission budget on an over-budget allocation", () => {
    const id = new HashIdentity();
    const n = SERVED_MAX_LINES + 100_000;
    const content = Array.from({ length: n }, (_, i) => `line${i}`).join("\n");
    const hashes = id.contentOnlyHashes(content);
    expect(hashes).toHaveLength(n);
    expect(new Set(hashes).size).toBe(n);
    expect(cacheSize(id)).toBeLessThanOrEqual(SERVED_MAX_LINES);
  }, 120_000);

  it("derives anchors identically with and without eviction pressure", () => {
    const content = Array.from({ length: 50_000 }, (_, i) => `line${i}`).join("\n");
    const fresh = new HashIdentity().contentOnlyHashes(content);
    const pressured = new HashIdentity();
    pressured.contentOnlyHashes(
      Array.from({ length: SERVED_MAX_LINES + 10_000 }, (_, i) => `other${i}`).join("\n"),
    );
    expect(pressured.contentOnlyHashes(content)).toEqual(fresh);
  }, 120_000);
});
