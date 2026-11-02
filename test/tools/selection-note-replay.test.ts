import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/selection-note-replay.mjs";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

interface NoteEvidence {
  fires: number;
  readsWithNote: number;
  fireShare: number | null;
  bySource: Record<string, number>;
  violationCount: number;
  violations: Array<{
    file: string;
    window: { start: number; end: number };
    note: { source: string; label: string; start: number; end: number };
  }>;
}

interface LanguageMetrics {
  reads: number;
  reReads: number;
  reReadShare: number | null;
}

interface CorpusReport {
  sessions: number;
  totals: LanguageMetrics;
  byLanguage: Record<string, LanguageMetrics>;
  notes: NoteEvidence;
}

interface Movement {
  baselineReads: number;
  candidateReads: number;
  baselineShare: number | null;
  candidateShare: number | null;
  delta: number | null;
  noiseBand: number | null;
  withinNoise: boolean | null;
  attribution: "note" | "none" | "mixed" | "unknown";
  verdict: "inside-noise" | "candidate-lower" | "candidate-higher" | "unmeasured";
  reason: string;
}

interface ReplayReport {
  schemaVersion: number;
  baseline: CorpusReport | null;
  candidate: CorpusReport;
  reRead: Movement;
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

function assistantProse(text: string) {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** One served page: the chrome line a read prints, plus its anchored rows. */
function served(file: string, start: number, end: number, total: number, clause = "", rows = 1) {
  const header = `[${file} (lines ${start}-${end} of ${total} total${clause})]`;
  const body = Array.from(
    { length: rows },
    (_, index) => `${anchorAt(index)}│line ${start + index}`,
  ).join("\n");
  return `${header}\n${body}`;
}

interface ReadStep {
  readonly file: string;
  readonly text: string;
}

/** One synthetic session in pi's real JSONL shape: reads in order, plus assistant prose. */
function sessionLines(id: string, steps: ReadStep[], prose: string[] = []): unknown[] {
  const lines: unknown[] = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-11-02T00:00:00.000Z",
      cwd: "/repo",
    },
  ];
  let calls = 0;
  for (const step of steps) {
    const callId = `call-${calls++}`;
    lines.push(
      toolCall(callId, "read", { file: step.file, windows: [{ offset: 1, limit: 2 }] }),
      toolResult(callId, "read", step.text),
    );
  }
  for (const text of prose) lines.push(assistantProse(text));
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

/**
 * `pairs` files read twice in a row (the first read is a same-file re-read) plus `singles` files
 * read once. Every page carries a note whose span covers and exceeds its two-line window, so the
 * fixture also pins the correctness rule on happy data.
 */
function repeatedReads(extension: string, pairs: number, singles: number): unknown[] {
  const steps: ReadStep[] = [];
  const span = `; in function body_${pairs}_${singles}, lines 1-9`;
  for (let index = 0; index < pairs; index++) {
    const file = `/repo/src/pair-${index}.${extension}`;
    const text = served(file, 1, 2, 9, span);
    steps.push({ file, text }, { file, text });
  }
  for (let index = 0; index < singles; index++) {
    const file = `/repo/src/solo-${index}.${extension}`;
    steps.push({ file, text: served(file, 1, 2, 9, span) });
  }
  return sessionLines(`session-${extension}-${pairs}-${singles}`, steps);
}

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function reported(args: string[]): ReplayReport {
  const result = runCli([...args, "--limit-sessions", "10", "--json"]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ReplayReport;
}

describe("selection-range note replay", () => {
  it("counts note fires by source and the per-language re-read share", async () => {
    const root = await mkdtemp(join(tmpdir(), "selection-note-replay-"));
    const baseline = join(root, "baseline");
    const candidate = join(root, "candidate");
    try {
      // Baseline: recorded before the note existed — same file read twice, no clause anywhere.
      await writeSession(
        baseline,
        "typescript.jsonl",
        sessionLines("baseline-ts", [
          { file: "/repo/src/a.ts", text: served("/repo/src/a.ts", 1, 2, 40) },
          { file: "/repo/src/a.ts", text: served("/repo/src/a.ts", 1, 2, 40) },
        ]),
      );
      await writeSession(
        candidate,
        "typescript.jsonl",
        sessionLines("candidate-ts", [
          {
            file: "/repo/src/a.ts",
            text: served("/repo/src/a.ts", 10, 11, 120, "; in function parse_args, lines 5-30"),
          },
          {
            file: "/repo/src/a.ts",
            text: served("/repo/src/a.ts", 10, 11, 120, "; in function parse_args, lines 5-30"),
          },
          {
            file: "/repo/src/b.ts",
            text: served("/repo/src/b.ts", 4, 5, 90, "; in class Engine, lines 1-80"),
          },
        ]),
      );
      await writeSession(
        candidate,
        "markdown.jsonl",
        sessionLines("candidate-md", [
          {
            file: "/repo/README.md",
            text: served("/repo/README.md", 5, 6, 60, '; in section "Install", lines 3-20'),
          },
        ]),
      );
      await writeSession(
        candidate,
        "text.jsonl",
        sessionLines(
          "candidate-txt",
          [
            {
              file: "/repo/notes.txt",
              text: `${served("/repo/notes.txt", 2, 3, 60, "; in paragraph, lines 1-7")}\nabcd│[x.ts (lines 1-2 of 9 total; in function f, lines 1-9)]`,
            },
          ],
          [
            "The note reads `[x.ts (lines 1-2 of 9 total; in function f, lines 1-9)]` in the header.",
          ],
        ),
      );

      const report = reported(["--baseline", baseline, "--candidate", candidate]);

      expect(report.schemaVersion).toBe(2);
      expect(report.candidate.sessions).toBe(3);
      expect(report.candidate.totals.reads).toBe(5);
      expect(report.candidate.totals.reReads).toBe(1);
      expect(report.candidate.totals.reReadShare).toBeCloseTo(0.2, 8);
      expect(report.candidate.byLanguage.typescript?.reads).toBe(3);

      // Only served read headers count: one quoted clause inside an assistant message and one
      // note-shaped content row are both ignored.
      expect(report.candidate.notes.fires).toBe(5);
      expect(report.candidate.notes.readsWithNote).toBe(5);
      expect(report.candidate.notes.fireShare).toBeCloseTo(1, 8);
      expect(report.candidate.notes.bySource).toEqual({ ast: 3, md: 1, text: 1 });
      expect(report.candidate.notes.violationCount).toBe(0);

      expect(report.baseline?.totals.reads).toBe(2);
      expect(report.baseline?.notes.fires).toBe(0);

      expect(report.reRead.baselineShare).toBeCloseTo(0.5, 8);
      expect(report.reRead.candidateShare).toBeCloseTo(0.2, 8);
      expect(report.reRead.delta).toBeCloseTo(-0.3, 8);
      expect(report.reRead.withinNoise).toBe(true);
      expect(report.reRead.verdict).toBe("inside-noise");
      expect(report.reRead.attribution).toBe("note");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a movement beyond the 95% band as a direction", async () => {
    const root = await mkdtemp(join(tmpdir(), "selection-note-replay-moved-"));
    const baseline = join(root, "baseline");
    const candidate = join(root, "candidate");
    try {
      await writeSession(baseline, "typescript.jsonl", repeatedReads("ts", 100, 0));
      await writeSession(candidate, "typescript.jsonl", repeatedReads("ts", 60, 80));

      const report = reported(["--baseline", baseline, "--candidate", candidate]);

      expect(report.baseline?.totals.reads).toBe(200);
      expect(report.candidate.totals.reads).toBe(200);
      expect(report.reRead.baselineShare).toBeCloseTo(0.5, 8);
      expect(report.reRead.candidateShare).toBeCloseTo(0.3, 8);
      expect(report.reRead.delta).toBeCloseTo(-0.2, 8);
      expect(report.reRead.withinNoise).toBe(false);
      expect(report.reRead.verdict).toBe("candidate-lower");
      expect(report.reRead.attribution).toBe("mixed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails on a note that does not name a span strictly larger than its window", async () => {
    const root = await mkdtemp(join(tmpdir(), "selection-note-replay-violation-"));
    try {
      await writeSession(
        root,
        "typescript.jsonl",
        sessionLines("violations", [
          // span equal to the window
          {
            file: "/repo/src/a.ts",
            text: served("/repo/src/a.ts", 5, 6, 40, "; in function a, lines 5-6"),
          },
          // span smaller than the window
          {
            file: "/repo/src/b.ts",
            text: served("/repo/src/b.ts", 5, 9, 40, "; in function b, lines 6-7"),
          },
          // span that does not contain the window
          {
            file: "/repo/src/c.ts",
            text: served("/repo/src/c.ts", 5, 6, 40, "; in function c, lines 8-30"),
          },
          // honest note, must not be counted as a violation
          {
            file: "/repo/src/d.ts",
            text: served("/repo/src/d.ts", 5, 6, 40, "; in function d, lines 1-30"),
          },
        ]),
      );

      const result = runCli(["--candidate", root, "--limit-sessions", "10", "--json"]);

      expect(result.stderr).toContain("violation");
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as ReplayReport;
      expect(report.candidate.notes.violationCount).toBe(3);
      expect(report.candidate.notes.violations.map((entry) => entry.file)).toEqual([
        "/repo/src/a.ts",
        "/repo/src/b.ts",
        "/repo/src/c.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves movement unmeasured when no baseline corpus is named", async () => {
    const root = await mkdtemp(join(tmpdir(), "selection-note-replay-nobaseline-"));
    try {
      await writeSession(root, "typescript.jsonl", repeatedReads("ts", 3, 1));

      const report = reported(["--candidate", root]);

      expect(report.baseline).toBeNull();
      expect(report.reRead.candidateReads).toBe(7);
      expect(report.reRead.baselineReads).toBe(0);
      expect(report.reRead.delta).toBeNull();
      expect(report.reRead.withinNoise).toBeNull();
      expect(report.reRead.attribution).toBe("unknown");
      expect(report.reRead.verdict).toBe("unmeasured");
      expect(report.reRead.reason).toContain("baseline");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to call a corpus compared with itself a measurement", async () => {
    const root = await mkdtemp(join(tmpdir(), "selection-note-replay-same-"));
    try {
      await writeSession(root, "typescript.jsonl", repeatedReads("ts", 3, 1));

      const report = reported(["--baseline", root, "--candidate", root]);

      expect(report.reRead.verdict).toBe("unmeasured");
      expect(report.reRead.reason).toContain("same corpus");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when the corpus is absent, never vacuously", async () => {
    const root = await mkdtemp(join(tmpdir(), "selection-note-replay-absent-"));
    const empty = join(root, "empty");
    try {
      await mkdir(empty, { recursive: true });
      const absent = join(root, "definitely-not-a-corpus");

      const missing = runCli(["--candidate", absent]);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain("candidate corpus not found");
      expect(missing.stderr).toContain(absent);

      const noSessions = runCli(["--candidate", empty]);
      expect(noSessions.status).toBe(2);
      expect(noSessions.stderr).toContain("no .jsonl sessions");
      expect(noSessions.stderr).toContain(empty);

      const namedBaseline = runCli(["--baseline", absent, "--candidate", empty]);
      expect(namedBaseline.status).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
