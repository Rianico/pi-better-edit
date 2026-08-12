import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	rmSync,
	symlinkSync,
	existsSync,
	lstatSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureLink = "/tmp/hashline-edge-e";
const fixtureReal = join(root, ".runtime-edge-real");
const isolatedStore = "/tmp/hashline-edge-exdg";
const sessionId = `hashline-runtime-${randomUUID().slice(0, 8)}`;
const runTimeoutMs = 15 * 60 * 1000;

const PROMPT = `Use fabric_exec to test the hashline edit extension (captured as extensions.read / extensions.edit / extensions.undo_last_edit; core pi.write / pi.bash available). Write ONE program; served state persists across calls within one program.

Harness facts — do NOT probe, use these directly:
(1) rejections THROW — wrap each extension call in try/catch and treat the thrown error.message as the rejection text;
(2) pi.write auto-serves the whole file, so create test fixtures with pi.bash printf instead (a write-created fixture can never have a never-served interior);
(3) the fixture dir /tmp/hashline-edge-e is already reverse-symlinked into the workspace, so extensions may read/edit those paths without approval — use absolute /tmp/hashline-edge-e paths for every file;
(4) an edit result's details.diff carries the diff rows with anchors;
(5) never call rm.

Scenarios:
T1 stale-interior reject-and-serve: fixture /tmp/hashline-edge-e/s1.txt = alpha/beta/gamma/delta/epsilon (bash printf). extensions.read it. bash sed line 3 'gamma'->'GAMMA'. extensions.edit span lines 2..4 (anchors from the read, replacement "beta\\nGAMMA-EDIT\\ndelta") -> catch, assert message contains "[E_RANGE_STALE]". Then retry with the echoed anchors from the rejection (the hash before "|" on the first and last echoed row), same replacement -> assert success and the file contains "GAMMA-EDIT".
T2 chained edit without re-read: fixture /tmp/hashline-edge-e/s2.txt = one/two/three. extensions.read it. extensions.edit line 1 'one'->'ONE' (remove_from = remove_to = line 1's anchor) -> success. WITHOUT calling extensions.read, extensions.edit line 2 'two'->'TWO' using the line-2 anchor from edit1's details.diff -> assert the file is ONE/TWO/three.
T3 undo: extensions.undo_last_edit on s2 -> assert the file is ONE/two/three (only the most recent edit reverted).
T4 never-served interior: fixture /tmp/hashline-edge-e/s4.txt = foo/bar/baz/qux. extensions.read with offset 1 limit 1, then offset 4 limit 1. Then WITHOUT more reads, extensions.edit spanning lines 1..4 (anchors from those reads, replacement "foo\\nBAR\\nBAZ\\nqux") -> catch, assert message contains "[E_RANGE_UNSERVED]" and the file on disk is unchanged.
T5 drift notice: fixture /tmp/hashline-edge-e/s5.txt = aa/bb/cc/dd/ee. extensions.read it. bash sed line 5 'ee'->'EE'. extensions.edit line 1 'aa'->'AA' (remove_from = remove_to = line 1's anchor) -> assert success and the message contains "Drift notice".

Catch every extension error and record the exact message. Return { results: [{ scenario, pass, detail }], summary: "PASS" | "FAIL" }. Quote the exact T1 and T4 rejection texts in the report.`;

function removeIfExists(path) {
	if (existsSync(path) || lstatSync(path, { throwIfNoEntry: false })) {
		rmSync(path, { recursive: true, force: true });
	}
}

function setup() {
	removeIfExists(fixtureLink);
	rmSync(fixtureReal, { recursive: true, force: true });
	rmSync(isolatedStore, { recursive: true, force: true });
	mkdirSync(fixtureReal, { recursive: true });
	symlinkSync(fixtureReal, fixtureLink, "dir");
}

function cleanup() {
	try {
		removeIfExists(fixtureLink);
		rmSync(fixtureReal, { recursive: true, force: true });
		rmSync(isolatedStore, { recursive: true, force: true });
	} catch (error) {
		void error;
	}
}

function verdictFrom(output) {
	const report = output.match(/summary:\s*(PASS|FAIL)/i);
	const summary = report ? report[1].toUpperCase() : null;
	const codes = {
		stale: output.includes("[E_RANGE_STALE]"),
		unserved: output.includes("[E_RANGE_UNSERVED]"),
		drift: output.includes("Drift notice"),
	};
	const pass = summary === "PASS" && codes.stale && codes.unserved && codes.drift;
	return { summary, codes, pass };
}

setup();
let output = "";
let timedOut = false;
try {
	const res = spawnSync(
		"pi",
		["-p", "-e", "npm:pi-fabric", "--session-id", sessionId, PROMPT],
		{
			cwd: root,
			env: { ...process.env, XDG_CONFIG_HOME: isolatedStore },
			encoding: "utf-8",
			timeout: runTimeoutMs,
			maxBuffer: 8 * 1024 * 1024,
		},
	);
	output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
	timedOut = res.error?.code === "ETIMEDOUT";
} finally {
	cleanup();
}

console.log("=== runtime edge-suite (pi -e npm:pi-fabric, one session) ===");
console.log(output.trim() || "(no output)");
const { summary, codes, pass } = verdictFrom(output);
console.log("--- verdict ---");
console.log(`fabric report summary: ${summary ?? "NOT FOUND"}`);
console.log(
	`codes seen: E_RANGE_STALE=${codes.stale} E_RANGE_UNSERVED=${codes.unserved} "Drift notice"=${codes.drift}`,
);
if (timedOut) {
	console.log("RESULT: TIMED OUT (infrastructure)");
	process.exitCode = 1;
} else if (pass) {
	console.log("RESULT: PASS");
	process.exitCode = 0;
} else {
	console.log("RESULT: FAIL");
	process.exitCode = 1;
}
