import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The pull-request-free shape floor, pinned against the miss that motivated it.
 *
 * A lane ran `pnpm run verify` green and then failed CI on its first push. The ledger it
 * pushed carried an invented `### Tooling` heading beside a 107-word entry. The word budget
 * fired under `ticket`; the heading did not, because `check_sections` was reachable from
 * `ledger` mode alone — and `ledger` needs `--pr`, which cannot exist before a pull request
 * does. So the one rule that reads a section heading was unreachable in the only window
 * where the mistake is made, and `verify` ran no ledger check at all.
 *
 * These cases pin the closure of both gaps: `ticket` runs the whole floor, `ledger` still
 * reports the same finding exactly once, and `pnpm run verify` runs the floor first, so a
 * malformed ledger fails before lint/format/typecheck/coverage spend their minutes.
 *
 * NOT pinned here, deliberately: the eleven section names themselves. They live in
 * `KNOWN_SECTIONS` in the gate, and a second copy in this file would be a tautology.
 */

const GATE = "scripts/changelog-gate.py";
const PACKAGE = "package.json";

/** A ledger whose only defect is the heading: `### Tooling` is not a conventional-commit type. */
const INVENTED_SECTION = `# Changelog

## [Unreleased]

### Tooling

* **gate:** check section integrity without a pull-request number. (#250)
`;

/** The same entry under a known section: the control that keeps the finding falsifiable. */
const KNOWN_SECTION = `# Changelog

## [Unreleased]

### Build System

* **gate:** check section integrity without a pull-request number. (#250)
`;

interface GateRun {
  status: number | null;
  output: string;
}

function gate(args: string[]): GateRun {
  const result = spawnSync("python3", [GATE, ...args], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const hasPython = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

// Same escape hatch as the sibling gate test: a missing interpreter must not silently turn
// this file into a skip, so it fails unless the operator opts out explicitly.
const skipForMissingPython = !hasPython && process.env["CHANGELOG_GATE_ALLOW_SKIP"] === "1";

describe.skipIf(skipForMissingPython)("changelog-gate ticket mode", () => {
  let dir = "";
  let invented = "";
  let known = "";
  let baseline = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gate-ticket-floor-"));
    invented = join(dir, "INVENTED.md");
    known = join(dir, "KNOWN.md");
    baseline = join(dir, "baseline.txt");
    writeFileSync(invented, INVENTED_SECTION, "utf8");
    writeFileSync(known, KNOWN_SECTION, "utf8");
    writeFileSync(baseline, "", "utf8");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports an invented section without a pull-request number", () => {
    const { status, output } = gate(["ticket", "--changelog", invented]);

    expect(status).toBe(1);
    expect(output).toContain("[section-integrity]");
    expect(output).toContain("unknown section '### Tooling'");
  });

  it("passes the same entry filed under a known section", () => {
    const { status, output } = gate(["ticket", "--changelog", known]);

    expect(status).toBe(0);
    expect(output).toContain("ticket: pass");
    expect(output).not.toContain("[section-integrity]");
  });

  it("still reports it once in ledger mode", () => {
    const { status, output } = gate([
      "ledger",
      "--changelog",
      invented,
      "--pr",
      "250",
      "--baseline",
      baseline,
    ]);

    expect(status).toBe(1);
    // Exactly one: the floor is one definition reached by both phases, not two copies that
    // double-report the same heading.
    expect(output.match(/\[section-integrity\]/g)).toHaveLength(1);
    expect(output).toContain("unknown section '### Tooling'");
  });
});

describe("pnpm run verify runs the pull-request-free floor", () => {
  const verify = (JSON.parse(readFileSync(PACKAGE, "utf8")) as { scripts: Record<string, string> })
    .scripts["verify"];

  it("runs `changelog-gate.py ticket`", () => {
    expect(verify).toContain("changelog-gate.py ticket");
  });

  it("runs it before every other step, since it reads one markdown file", () => {
    const floor = verify.indexOf("changelog-gate.py ticket");
    const rest = verify.indexOf("pnpm run lint");

    expect(floor).toBeGreaterThanOrEqual(0);
    expect(rest).toBeGreaterThanOrEqual(0);
    expect(floor).toBeLessThan(rest);
  });

  it("needs no pull-request number", () => {
    expect(verify).not.toContain("--pr");
  });
});
