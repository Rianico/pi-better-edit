import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	rmSync,
	symlinkSync,
	existsSync,
	lstatSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureLink = "/tmp/hashline-edge-e";
const fixtureReal = join(root, ".runtime-edge-real");
const isolatedStore = "/tmp/hashline-edge-exdg";
const sessionId = `hashline-runtime-${randomUUID().slice(0, 8)}`;
const continuationSessionDir = "/tmp/hashline-edge-session";
const continuationSessionId = `hashline-cont-${randomUUID().slice(0, 8)}`;
const S6_LINES = ["alpha", "beta", "gamma", "delta", "epsilon"];
const runTimeoutMs = 15 * 60 * 1000;
const EXTENSION_FLAGS = ["-ne", "-e", "npm:pi-fabric", "-e", "./index.ts"];

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

const P1_PROMPT = `Use fabric_exec to test the hashline edit extension (captured as extensions.read; core pi.bash available). Write ONE program.

Harness facts — do NOT probe, use these directly:
(1) the fixture dir /tmp/hashline-edge-e is already reverse-symlinked into the workspace, so extensions may read those paths without approval — use absolute /tmp/hashline-edge-e paths for every file;
(2) this process is the FIRST of two sequential pi processes sharing one session; the next process continues this session with pi -c;
(3) never call rm.

Task: extensions.read /tmp/hashline-edge-e/s6.txt with NO offset and NO limit. Assert the tool result contains the row for line 1 (the first "3-char-hash│content" row). Do not edit the file and do not call any other tool.

Return { results: [{ scenario: "T6a", pass: true, detail: "read rows served" }], summary: "PASS" }.`;

const P2_PROMPT = `Use fabric_exec to test the hashline edit extension (captured as extensions.edit; core pi.bash available). Write ONE program. This process CONTINUES a session started by a previous pi process with pi -c, so the session's served state already holds the read rows from that previous process.

Harness facts — do NOT probe, use these directly:
(1) rejections THROW — wrap each extension call in try/catch and treat the thrown error.message as the rejection text;
(2) do NOT call extensions.read — the anchors below were served to this session by the previous process and must verify against the persisted served state;
(3) the fixture dir /tmp/hashline-edge-e is reverse-symlinked into the workspace — use absolute /tmp/hashline-edge-e paths for every file;
(4) never call rm.

The rows read by the previous process:
P1_READ_START
P1_READ_BLOCK
P1_READ_END

Task: WITHOUT reading the file, make two single-line edits to /tmp/hashline-edge-e/s6.txt with extensions.edit:
step 1: change line 2 "beta" to "BETA" — remove_from = remove_to = "P1_ANCHOR_LINE2";
step 2: change line 4 "delta" to "DELTA" — remove_from = remove_to = "P1_ANCHOR_LINE4".
Both edits must succeed; a rejection must NOT carry [E_RANGE_UNVERIFIED].

Return { results: [{ scenario: "T6", pass, detail }], summary: "PASS" | "FAIL" }. In detail, quote any rejection message verbatim.`;

function removeIfExists(path) {
	if (existsSync(path) || lstatSync(path, { throwIfNoEntry: false })) {
		rmSync(path, { recursive: true, force: true });
	}
}

function setup() {
	removeIfExists(fixtureLink);
	rmSync(fixtureReal, { recursive: true, force: true });
	rmSync(isolatedStore, { recursive: true, force: true });
	rmSync(continuationSessionDir, { recursive: true, force: true });
	mkdirSync(fixtureReal, { recursive: true });
	symlinkSync(fixtureReal, fixtureLink, "dir");
}

function cleanup() {
	try {
		removeIfExists(fixtureLink);
		rmSync(fixtureReal, { recursive: true, force: true });
		rmSync(isolatedStore, { recursive: true, force: true });
		rmSync(continuationSessionDir, { recursive: true, force: true });
	} catch (error) {
		void error;
	}
}

function runPi(extraArgs, prompt) {
	const res = spawnSync("pi", ["-p", ...extraArgs, prompt], {
		cwd: root,
		env: { ...process.env, XDG_CONFIG_HOME: isolatedStore },
		encoding: "utf-8",
		timeout: runTimeoutMs,
		maxBuffer: 8 * 1024 * 1024,
	});
	return {
		output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
		timedOut: res.error?.code === "ETIMEDOUT",
	};
}

function readServedHashes() {
	const storePath = join(isolatedStore, "pi-better-edit", "hash-store.sqlite");
	if (!existsSync(storePath)) return null;
	const db = new DatabaseSync(storePath, { timeout: 2000 });
	try {
		const served = db
			.prepare("SELECT path, hashes FROM served WHERE session_id = ?")
			.all(continuationSessionId);
		const row = served.find((entry) => entry.path.endsWith("s6.txt"));
		if (!row) return null;
		const parsed = JSON.parse(row.hashes);
		if (!Array.isArray(parsed) || parsed.length < 4) return null;
		if (typeof parsed[1] !== "string" || typeof parsed[3] !== "string")
			return null;
		return parsed;
	} finally {
		db.close();
	}
}

