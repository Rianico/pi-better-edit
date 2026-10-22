/**
 * #87c — the open stamp's hook-count field is a BUILD constant, proved across cold processes.
 *
 * WHY this file exists and why it builds a bundle: the stamp folds in `openHooks.length` so that a
 * build registering an ADDITIONAL open hook invalidates every stamp written by a build that did not
 * (see the WHY block above `storeGenerationStamp` in `src/hash-store.ts`). That only works if the
 * count is fixed by the module graph rather than by whatever happened to run first in a process — so
 * this test measures it the way a shipped build sees it: one esbuild bundle of the production entry
 * (the repo's own bundler wrapper, `scripts/build-dist.mjs`, whose `--entry` flag is a documented test
 * seam), executed by TWO COLD `node` processes. Each cold process opens a fresh store of its own and
 * prints the stamp it wrote; the two values must be IDENTICAL, which is the whole claim.
 *
 * WHY the count is read THROUGH the stamp rather than imported: `openHooks` is module-private, and a
 * public accessor would exist only for this test. The stamp IS the observable consequence — a count
 * that moved between processes would print two different values here.
 *
 * WHY this also covers the graph: the registry is filled by module top-level pushes, so
 * `openHooks.length` is a function of WHICH modules the entry pulls in. Bundling `index.ts` — the
 * production entry — is what makes the cold count the shipped one.
 *
 * LIMITATION, restated because this test must not be read as covering it: a SWAP (one hook removed,
 * another added) preserves the count, so this guards ADDITION only; a semantic change to an existing
 * hook's work is `HASH_STORE_VERSION`'s job (see the bump convention in `src/store-kernel/constants.ts`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

/** `<format>:<store schema>:<canon>:<anchor generation>:<registered open hooks>`. */
const STAMP_FIELD_COUNT = 5;
const STAMP_FORMAT_VERSION = 1;
/** The count field — the LAST field of that format. */
const HOOK_COUNT_FIELD = STAMP_FIELD_COUNT - 1;

/** The entry esbuild bundles: the production graph, plus this file's single observation. */
const COLD_ENTRY = `
import "../../index.js";
import { hashStorePath, loadHashStore, shutdownHashStore } from "../../src/hash-store.js";

await loadHashStore();
const row = new (await import("node:sqlite")).DatabaseSync(hashStorePath())
  .prepare("SELECT value FROM meta WHERE key = 'store_stamp'")
  .get();
process.stdout.write(JSON.stringify(row?.value ?? null));
shutdownHashStore();
`;

/**
 * Bundle the entry once, then run it in `runs` COLD node processes. Each process opens a store under
 * the config dir pinned in its own environment, so a value that depended on process state (rather than
 * on the module graph) would show up as a difference.
 */
function observeCold(runs: number): string[] {
  // WHY the entry lives INSIDE the repo and the bundle lands in `dist/`: the production graph reads
  // its prompt assets relative to the bundle's own directory (`../prompts/...`), so a bundle written
  // to a system temp directory fails at import. `dist/` is also gitignored and already the artifact's
  // home, which is why the relative depth matches the published build exactly.
  const work = mkdtempSync(join(process.cwd(), ".tmp", "open-hook-stamp-"));
  const entry = join(work, "entry.ts");
  const bundle = join(process.cwd(), "dist", `open-hook-stamp-cold-${basename(work)}.mjs`);
  try {
    writeFileSync(entry, COLD_ENTRY);
    execFileSync(
      process.execPath,
      ["scripts/build-dist.mjs", "--entry", entry, "--outfile", bundle],
      { cwd: process.cwd(), stdio: "pipe" },
    );

    const stamps: string[] = [];
    for (let run = 0; run < runs; run += 1) {
      const printed = execFileSync(process.execPath, [bundle], {
        cwd: process.cwd(),
        env: { ...process.env, PI_BETTER_EDIT_CONFIG_DIR: join(work, `store-${run}`) },
        encoding: "utf8",
      }).trim();
      // SAFETY: the entry writes exactly one JSON value — the stamp it read back, or `null`.
      const stamp = JSON.parse(printed) as string | null;
      expect(stamp, `cold process ${run} wrote no stamp`).toBeTypeOf("string");
      stamps.push(stamp as string);
    }
    return stamps;
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(bundle, { force: true });
  }
}

describe("the stamp's hook count is a build constant (#87c)", () => {
  it("is identical across two cold processes running the bundled production graph", () => {
    const stamps = observeCold(2);
    const first = stamps[0] as string;
    const second = stamps[1] as string;

    // WHY: the claim the folding rests on: two fresh processes, two fresh stores, one value.
    expect(second).toBe(first);

    const fields = first.split(":");
    expect(fields).toHaveLength(STAMP_FIELD_COUNT);
    expect(Number(fields[0])).toBe(STAMP_FORMAT_VERSION);
    // WHY: the field is the registry's own size, not a placeholder: a build that registered an
    // WHY: ADDITIONAL hook would print a larger count, which is exactly what invalidates an old stamp.
    expect(Number(fields[HOOK_COUNT_FIELD])).toBeGreaterThan(0);
    expect(Number.isInteger(Number(fields[HOOK_COUNT_FIELD]))).toBe(true);
  }, 120_000);
});
