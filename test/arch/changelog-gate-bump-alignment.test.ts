import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The ledger gate's bump-alignment rule, pinned against the defect that motivated it: #166
 * squash-landed as `perf(store): …` while its `## [Unreleased]` entries sat under `### Features`,
 * so the release published feature text under a patch version. `check_bump_alignment` in
 * `scripts/changelog-gate.py` closes that pair — a squash title licenses a release level, and
 * every entry the PR adds must fit inside it.
 *
 * KNOWN GAPS, not pinned because pinning would freeze a defect (the gate is a vendored copy of
 * the scaffold's, so these belong upstream): prose inside a `### Section` is invisible to every
 * rule yet gets promoted into release notes; an unparseable title is silently exempt; and
 * `HIDDEN_TITLE_RE` rejects the canonical `feat(store)!: …`.
 */

const GATE = "scripts/changelog-gate.py";
const WORKFLOW = ".github/workflows/changelog-check.yml";

/** The shape of the #166 ledger: feature-level entries filed under `### Features`. */
const LEDGER = `# Changelog

## [Unreleased]

### Features

* **store:** adopt an unchanged file from its stat identity instead of re-deriving every line. (#166)
* **store:** end a served lease's authority at the seven day TTL. (#166)

### Bug Fixes

* **store:** keep cache-hit reads off the retention sweep. (#166)
`;

/** The same ledger with a breaking entry, stamped in the order `ATTRIBUTION_RE` accepts. */
const BREAKING_LEDGER = `# Changelog

## [Unreleased]

### Bug Fixes

* **store:** drop the v10 schema reader. (#166) (BREAKING CHANGE)
`;

const PATCH_TITLE = "perf(store): cut read/edit retention and identity costs";
const MINOR_TITLE = "feat(store): cut read/edit retention and identity costs";
const HIDDEN_TITLE = "docs(store): clarify the ledger";
const FIX_TITLE = "fix(store): drop the v10 schema reader";

interface GateRun {
  status: number | null;
  output: string;
}

function gate(args: string[]): GateRun {
  const result = spawnSync("python3", [GATE, ...args], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const hasPython = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

const skipForMissingPython = !hasPython && process.env["CHANGELOG_GATE_ALLOW_SKIP"] === "1";

describe.skipIf(skipForMissingPython)("changelog-gate bump-alignment", () => {
  let dir = "";
  let ledger = "";
  let breakingLedger = "";
  let baseline = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gate-bump-alignment-"));
    ledger = join(dir, "CHANGELOG.md");
    breakingLedger = join(dir, "BREAKING.md");
    baseline = join(dir, "baseline.txt");
    writeFileSync(ledger, LEDGER, "utf8");
    writeFileSync(breakingLedger, BREAKING_LEDGER, "utf8");
    writeFileSync(baseline, "", "utf8");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("can run the gate at all", () => {
    expect(hasPython, "python3 is required; set CHANGELOG_GATE_ALLOW_SKIP=1 to skip instead").toBe(
      true,
    );
  });

  it("blocks a patch title that ships `### Features` entries", () => {
    const { status, output } = gate([
      "ledger",
      "--changelog",
      ledger,
      "--pr",
      "166",
      "--baseline",
      baseline,
      "--squash-title",
      PATCH_TITLE,
    ]);

    expect(status).toBe(1);
    expect(output.match(/\[bump-alignment\]/g)).toHaveLength(2);
    expect(output).not.toContain("keep cache-hit reads off the retention sweep");
    expect(output).toContain("retitle the squash commit to the higher level");
  });

  it("passes once the title is raised to the level its entries license", () => {
    const { status, output } = gate([
      "ledger",
      "--changelog",
      ledger,
      "--pr",
      "166",
      "--baseline",
      baseline,
      "--squash-title",
      MINOR_TITLE,
    ]);

    expect(status).toBe(0);
    expect(output).toContain("ledger: pass");
    expect(output).not.toContain("[bump-alignment]");
  });

  it("blocks a hidden-type title that ships `### Features` entries", () => {
    const { status, output } = gate([
      "ledger",
      "--changelog",
      ledger,
      "--pr",
      "166",
      "--baseline",
      baseline,
      "--squash-title",
      HIDDEN_TITLE,
    ]);

    expect(status).toBe(1);
    expect(output).toContain("licenses no release");
  });

  it("blocks a `(BREAKING CHANGE)` entry under a patch title", () => {
    const { status, output } = gate([
      "ledger",
      "--changelog",
      breakingLedger,
      "--pr",
      "166",
      "--baseline",
      baseline,
      "--squash-title",
      FIX_TITLE,
    ]);

    expect(status).toBe(1);
    expect(output).toContain("requires a major");
  });

  it("leaves alignment unaudited when no title is supplied", () => {
    const { status, output } = gate([
      "ledger",
      "--changelog",
      ledger,
      "--pr",
      "166",
      "--baseline",
      baseline,
    ]);

    expect(status).toBe(0);
    expect(output).not.toContain("[bump-alignment]");
  });
});

describe("changelog-check workflow audits the title it lands", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  it("hands the gate the PR title as the squash subject", () => {
    expect(workflow).toContain('args+=(--squash-title "$PR_TITLE")');
  });

  it("guards the landed subject against a squash-title setting flip", () => {
    expect(workflow).toContain("name: Landed subject is the PR title");
    expect(workflow).toContain('"chore(release): "* | "Merge "*)');
  });

  it("re-runs after an edit, so a finding cannot be dodged by rewording", () => {
    const triggerTypes = /^ {4}types:\s*\[([^\]]*)\]$/m.exec(workflow)?.[1];
    expect(triggerTypes).toBeDefined();
    expect(triggerTypes).toContain("edited");
  });
});
