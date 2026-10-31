/**
 * #197 — the janitor's user-visible warning: what a `JanitorOutcome` turns into, and when it turns
 * into nothing.
 *
 * WHY this file exists: a maintenance run that removes rows or rebuilds a store is only useful if the
 * operator learns about it, and a run that removed nothing must stay silent — a warning on every
 * session_start would be noise. The formatter is therefore asserted as a TRIGGER first (off,
 * throttled and empty outcomes are `null`) and only then as prose, so the two halves cannot drift.
 * Prose is pinned by exact string on the ordinary path: the counts, the humanized bytes and the
 * why-clause are the contract #198 renders, not incidental wording.
 */
import { describe, expect, it } from "vitest";

import { formatJanitorWarning, JANITOR_WARNING_PREFIX } from "../../src/store-janitor-warning";
import type { JanitorOutcome } from "../../src/store-janitor";
import { diagnosticsLogPath } from "../../src/diagnostics";

const WHY = "keeps the local undo/history store small and fast";

/** One VACUUM outcome; `freeBytesBefore` is unused by the formatter, so it mirrors the reclaim. */
function compaction(reclaimedBytes: number): JanitorOutcome["compacted"] {
  return reclaimedBytes > 0
    ? { ran: true, freeBytesBefore: reclaimedBytes, reclaimedBytes }
    : { ran: true, freeBytesBefore: 4096, reclaimedBytes: 0 };
}

/**
 * A compaction that did not run, for the two reasons the warning escalates (#199): `busy` is a
 * routine deferral and stays info, `failed` is a degraded store path and becomes a warning.
 */
function compactionDeferred(
  reason: "busy" | "failed",
  error?: string,
): JanitorOutcome["compacted"] {
  return {
    ran: false,
    reason,
    freeBytesBefore: 8192,
    reclaimedBytes: 0,
    ...(error === undefined ? {} : { error }),
  };
}

/** An ordinary run the caller varies: every family zero, no compaction, a healthy store. */
function run(
  parts: {
    deleted?: Partial<JanitorOutcome["deleted"]>;
    compacted?: JanitorOutcome["compacted"];
    deepCheckFailed?: boolean;
    rebuilt?: boolean;
  } = {},
): JanitorOutcome {
  return {
    ran: true,
    deleted: { snapshots: 0, lineage: 0, leases: 0, expiredLeases: 0, ...parts.deleted },
    compacted: parts.compacted ?? {
      ran: false,
      reason: "skipped",
      freeBytesBefore: 0,
      reclaimedBytes: 0,
    },
    deepCheckFailed: parts.deepCheckFailed ?? false,
    rebuilt: parts.rebuilt ?? false,
  };
}

describe("the janitor warning's trigger", () => {
  it("stays silent when the mode or the throttle skipped the run", () => {
    expect(formatJanitorWarning({ ...run(), ran: false, reason: "off" })).toBeNull();
    expect(formatJanitorWarning({ ...run(), ran: false, reason: "throttled" })).toBeNull();
  });

  it("stays silent when the run removed nothing, compacted nothing and found the store healthy", () => {
    expect(formatJanitorWarning(run())).toBeNull();
  });
});

it("stays silent for a deferral that is neither a busy store nor a failure", () => {
  for (const reason of ["skipped", "in-transaction", "no-free-pages", "below-threshold"] as const) {
    const compacted: JanitorOutcome["compacted"] = {
      ran: false,
      reason,
      freeBytesBefore: 8192,
      reclaimedBytes: 0,
    };
    expect(formatJanitorWarning(run({ compacted }))).toBeNull();
  }
});

describe("the janitor warning's ordinary cleanup sentence", () => {
  it("names the non-zero families, the reclaimed space and the why-clause in ONE info line", () => {
    const warning = formatJanitorWarning(
      run({
        deleted: { expiredLeases: 2, leases: 1, snapshots: 3, lineage: 4 },
        compacted: compaction(1_572_864),
      }),
    );

    expect(warning).toEqual({
      level: "info",
      lines: [
        `${JANITOR_WARNING_PREFIX} Removed 2 expired session leases, 1 stale lease, 3 snapshots ` +
          `and 4 lineage rows, reclaimed 1.5 MB — ${WHY}.`,
      ],
    });
  });

  it("omits zero-count families and a compaction that did not run", () => {
    expect(formatJanitorWarning(run({ deleted: { snapshots: 1 } }))).toEqual({
      level: "info",
      lines: [`${JANITOR_WARNING_PREFIX} Removed 1 snapshot — ${WHY}.`],
    });
  });

  it("reports a compaction on its own when the sweep removed nothing", () => {
    expect(formatJanitorWarning(run({ compacted: compaction(409_600) }))).toEqual({
      level: "info",
      lines: [`${JANITOR_WARNING_PREFIX} Compacted the store and reclaimed 400.0 KB — ${WHY}.`],
    });
  });

  it("says so when a compaction ran but returned no space", () => {
    expect(formatJanitorWarning(run({ compacted: compaction(0) }))).toEqual({
      level: "info",
      lines: [`${JANITOR_WARNING_PREFIX} Compacted the store but reclaimed no space — ${WHY}.`],
    });
  });

  it("reports a busy-store deferral at info level, because the next pass retries it", () => {
    expect(formatJanitorWarning(run({ compacted: compactionDeferred("busy") }))).toEqual({
      level: "info",
      lines: [
        `${JANITOR_WARNING_PREFIX} Compaction deferred: the store was busy — ` +
          `it retries at the next maintenance pass.`,
      ],
    });
  });

  it("joins a deferral onto the cleanup sentence instead of printing a second line", () => {
    expect(
      formatJanitorWarning(
        run({ deleted: { snapshots: 2 }, compacted: compactionDeferred("busy") }),
      ),
    ).toEqual({
      level: "info",
      lines: [
        `${JANITOR_WARNING_PREFIX} Removed 2 snapshots. Compaction deferred: the store was busy — ` +
          `it retries at the next maintenance pass.`,
      ],
    });
  });

  it("joins 'reclaimed no space' onto a removal, so one run stays one sentence", () => {
    expect(
      formatJanitorWarning(
        run({ deleted: { snapshots: 2, lineage: 1 }, compacted: compaction(0) }),
      ),
    ).toEqual({
      level: "info",
      lines: [
        `${JANITOR_WARNING_PREFIX} Removed 2 snapshots and 1 lineage row, reclaimed no space — ` +
          `${WHY}.`,
      ],
    });
  });

  it("humanizes on the 1 MiB boundary: bytes below it are KB, the boundary itself is MB", () => {
    const sentence = (bytes: number): string | undefined =>
      formatJanitorWarning(run({ compacted: compaction(bytes) }))?.lines[0];

    expect(sentence(1024)).toBe(
      `${JANITOR_WARNING_PREFIX} Compacted the store and reclaimed 1.0 KB — ${WHY}.`,
    );
    expect(sentence(1024 * 1024 - 1)).toBe(
      `${JANITOR_WARNING_PREFIX} Compacted the store and reclaimed 1024.0 KB — ${WHY}.`,
    );
    expect(sentence(1024 * 1024)).toBe(
      `${JANITOR_WARNING_PREFIX} Compacted the store and reclaimed 1.0 MB — ${WHY}.`,
    );
  });
});

