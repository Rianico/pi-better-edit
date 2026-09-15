import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as snapshotStore from "../../src/snapshot-store";

/** Every `.ts` file under `dir`, depth first. */
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Static and dynamic import specifiers in one module source. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

describe("snapshot-store module boundary", () => {
  it("resolves the module entry and re-exports the vacuum policy surface", () => {
    // WHY: the directory module must keep the former single-file public surface reachable from the
    // WHY: bare module specifier, so no consumer has to reach into a sub-path to get it back.
    expect(typeof snapshotStore.vacuumSnapshots).toBe("function");
    expect(snapshotStore.VACUUM_GLOBAL_BUDGET_BYTES).toBe(50 * 1024 * 1024);
    expect(snapshotStore.VACUUM_SOFT_OVERFLOW_BYTES).toBe(100 * 1024 * 1024);
    expect(snapshotStore.VACUUM_PER_PATH_BUDGET_BYTES).toBe(10 * 1024 * 1024);
    expect(snapshotStore.VACUUM_MAX_SNAPSHOTS_PER_PATH).toBe(10);
    expect(snapshotStore.VACUUM_MIN_SNAPSHOTS_PER_PATH).toBe(2);
    expect(snapshotStore.VACUUM_LINEAGE_BYTES_PER_LINE).toBe(40);
    expect(snapshotStore.VACUUM_RETIRED_PIN_MS).toBe(60 * 60 * 1000);
  });

  it("has no consumer importing a snapshot-store sub-path", () => {
    const offenders: string[] = [];
    for (const file of [...tsFiles("src"), ...tsFiles("test"), "index.ts"]) {
      const source = readFileSync(file, "utf-8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.includes("snapshot-store") && !specifier.endsWith("snapshot-store")) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