function verdictFrom(output) {
	const report = output.match(/summary["']?\s*:\s*["']?(PASS|FAIL)/i);
	const summary = report ? report[1].toUpperCase() : null;
	const codes = {
		stale: output.includes("[E_RANGE_STALE]"),
		unserved: output.includes("[E_RANGE_UNSERVED]"),
		drift: output.includes("Drift notice"),
	};
	const pass =
		summary === "PASS" && codes.stale && codes.unserved && codes.drift;
	return { summary, codes, pass };
}

function continuityVerdictFrom(rows, output, fixtureContent) {
	const report = output.match(/summary["']?\s*:\s*["']?(PASS|FAIL)/i);
	const summary = report ? report[1].toUpperCase() : null;
	const unverified = /\[E_RANGE_UNVERIFIED\]\s/.test(output);
	const lines = fixtureContent.split("\n");
	const fileOk = lines[1] === "BETA" && lines[3] === "DELTA";
	const pass = rows !== null && summary === "PASS" && fileOk && !unverified;
	return { pass, summary, unverified, fileOk };
}

setup();
const main = runPi([...EXTENSION_FLAGS, "--session-id", sessionId], PROMPT);
writeFileSync(
	join(fixtureReal, "s6.txt"),
	"alpha\nbeta\ngamma\ndelta\nepsilon\n",
	"utf-8",
);
const cont1 = runPi(
	[
		...EXTENSION_FLAGS,
		"--session-dir",
		continuationSessionDir,
		"--session-id",
		continuationSessionId,
	],
	P1_PROMPT,
);
const servedHashes = readServedHashes();
let cont2 = null;
if (servedHashes) {
	const readRows = servedHashes
		.map((hash, index) => `${hash}│${S6_LINES[index] ?? ""}`)
		.join("\n");
	const p2Prompt = P2_PROMPT.replace("P1_READ_BLOCK", readRows)
		.replace("P1_ANCHOR_LINE2", servedHashes[1])
		.replace("P1_ANCHOR_LINE4", servedHashes[3]);
	cont2 = runPi(
		[...EXTENSION_FLAGS, "-c", "--session-dir", continuationSessionDir],
		p2Prompt,
	);
}
let fixtureAfter = "";
if (cont2) {
	try {
		fixtureAfter = readFileSync(join(fixtureReal, "s6.txt"), "utf-8");
	} catch {
		fixtureAfter = "";
	}
}
cleanup();

const { summary, codes, pass } = verdictFrom(main.output);
const contVerdict = continuityVerdictFrom(
	servedHashes,
	cont2 ? cont2.output : "",
	fixtureAfter,
);

console.log("=== runtime edge-suite (pi -e npm:pi-fabric, one session) ===");
console.log(main.output.trim() || "(no output)");
console.log("--- verdict ---");
console.log(`fabric report summary: ${summary ?? "NOT FOUND"}`);
console.log(
	`codes seen: E_RANGE_STALE=${codes.stale} E_RANGE_UNSERVED=${codes.unserved} "Drift notice"=${codes.drift}`,
);

console.log(
	"=== pi -c continuity (two sequential pi -p processes, shared isolated store + session dir) ===",
);
console.log("--- process 1 (read) ---");
console.log(cont1.output.trim() || "(no output)");
console.log(
	`process-1 served hashes found in shared store: ${servedHashes ? servedHashes.length : 0}`,
);
if (cont2) {
	console.log("--- process 2 (pi -c) ---");
	console.log(cont2.output.trim() || "(no output)");
}
console.log("--- continuity verdict ---");
console.log(
	`process-1 served hashes found in shared store: ${servedHashes ? servedHashes.length : 0}`,
);
console.log(
	`process-2 fabric report summary: ${contVerdict.summary ?? "NOT FOUND"}`,
);
console.log(`process-2 saw E_RANGE_UNVERIFIED: ${contVerdict.unverified}`);
console.log(
	`process-2 edited fixture to BETA/DELTA on disk: ${contVerdict.fileOk}`,
);

const timedOut =
	main.timedOut || cont1.timedOut || (cont2 ? cont2.timedOut : false);
if (timedOut) {
	console.log("RESULT: TIMED OUT (infrastructure)");
	process.exitCode = 1;
} else if (pass && contVerdict.pass) {
	console.log("RESULT: PASS");
	process.exitCode = 0;
} else {
	console.log("RESULT: FAIL");
	process.exitCode = 1;
}
