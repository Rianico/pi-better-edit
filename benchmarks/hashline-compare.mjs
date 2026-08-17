import { execSync } from "node:child_process";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ?? "@oh-my-pi/hashline@latest";
const batterySrc = join(root, "benchmarks/hashline-battery.mts");

const EXPECTED = {
	"H1 valid PUT apply": { outcome: "success" },
	"H2 stale tag + unchanged anchors recovery": {
		outcome: "success",
		preserve: "LINE4",
		warn: "stale file hash",
	},
	"H3 stale tag + changed anchors mismatch": {
		outcome: "rejected",
		code: "MismatchError",
		preserve: "xxx\nyyy\nzzz\n",
	},
	"H4 head/tail insert with drift": {
		outcome: "success",
		preserve: "ZZZ",
		warn: "head/tail",
	},
	"H5 noop PUT": { outcome: "success", equals: "aaa\nbbb\nccc\n" },
	"H6 empty-file insert": { outcome: "success", equals: "first" },
	"H7 unseen-anchor blind edit reject + retry": {
		outcome: "success",
		preserve: "CCC",
	},
	"H8 multi-section all-or-nothing": {
		outcome: "rejected",
		code: "MismatchError",
		preserve: "aaa\nbbb\n",
	},
	"H9 cut/paste register round-trip": {
		outcome: "success",
		equals: "aaa\nccc\nbbb\n",
	},
	"H10 missing snapshot tag rejected": {
		outcome: "rejected",
		preserve: "aaa\nbbb\nccc\n",
	},
};

function run(cmd, cwd) {
	try {
		execSync(cmd, { cwd, stdio: ["ignore", "inherit", "inherit"] });
	} catch (error) {
		console.error(`Command failed: ${cmd}`);
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

function parseOut(file) {
	const results = [];
	let agg = null;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.startsWith("EVAL_RESULT ")) {
			try {
				results.push(JSON.parse(line.slice("EVAL_RESULT ".length)));
			} catch {
				console.error(`Malformed EVAL_RESULT line: ${line}`);
				process.exit(1);
			}
		} else if (line.startsWith("EVAL_AGGREGATE ")) {
			try {
				agg = JSON.parse(line.slice("EVAL_AGGREGATE ".length));
			} catch {
				console.error(`Malformed EVAL_AGGREGATE line: ${line}`);
				process.exit(1);
			}
		}
	}
	return { results, agg };
}

function verdict(actual, expected) {
	if (expected.outcome !== actual.outcome) return "WRONG";
	if (expected.outcome === "rejected" && !actual.code) return "WRONG";
	if (expected.code !== undefined && expected.code !== actual.code)
		return "WRONG";
	if (expected.preserve !== undefined) {
		if (!actual.finalContent.includes(expected.preserve)) return "WRONG";
	}
	if (expected.equals !== undefined) {
		if (actual.finalContent !== expected.equals) return "WRONG";
	}
	if (expected.warn !== undefined) {
		const warnings = Array.isArray(actual.warnings)
			? actual.warnings.join("\n")
			: "";
		if (!warnings.includes(expected.warn)) return "WRONG";
	}
	return "ok";
}

const scratch = mkdtempSync(join(tmpdir(), "hashline-eval-"));
const out = join(scratch, "out.json");
let correct = 0;
try {
	writeFileSync(
		join(scratch, "package.json"),
		JSON.stringify({ name: "hashline-eval-target", private: true }),
	);
	console.log(`Installing ${target} + bun runtime into scratch ...`);
	run(`npm install --silent --no-package-lock ${target} bun`, scratch);
	cpSync(batterySrc, join(scratch, "battery.mts"));
	run(`${join(scratch, "node_modules/.bin/bun")} battery.mts > ${out}`, scratch);
	const { results, agg } = parseOut(out);

	console.log("\n=== @oh-my-pi/hashline library battery ===");
	const scenarioNames = results.map((r) => r.scenario);
	for (const name of scenarioNames) {
		const actual = results.find((r) => r.scenario === name);
		const expected = EXPECTED[name];
		const v = expected ? verdict(actual, expected) : "?";
		if (v === "ok") correct += 1;
		const warnTag =
			actual.warnings && actual.warnings.length > 0
				? ` [warn: ${actual.warnings[0].slice(0, 60)}...]`
				: "";
		console.log(
			`${name.padEnd(48)} ${actual.outcome}${actual.code ? " " + actual.code : ""}${warnTag} ${v === "ok" ? "" : v}`,
		);
	}
	console.log("\n=== aggregate ===");
	console.log(
		`${agg.version} — correct ${correct}/${scenarioNames.length}, success ${agg.byOutcome.success ?? 0}, rejected ${agg.byOutcome.rejected ?? 0}, ops ${agg.totalOps}, chars ${agg.totalChars}`,
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

if (correct !== Object.keys(EXPECTED).length) process.exit(1);
