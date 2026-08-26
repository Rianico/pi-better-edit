import { DatabaseSync } from "node:sqlite";
import { withBusyRetry as hashWithBusyRetry } from "./hash-store";



export interface SnapshotStore {
  get(path: string, checksum: string, lineCount: number): string[] | undefined;
  put(
    path: string,
    checksum: string,
    lineCount: number,
    hashes: string[],
    updatedAt?: number,
  ): void;
  delete(path: string): void;
  allHashes(): Array<{ path: string; hashes: string }>;
  allPaths(): Array<{ path: string }>;
}


export class SQLiteSnapshotStore implements SnapshotStore {
  constructor(private readonly db: DatabaseSync) {}

  get(path: string, checksum: string, lineCount: number): string[] | undefined {
    const row = this.db
      .prepare(
        "SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?",
      )
      .get(path, checksum, lineCount) as { hashes?: string } | undefined;
    if (!row?.hashes) return undefined;
    try {
      const parsed = JSON.parse(row.hashes) as unknown;
      if (Array.isArray(parsed) && parsed.every((h) => typeof h === "string")) {
        return parsed as string[];
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  put(
    path: string,
    checksum: string,
    lineCount: number,
    hashes: string[],
    updatedAt: number = Date.now(),
  ): void {
    const stmt = this.db.prepare(
      "INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at",
    );
    hashWithBusyRetry(() => stmt.run(path, checksum, lineCount, JSON.stringify(hashes), updatedAt));
  }

  delete(path: string): void {
    const stmt = this.db.prepare("DELETE FROM snapshots WHERE path = ?");
    hashWithBusyRetry(() => stmt.run(path));
  }

  allHashes(): Array<{ path: string; hashes: string }> {
    const rows = this.db.prepare("SELECT path, hashes FROM snapshots").all() as Array<{
      path: string;
      hashes: string;
    }>;
    return rows;
  }

  allPaths(): Array<{ path: string }> {
    const rows = this.db
      .prepare("SELECT path FROM snapshots UNION SELECT path FROM undo UNION SELECT path FROM served")
      .all() as Array<{ path: string }>;
    return rows;
  }
}


type SnapshotRow = {
  checksum: string;
  lineCount: number;
  hashes: string;
  updatedAt: number;
};

export class MemorySnapshotStore implements SnapshotStore {
  private readonly data = new Map<string, SnapshotRow>();
  private readonly extraPaths = new Set<string>();

  get(path: string, checksum: string, lineCount: number): string[] | undefined {
    const row = this.data.get(path);
    if (!row) return undefined;
    if (row.checksum !== checksum || row.lineCount !== lineCount) return undefined;
    try {
      const parsed = JSON.parse(row.hashes) as unknown;
      if (Array.isArray(parsed) && parsed.every((h) => typeof h === "string")) {
        return parsed as string[];
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  put(
    path: string,
    checksum: string,
    lineCount: number,
    hashes: string[],
    updatedAt: number = Date.now(),
  ): void {
    this.data.set(path, {
      checksum,
      lineCount,
      hashes: JSON.stringify(hashes),
      updatedAt,
    });
  }

  delete(path: string): void {
    this.data.delete(path);
  }

  allHashes(): Array<{ path: string; hashes: string }> {
    const out: Array<{ path: string; hashes: string }> = [];
    for (const [path, row] of this.data) {
      out.push({ path, hashes: row.hashes });
    }
    return out;
  }

  allPaths(): Array<{ path: string }> {
    const seen = new Set<string>();
    const out: Array<{ path: string }> = [];
    for (const p of this.data.keys()) {
      seen.add(p);
      out.push({ path: p });
    }
    for (const p of this.extraPaths) {
      if (!seen.has(p)) out.push({ path: p });
    }
    return out;
  }

  __seedPath(path: string): void {
    this.extraPaths.add(path);
  }

  __getRow(path: string): SnapshotRow | undefined {
    return this.data.get(path);
  }

  clear(): void {
    this.data.clear();
    this.extraPaths.clear();
  }
}

