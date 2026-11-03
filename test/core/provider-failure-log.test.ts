import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stateRoot } from "../../src/config-dir";
import {
  recordProviderFailure,
  resetSelectionRangeLogStateForTests,
  selectionRangeLogPath,
} from "../../src/read-expansion/audit";
import { withTempFile } from "../support/fixtures";

const CEILING = 1024 * 1024;

/** The pre-rename sink name: what an install that predates the rename still holds on disk. */
function retiredLogPath(): string {
  return join(stateRoot(), "read-expansion.log");
}
function rows(): Array<Record<string, unknown>> {
  const path = selectionRangeLogPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
beforeEach(() => {
  for (const path of [
    selectionRangeLogPath(),
    `${selectionRangeLogPath()}.1`,
    retiredLogPath(),
    `${retiredLogPath()}.1`,
  ]) {
    rmSync(path, { force: true });
  }
  resetSelectionRangeLogStateForTests();
});

describe("provider-failure log", () => {
  it("writes exactly one row naming the file, the source and the reason", async () => {
    await withTempFile("note.md", "x\n", async ({ path }) => {
      recordProviderFailure(
        {
          file: path,
          mode: "served",
          source: "md",
          reason: "provider_error",
          requested: [{ startLine: 1, endLine: 1 }],
        },
        "session-a",
        "project",
      );

      const logged = rows();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        file: path,
        source: "md",
        reason: "provider_error",
        mode: "served",
        rung: "project",
      });
    });
  });

  it("rotates before an oversized append, keeping the live file under the ceiling", async () => {
    await withTempFile("note.ts", "x\n", async ({ path }) => {
      const log = selectionRangeLogPath();
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, "x".repeat(CEILING + 1));

      recordProviderFailure(
        { file: path, mode: "served", source: "ast", reason: "provider_error" },
        "session-b",
        "default",
      );

      expect(existsSync(`${log}.1`)).toBe(true);
      expect(statSync(log).size).toBeLessThanOrEqual(CEILING);
      expect(rows()).toHaveLength(1);
    });
  });

  it("writes the renamed log and never the retired name", async () => {
    await withTempFile("note.md", "x\n", async ({ path }) => {
      recordProviderFailure(
        { file: path, mode: "served", source: "md", reason: "provider_error" },
        "session-rename",
        "default",
      );

      expect(basename(selectionRangeLogPath())).toBe("selection-range.log");
      expect(existsSync(selectionRangeLogPath())).toBe(true);
      expect(existsSync(retiredLogPath())).toBe(false);
      expect(rows()).toHaveLength(1);
    });
  });

  it("adopts a pre-rename log pair so a bug report written before it stays readable", async () => {
    await withTempFile("note.md", "x\n", async ({ path }) => {
      mkdirSync(dirname(retiredLogPath()), { recursive: true });
      writeFileSync(
        retiredLogPath(),
        `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", file: "before.md", source: "md", reason: "provider_error" })}\n`,
      );
      writeFileSync(
        `${retiredLogPath()}.1`,
        `${JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", file: "older.md", source: "md", reason: "provider_error" })}\n`,
      );

      recordProviderFailure(
        { file: path, mode: "served", source: "md", reason: "provider_error" },
        "session-adopt",
        "default",
      );

      const logged = rows();
      expect(logged[0]).toMatchObject({ file: "before.md" });
      expect(logged[1]).toMatchObject({ file: path });
      expect(logged).toHaveLength(2);
      expect(existsSync(retiredLogPath())).toBe(false);
      expect(existsSync(`${retiredLogPath()}.1`)).toBe(false);
      expect(readFileSync(`${selectionRangeLogPath()}.1`, "utf-8")).toContain("older.md");
    });
  });

  it("keeps the new log when both names exist", async () => {
    await withTempFile("note.md", "x\n", async ({ path }) => {
      mkdirSync(dirname(retiredLogPath()), { recursive: true });
      writeFileSync(
        retiredLogPath(),
        `${JSON.stringify({ file: "before.md", source: "md", reason: "provider_error" })}\n`,
      );
      writeFileSync(
        selectionRangeLogPath(),
        `${JSON.stringify({ file: "current.md", source: "md", reason: "provider_error" })}\n`,
      );

      recordProviderFailure(
        { file: path, mode: "served", source: "md", reason: "provider_error" },
        "session-both",
        "default",
      );

      const logged = rows();
      expect(logged[0]).toMatchObject({ file: "current.md" });
      expect(logged[1]).toMatchObject({ file: path });
      expect(logged).toHaveLength(2);
      expect(existsSync(retiredLogPath())).toBe(true);
    });
  });
});
