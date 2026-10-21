/**
 * SAFETY: store-kernel/periodic — the per-open periodic-item gate: ask cheaply, record only on work.
 *
 * WHY: a due check is one indexed single-row read and therefore costs no write and no lock; the record is
 * WHY: written only by a run that actually did its work. TTL policy and the sweeps themselves stay with
 * WHY: their owners (`store-janitor`, the served session); this module owns only the cadence primitive.
 */
import type { DatabaseSync } from "node:sqlite";
import { withBusyRetry } from "./busy.js";

export function due(db: DatabaseSync, key: string, intervalMs: number, now: number): boolean {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    if (row?.value === undefined) return true;
    const lastRun = Number(row.value);
    return !Number.isFinite(lastRun) || now - lastRun >= intervalMs;
  } catch {
    return true;
  }
}

/**
 * Record that a periodic item ran. Written ONLY by a run that did its work: the record is itself a
 * write, so a due-but-idle run must not leave one — it stays due and is asked again next open, which
 * keeps the idle open lock-free and keeps the item's own honesty ("ran" means "did something").
 */
export function markRun(db: DatabaseSync, key: string, now: number): void {
  withBusyRetry(() => {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, String(now));
  });
}
