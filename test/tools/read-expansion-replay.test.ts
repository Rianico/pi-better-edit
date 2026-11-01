import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/read-expansion-replay.mjs";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

interface LanguageMetrics {
  reads: number;
  reReads: number;
  servedLines: number;
  touchedLines: number;
  reReadShare: number | null;
  wasteShare: number | null;
}

interface GateEntry {
  sampleSize: number;
  verdict: "accept" | "reject" | "insufficient-sample";
  decision: string;
  accepted: boolean;
  relativeFall: number | null;
  wasteVerdict: "pass" | "fail" | "unknown";
  baselineWasteShare: number | null;
  candidateWasteShare: number | null;
  reason: string;
}

interface ReplayReport {
  schemaVersion: number;
  baseline: { byLanguage: Record<string, LanguageMetrics> };
  candidate: { byLanguage: Record<string, LanguageMetrics> };
  gate: {
    minSampleSize: number;
    relativeFallThreshold: number;
    languages: Record<string, GateEntry>;
    accepted: string[];
    rejected: string[];
    insufficientSample: string[];
  };
}

function anchorAt(value: number): string {
  let rest = value;
  let text = "";
  for (let index = 0; index < 4; index++) {
    text = ALPHABET[rest % ALPHABET.length]! + text;
    rest = Math.floor(rest / ALPHABET.length);
  }
  return text;
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
  };
}

function toolResult(id: string, name: string, text: string) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      isError: false,
      content: [{ type: "text", text }],
    },
  };
}

/**
 * One synthetic session in pi's real JSONL shape. Each read result serves two anchored lines;
 * `editAll` appends one edit per file that touches both anchors, so its served lines are not waste.
 */
function sessionLines(extension: string, pairs: number, standalone: number, editAll: boolean) {
  const lines: unknown[] = [
    {
      type: "session",
      version: 3,
      id: `session-${extension}-${pairs}-${standalone}`,
      timestamp: "2026-10-31T00:00:00.000Z",
      cwd: "/repo",
    },
  ];
  let anchors = 0;
  let calls = 0;
  const files: Array<{ file: string; anchors: [string, string] }> = [];

  const emitRead = (file: string, pair: [string, string]) => {
    const id = `call-${calls++}`;
    lines.push(
      toolCall(id, "read", { file, windows: [{ offset: 1, limit: 2 }] }),
      toolResult(
        id,
        "read",
        `[${file} (lines 1-2 of 2 total)]\n${pair[0]}│line 1\n${pair[1]}│line 2`,
      ),
    );
  };

  const makeFile = (name: string) => {
    const file = `/repo/src/${name}.${extension}`;
    const pair: [string, string] = [anchorAt(anchors++), anchorAt(anchors++)];
    files.push({ file, anchors: pair });
    return { file, pair };
  };

  for (let index = 0; index < pairs; index++) {
    const { file, pair } = makeFile(`pair-${index}`);
    emitRead(file, pair);
    emitRead(file, pair);
  }
  for (let index = 0; index < standalone; index++) {
    const { file, pair } = makeFile(`solo-${index}`);
    emitRead(file, pair);
  }
  if (editAll) {
    for (const { file, anchors: pair } of files) {
      const id = `edit-${calls++}`;
      lines.push(
        toolCall(id, "edit", {
          file,
          edits: [{ anchor_from: pair[0], anchor_to: pair[1], text: "" }],
        }),
        toolResult(id, "edit", "ok"),
      );
    }
  }
  return lines;
}

async function writeSession(root: string, name: string, lines: unknown[]) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, name),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf-8",
  );
}

async function makeCorpus(
  root: string,
  spec: {
    typescript: [pairs: number, standalone: number, editAll: boolean];
    python: [pairs: number, standalone: number, editAll: boolean];
    markdown: [pairs: number, standalone: number, editAll: boolean];
  },
) {
  await writeSession(root, "typescript.jsonl", sessionLines("ts", ...spec.typescript));
  await writeSession(root, "python.jsonl", sessionLines("py", ...spec.python));
  await writeSession(root, "markdown.jsonl", sessionLines("md", ...spec.markdown));
}

function runReplay(baseline: string, candidate: string, language?: string): ReplayReport {
  const output = execFileSync(
    process.execPath,
    [
      SCRIPT,
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--limit-sessions",
      "10",
      "--json",
      ...(language === undefined ? [] : ["--language", language]),
    ],
    { encoding: "utf-8", cwd: process.cwd() },
  );
  return JSON.parse(output) as ReplayReport;
}

describe("read-expansion replay", () => {
  it("reports per-language re-read shares, waste, and the D24 gate verdicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-expansion-replay-"));
    const baseline = join(root, "baseline");
    const candidate = join(root, "candidate");
    try {
      await makeCorpus(baseline, {
        typescript: [100, 0, true],
        python: [100, 0, true],
        markdown: [100, 0, false],
      });
      await makeCorpus(candidate, {
        typescript: [60, 80, true],
        python: [60, 80, false],
        markdown: [75, 0, false],
      });

      const report = runReplay(baseline, candidate);

      expect(report.schemaVersion).toBe(1);
      expect(report.gate.minSampleSize).toBe(200);
      expect(report.gate.relativeFallThreshold).toBe(0.2);
      expect(report.baseline.byLanguage.typescript?.reads).toBe(200);
      expect(report.candidate.byLanguage.typescript?.reads).toBe(200);
      expect(report.baseline.byLanguage.typescript?.reReadShare).toBeCloseTo(0.5, 8);
      expect(report.candidate.byLanguage.typescript?.reReadShare).toBeCloseTo(0.3, 8);
      expect(report.baseline.byLanguage.typescript?.wasteShare).toBeCloseTo(0, 8);
      expect(report.candidate.byLanguage.typescript?.wasteShare).toBeCloseTo(0, 8);

      const typescript = report.gate.languages.typescript;
      expect(typescript).toMatchObject({
        sampleSize: 200,
        verdict: "accept",
        decision: "accept",
        accepted: true,
        wasteVerdict: "pass",
      });
      expect(typescript?.relativeFall).toBeCloseTo(0.4, 8);

      const python = report.gate.languages.python;
      expect(python).toMatchObject({
        sampleSize: 200,
        verdict: "reject",
        accepted: false,
        wasteVerdict: "fail",
      });
      expect(python?.reason).toContain("waste rose");
      expect(report.baseline.byLanguage.python?.wasteShare).toBeCloseTo(0, 8);
      expect(report.candidate.byLanguage.python?.wasteShare).toBeCloseTo(1, 8);

      const markdown = report.gate.languages.markdown;
      expect(markdown).toMatchObject({
        sampleSize: 150,
        verdict: "insufficient-sample",
        decision: "accept-on-waste",
        accepted: true,
        wasteVerdict: "pass",
      });

      expect(report.gate.accepted).toEqual(["typescript"]);
      expect(report.gate.rejected).toEqual(["python"]);
      expect(report.gate.insufficientSample).toEqual(["markdown"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an explicitly selected zero-read language as insufficient sample", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-expansion-replay-zero-"));
    try {
      await writeSession(root, "typescript.jsonl", sessionLines("ts", 1, 0, true));

      const report = runReplay(root, root, "go");

      expect(report.gate.languages.go).toMatchObject({
        sampleSize: 0,
        verdict: "insufficient-sample",
        decision: "reject-on-waste",
        accepted: false,
        wasteVerdict: "unknown",
      });
      expect(report.gate.insufficientSample).toEqual(["go"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
