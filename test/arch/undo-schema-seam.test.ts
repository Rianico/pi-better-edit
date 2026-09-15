import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { ensureFileUndoSchema } from "../../src/hash-store";

const UNDO_MODULE = "src/undo-store.ts";

/** Every `.ts` file under `dir`, depth first. */
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("undo schema — no forwarder between the store and its consumers (#103)", () => {
  it("undo-store exports no ensureUndoSchema forwarder", async () => {
    const mod = await import("../../src/undo-store.js");
    expect("ensureUndoSchema" in mod).toBe(false);
    // the store-open hook reaches the schema owner directly instead of through a wrapper
    expect(readFileSync(UNDO_MODULE, "utf-8")).toContain("ensureFileUndoSchema(db)");
  });

  it("no src module names ensureUndoSchema", () => {
    const offenders = tsFiles("src").filter((file) =>
      readFileSync(file, "utf-8").includes("ensureUndoSchema"),
    );
    expect(offenders).toEqual([]);
  });

  it("ensureFileUndoSchema is the direct, idempotent schema entry", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureFileUndoSchema(db);
      expect(() => ensureFileUndoSchema(db)).not.toThrow();
      const table = db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'file_undo'",
        )
        .get() as { n: number };
      expect(table.n).toBe(1);
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('file_undo')")
        .all()
        .map((column) => (column as { name: string }).name);
      expect(columns).toContain("snapshot_hash");
    } finally {
      db.close();
    }
  });
});
