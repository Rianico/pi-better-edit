import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_LOG_MAX_BYTES,
  DIAGNOSTICS_LOG_NAME,
  diagnosticsLogPath,
  diagnosticsLogStatus,
  reportDiagnostic,
  reportInfo,
  reportWarning,
} from "../../src/diagnostics";
import { hashStorePath } from "../../src/hash-store";
import { clearDiagnostics, readDiagnostics, withTempDir } from "../support/fixtures";

/**
 * The sink's contract has three halves, and each is a way the old `console.error` failed:
 *  1. the record lands in `<configDir>/diagnostics.log`, so it survives the next paint;
 *  2. it is one parseable JSON object per line, so a stack trace stays a stack trace;
 *  3. it never throws, because the caller is already a best-effort hook.
 */
describe("diagnostics sink", () => {
  afterEach(() => {
    clearDiagnostics();
  });

  it("writes an error record with a parseable stack", () => {
    clearDiagnostics();
    reportDiagnostic("bash-view", "Bash view interception failed:", new TypeError("boom"));

    const records = readDiagnostics();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.level).toBe("error");
    expect(record?.scope).toBe("bash-view");
    expect(record?.message).toBe("Bash view interception failed:");
    expect(record?.error?.name).toBe("TypeError");
    expect(record?.error?.message).toBe("boom");
    expect(record?.error?.stack.some((frame) => frame.startsWith("at "))).toBe(true);
    expect(record?.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(record?.ts ?? ""))).toBe(false);
  });

  it("keeps the other argument shapes readable", () => {
    clearDiagnostics();
    reportWarning("store", "quarantined", { reason: "deep check" });
    reportInfo("bash-view", "first interception notice");

    const records = readDiagnostics();
    expect(records.map((record) => record.level)).toEqual(["warn", "info"]);
    expect(records[0]?.message).toContain("quarantined");
    expect(records[0]?.message).toContain("deep check");
    expect(records[0]?.error).toBeUndefined();
  });

  it("names the log beside the store", () => {
    // WHY: the invariant is "same directory as the store", not "same literal string"; the directory
    // WHY: rule itself is covered where the override ladder lives.
    expect(diagnosticsLogPath().endsWith(DIAGNOSTICS_LOG_NAME)).toBe(true);
    expect(dirname(diagnosticsLogPath())).toBe(dirname(hashStorePath()));
  });

  it("rotates one generation when the cap is crossed", async () => {
    clearDiagnostics();
    await rm(`${diagnosticsLogPath()}.1`, { force: true });
    // WHY: a zero-byte record is impossible, so the cap is crossed by a pre-filled log; the incoming
    // WHY: record must then land in a FRESH file, or a single oversized record would never be written.
    await mkdir(dirname(diagnosticsLogPath()), { recursive: true });
    await writeFile(diagnosticsLogPath(), "x".repeat(DIAGNOSTICS_LOG_MAX_BYTES), "utf-8");

    reportDiagnostic("store", "after rotation");

    const previous = await readFile(`${diagnosticsLogPath()}.1`, "utf-8");
    expect(previous).toHaveLength(DIAGNOSTICS_LOG_MAX_BYTES);
    expect(readDiagnostics()).toHaveLength(1);
    await rm(`${diagnosticsLogPath()}.1`, { force: true });
  });

  it("reports status for an absent log without throwing", () => {
    clearDiagnostics();
    const status = diagnosticsLogStatus();
    expect(status.bytes).toBe(0);
    expect(status.modifiedAt).toBeUndefined();
  });

  it("swallows its own I/O failure instead of failing the caller", async () => {
    await withTempDir("diagnostics-unwritable-", async (dir) => {
      const blocker = join(dir, "not-a-directory");
      await writeFile(blocker, "file", "utf-8");
      const previous = process.env["PI_BETTER_EDIT_CONFIG_DIR"];
      process.env["PI_BETTER_EDIT_CONFIG_DIR"] = join(blocker, "nested");
      try {
        // WHY: the caller is a hook that must never turn a lost diagnostic into a failed tool call.
        expect(() => reportDiagnostic("store", "cannot land", new Error("EACCES"))).not.toThrow();
        await expect(stat(join(blocker, "nested"))).rejects.toThrow();
      } finally {
        if (previous === undefined) delete process.env["PI_BETTER_EDIT_CONFIG_DIR"];
        else process.env["PI_BETTER_EDIT_CONFIG_DIR"] = previous;
      }
    });
  });
});
