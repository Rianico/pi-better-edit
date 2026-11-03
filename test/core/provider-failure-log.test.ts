import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readExpansionLogPath,
  recordProviderFailure,
  resetReadExpansionLogStateForTests,
} from "../../src/read-expansion/audit";
import { withTempFile } from "../support/fixtures";

const CEILING = 1024 * 1024;

function rows(): Array<Record<string, unknown>> {
  const path = readExpansionLogPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  rmSync(readExpansionLogPath(), { force: true });
  rmSync(`${readExpansionLogPath()}.1`, { force: true });
  resetReadExpansionLogStateForTests();
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
      const log = readExpansionLogPath();
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
});
