#!/usr/bin/env node
/**
 * CLI for the selection-range note replay. Reads one or two pi session corpora, counts the notes the
 * served headers carried (by provider source) and the same-file re-read share, then reports the
 * before/after movement with its own noise band. `--json` is the machine-readable surface a ticket
 * cites; the default is a short human table.
 *
 * Exit codes: 2 on an argument or corpus error (an absent corpus never passes), 1 when a served note
 * named an illegal span, 0 otherwise.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DEFAULT_LIMIT_SESSIONS,
  buildReplayReport,
  formatSummary,
  sessionsRoot,
} from "./lib/selection-note-replay.mjs";

const USAGE = `Usage: node scripts/selection-note-replay.mjs [options]

Measure the selection-range note over recorded pi sessions: how often a served read carried a note,
by provider source, and whether the same-file re-read share moved against a pre-change corpus.

Options:
  --candidate <dir>       transcript corpus to measure, normally recorded with the note installed
                          (default: $PI_CODING_AGENT_DIR/sessions or ~/.pi/agent/sessions)
  --baseline <dir>        transcript corpus recorded before the note; omit it and the movement is
                          reported as unmeasured rather than as a zero
  --limit-sessions <n>    newest session files per corpus (default: ${DEFAULT_LIMIT_SESSIONS})
  --json                  print the machine-readable report only
  --out <path>            also write the machine-readable report to a file
  --help                  show this help

Correctness gate: every note's span must contain its served window's first line, must not be the
window itself, and — for the shipped clause — must carry the preposition its containment implies
('in' when it reaches the window's end, 'starts in' otherwise). One violation exits 1.

Noise rule: a movement is reported as inside-noise when it is smaller than 1.96 standard errors of
the two-proportion difference (95%).`;

function fail(message) {
  console.error(`selection-note-replay: ${message}`);
  process.exit(2);
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        candidate: { type: "string" },
        baseline: { type: "string" },
        "limit-sessions": { type: "string" },
        json: { type: "boolean", default: false },
        out: { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const { values } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const limitSessions =
    values["limit-sessions"] === undefined
      ? DEFAULT_LIMIT_SESSIONS
      : Number(values["limit-sessions"]);
  if (!Number.isInteger(limitSessions) || limitSessions < 1) {
    fail(`--limit-sessions must be a positive integer, got ${values["limit-sessions"]}`);
  }

  const candidateRoot = values.candidate ?? sessionsRoot();

  let report;
  try {
    report = buildReplayReport({
      candidateRoot,
      ...(values.baseline === undefined ? {} : { baselineRoot: values.baseline }),
      limitSessions,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const machine = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out !== undefined) writeFileSync(values.out, machine, "utf-8");
  if (values.json) process.stdout.write(machine);
  else console.log(formatSummary(report));

  const violations = report.candidate.notes.violationCount;
  if (violations > 0) {
    console.error(
      `selection-note-replay: ${violations} note violation(s): a note whose window covers its whole ` +
        `file, whose span does not contain the served window's first line or equals the window, or ` +
        `whose preposition is wrong`,
    );
    process.exit(1);
  }
}

main();