describe("the janitor warning's damaged-store shape", () => {
  it("warns that a rebuilt store left user files untouched and points at the log", () => {
    const warning = formatJanitorWarning(
      run({ deleted: { snapshots: 2 }, deepCheckFailed: true, rebuilt: true }),
      { logPath: "/state/diagnostics.log" },
    );

    expect(warning?.level).toBe("warn");
    expect(warning?.lines).toHaveLength(3);
    expect(warning?.lines[0]).toBe(
      `${JANITOR_WARNING_PREFIX} The local undo/history store was damaged and has been rebuilt; ` +
        `your files were not touched.`,
    );
    expect(warning?.lines[1]).toContain("may be incomplete");
    expect(warning?.lines[2]).toBe(`${JANITOR_WARNING_PREFIX} Details: /state/diagnostics.log`);
  });

  it("warns about damage it could not rebuild, instead of claiming a rebuild", () => {
    const warning = formatJanitorWarning(run({ deepCheckFailed: true }), {
      logPath: "/state/diagnostics.log",
    });

    expect(warning?.level).toBe("warn");
    expect(warning?.lines.join("\n")).not.toContain("has been rebuilt");
    expect(warning?.lines.join("\n")).toContain("until the store is rebuilt");
    expect(warning?.lines[0]).toContain("your files were not touched");
  });

  it("points at the diagnostics log by default, without the caller passing the path", () => {
    const warning = formatJanitorWarning(run({ rebuilt: true, deepCheckFailed: true }));

    expect(warning?.lines.at(-1)).toBe(
      `${JANITOR_WARNING_PREFIX} Details: ${diagnosticsLogPath()}`,
    );
  });
});

describe("the janitor warning's greppability", () => {
  it("prefixes every emitted line and carries no emoji", () => {
    const ordinary = formatJanitorWarning(
      run({ deleted: { snapshots: 1, lineage: 1 }, compacted: compaction(1_048_576) }),
    );
    const damaged = formatJanitorWarning(run({ deepCheckFailed: true, rebuilt: true }), {
      logPath: "/state/diagnostics.log",
    });
    const lines = [...(ordinary?.lines ?? []), ...(damaged?.lines ?? [])];

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith(JANITOR_WARNING_PREFIX)).toBe(true);
      expect(/\p{Extended_Pictographic}/u.test(line)).toBe(false);
    }
  });

  it("keeps the ordinary cleanup to a single line, so a session shows one sentence", () => {
    const warning = formatJanitorWarning(run({ deleted: { expiredLeases: 1 } }));

    expect(warning?.level).toBe("info");
    expect(warning?.lines).toHaveLength(1);
  });
});

describe("the janitor warning's failed-compaction shape", () => {
  it("warns that the store could not be compacted, says files were untouched, and points at the log", () => {
    const warning = formatJanitorWarning(
      run({ deleted: { snapshots: 2 }, compacted: compactionDeferred("failed", "disk I/O error") }),
      { logPath: "/state/diagnostics.log" },
    );

    expect(warning?.level).toBe("warn");
    expect(warning?.lines).toEqual([
      `${JANITOR_WARNING_PREFIX} The local undo/history store could not be compacted; ` +
        `your files were not touched. The next maintenance pass retries.`,
      `${JANITOR_WARNING_PREFIX} Details: /state/diagnostics.log`,
    ]);
  });

  it("points at the diagnostics log by default, without the caller passing the path", () => {
    const warning = formatJanitorWarning(run({ compacted: compactionDeferred("failed", "boom") }));

    expect(warning?.lines.at(-1)).toBe(
      `${JANITOR_WARNING_PREFIX} Details: ${diagnosticsLogPath()}`,
    );
  });

  it("keeps the damaged-store warning above a failed compaction instead of reporting both", () => {
    const warning = formatJanitorWarning(
      run({
        compacted: compactionDeferred("failed", "boom"),
        deepCheckFailed: true,
        rebuilt: true,
      }),
      { logPath: "/state/diagnostics.log" },
    );

    expect(warning?.lines.join("\n")).toContain("damaged and has been rebuilt");
    expect(warning?.lines.join("\n")).not.toContain("could not be compacted");
  });
});
