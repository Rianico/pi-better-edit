#!/usr/bin/env node
/**
 * CLI for the read-expansion round-trip replay. Reads two pi session corpora and prints the
 * per-language re-read/waste comparison plus the acceptance gate. `--json` is the machine-readable
 * surface a ticket cites; the default is a short human table.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DEFAULT_LIMIT_SESSIONS,
  buildReplayReport,
  formatSummary,
  sessionsRoot,
} from "./lib/read-expansion-replay.mjs";

const USAGE = `Usage: node scripts/read-expansion-replay.mjs [options]

Measure per-language same-file re-read share and served-line waste from pi session JSONL.

Options:
  --baseline <dir>        transcript corpus recorded before the candidate build
                          (default: $PI_CODING_AGENT_DIR/sessions or ~/.pi/agent/sessions)
  --candidate <dir>       transcript corpus recorded with the candidate build
                          (default: --baseline when given, else the same default root)
  --limit-sessions <n>    newest session files per corpus (default: ${DEFAULT_LIMIT_SESSIONS})
  --language <name>       limit metrics/gate to one language; repeat or comma-separate
  --json                  print the machine-readable report only
  --out <path>            also write the machine-readable report to a file
  --fail-on-reject        exit 1 when a language does not pass the gate
  --help                  show this help

Gate: a language is accepted only when its same-file re-read share falls by at least 20% on at
least 200 served-mode reads and served-line waste does not rise. Below 200 reads the verdict is
"insufficient-sample" and the waste metric alone decides.`;

function fail(message) {
  console.error(`read-expansion-replay: ${message}`);
  process.exit(2);
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        baseline: { type: "string" },
        candidate: { type: "string" },
        "limit-sessions": { type: "string" },
        language: { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        out: { type: "string" },
        "fail-on-reject": { type: "boolean", default: false },
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

  const defaultRoot = sessionsRoot();
  const baselineRoot = values.baseline ?? defaultRoot;
  const candidateRoot = values.candidate ?? values.baseline ?? defaultRoot;
  const languages = values.language
    ?.flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");

  let report;
  try {
    report = buildReplayReport({
      baselineRoot,
      candidateRoot,
      limitSessions,
      ...(languages === undefined || languages.length === 0 ? {} : { languages }),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const machine = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out !== undefined) writeFileSync(values.out, machine, "utf-8");
  if (values.json) process.stdout.write(machine);
  else console.log(formatSummary(report));

  if (
    values["fail-on-reject"] &&
    Object.values(report.gate.languages).some((entry) => entry.accepted !== true)
  ) {
    process.exit(1);
  }
}

main();
