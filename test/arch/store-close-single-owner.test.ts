/**
 * The checkpoint and the close have ONE owner, `shutdownDb` in `src/hash-store.ts`. The counts below
 * are literals, so a new close or checkpoint site fails this file — that edit is the review event.
 * A plain `readFileSync` walk keeps the check dependency-free, like its snapshot-store sibling.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** `db.exec("PRAGMA wal_checkpoint(TRUNCATE)")` sites in `src/`: one, inside `shutdownDb`. */
const CHECKPOINT_EXEC_SITES = 1;
/** `db.close()` sites in `src/`: two — the `buildStore` failure path and `shutdownDb`. */
const CLOSE_CALL_SITES = 2;
const CHECKPOINT_EXEC = 'db.exec("PRAGMA wal_checkpoint(TRUNCATE)")';
const CLOSE_CALL = "db.close()";
const STORE_PATH = join("src", "hash-store.ts");
const SLOT_PATH = join("src", "store-kernel", "lifecycle-slot.ts");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function sitesOf(needle: string): { file: string; count: number }[] {
  const sites: { file: string; count: number }[] = [];
  for (const file of tsFiles("src")) {
    const count = readFileSync(file, "utf-8").split(needle).length - 1;
    if (count > 0) sites.push({ file, count });
  }
  return sites;
}

describe("store close single owner", () => {
  it("truncates the WAL from one site, in the store module", () => {
    expect(sitesOf(CHECKPOINT_EXEC)).toEqual([{ file: STORE_PATH, count: CHECKPOINT_EXEC_SITES }]);
  });

  it("closes the database handle from two sites, both in the store module", () => {
    expect(sitesOf(CLOSE_CALL)).toEqual([{ file: STORE_PATH, count: CLOSE_CALL_SITES }]);
  });

  it("keeps the lifecycle slot free of both calls: it decides WHEN, never HOW", () => {
    const slot = readFileSync(SLOT_PATH, "utf-8");
    expect(slot).not.toContain("wal_checkpoint");
    expect(slot).not.toContain(".close(");
  });
});
