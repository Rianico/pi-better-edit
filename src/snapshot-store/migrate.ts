import { readFile, rename } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { contentChecksum } from "../hashline/hasher.js";
import { isValidHashList } from "../hashline/hash.js";
import { legacyHashStorePath } from "../hash-store.js";
import { splitLines, errCode } from "../utils.js";

interface LegacySnapshot {
  content: string;
  hashes: string[];
}

function isValidSnapshot(value: unknown): value is LegacySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.content !== "string") return false;
  return isValidHashList(v.hashes);
}

/**
 * v6 compatibility migration: import the pre-SQLite JSON hash store's snapshots into the `snapshots`
 * shell table once, then retire the legacy file. Runs only for a store that did not exist before
 * (spec §3.1.4), and every failure stays best-effort — a skipped legacy file is re-hashed on read.
 */
export async function migrateLegacyStore(db: DatabaseSync): Promise<void> {
  const legacyPath = legacyHashStorePath();
  let content: string;
  try {
    content = await readFile(legacyPath, "utf-8");
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return;
    // SAFETY: best-effort legacy migration — read failures beyond ENOENT are ignored; migration is optional and fresh store remains valid, no caller depends on legacy data.
    console.error("Failed to read legacy hash store for migration:", error);
    return;
  }

  let parsed: { snapshots?: Record<string, unknown> };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch (error) {
    // SAFETY: best-effort legacy migration — parse failures are ignored; corrupted legacy file is skipped and fresh hashing will repopulate, no caller depends on legacy data.
    console.error("Failed to parse legacy hash store, skipping migration:", error);
    return;
  }

  const raw = parsed.snapshots;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

  const rows: [string, string, number, string, number][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isValidSnapshot(value)) continue;
    if (new Set(value.hashes).size !== value.hashes.length) {
      console.warn(
        `Skipped legacy snapshot with duplicate hashes for ${key}; it will be re-hashed on next read.`,
      );
      continue;
    }
    rows.push([
      key,
      contentChecksum(value.content),
      splitLines(value.content).length,
      JSON.stringify(value.hashes),
      Date.now(),
    ]);
  }
  if (rows.length > 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = db.prepare(
        "INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const row of rows) stmt.run(...row);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  try {
    await rename(legacyPath, `${legacyPath}.bak`);
  } catch (error) {
    // SAFETY: best-effort legacy cleanup — rename failure after successful migration is ignored; legacy file remains but next migration will be skipped due to valid snapshot state, no data loss.
    console.error("Failed to rename legacy hash store after migration:", error);
  }
}
