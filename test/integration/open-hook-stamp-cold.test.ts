/**
 * #87c — proves the open stamp's hook-count field is a BUILD constant, across cold processes. The
 * count folds in `openHooks.length` (the format and its bump rule live above `storeGenerationStamp`
 * in `src/hash-store.ts`), so the test measures it as a shipped build sees it: one esbuild bundle of
 * the production entry (`scripts/build-dist.mjs --entry`) run by TWO COLD node processes, each opening
 * a fresh store and printing its stamp — the two values must be identical.
 *
 * The count is read THROUGH the stamp because `openHooks` is module-private and a public accessor
 * would exist only for this test. Bundling `index.ts` is what makes the cold count the shipped one:
 * the registry is filled by module top-level pushes, so the count follows WHICH modules the entry
 * pulls in.
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

    expect(second).toBe(first);

    const fields = first.split(":");
    expect(fields).toHaveLength(STAMP_FIELD_COUNT);
    expect(Number(fields[0])).toBe(STAMP_FORMAT_VERSION);
    expect(Number(fields[HOOK_COUNT_FIELD])).toBeGreaterThan(0);
    expect(Number.isInteger(Number(fields[HOOK_COUNT_FIELD]))).toBe(true);
  }, 120_000);
});
