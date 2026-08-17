import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = mkdtempSync(join(tmpdir(), "pi-eval-targets-"));
const defaultTargets = [
	"local",
	"pi-hashline-edit-pro@2.4.1",
	"pi-hashline-edit-pro@2.5.3",
];
const targets =
	process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultTargets;

const EXPECTED = {
	"B1 single-line replace": { outcome: "success" },
	"B2 range replace": { outcome: "success" },
	"B3 interior drift must-not-silently-overwrite": {
		outcome: "rejected",
		preserve: "CCC",
	},
	"B4 out-of-range in-place change": { outcome: "success" },
	"B5 deletion-above-range positional-shift": { outcome: "success" },
	"B6 change-then-revert interior": { outcome: "success" },
	"B7 never-served interior paged-read-gap": {
		outcome: "rejected",
		preserve: "l1",
	},
	"B8 blind-edit no-read never-served-boundary": {
		outcome: "rejected",
		preserve: "aaa\nbbb\nccc\n",
	},
	"B9 boundary-changed stale-anchor": { outcome: "rejected" },
	"B10 duplicate-content drift must-still-reject": {
		outcome: "rejected",
		preserve: "\nb\nd\n",
	},
	"B11 noop replace": { outcome: "success" },
	"B12 noop-with-out-of-range-drift": { outcome: "success" },
	"B13 chained-edit-from-diff-rows-no-reread": { outcome: "success" },
	"B14 empty-file insert": { outcome: "success" },
	"B15 large-range drift capped-feedback": {
		outcome: "rejected",
		preserve: "line 1",
	},
	"B16a undo after replace": { outcome: "success" },
	"B16b undo after external change": { outcome: "rejected" },
	"B17 reversed-range autocorrect": { outcome: "success" },
	"B18 boundary-dup autocorrect": { outcome: "success" },
	"B19 sub-agent-session-does-not-wipe-main": { outcome: "success" },
	"B20 main-and-sub-agent-both-edit": { outcome: "success" },
	"B21 same-session-restart-keeps-served-state": { outcome: "success" },
	"B22 sub-agent-serves-not-visible-to-main": { outcome: "rejected" },
};

function run(cmd, cwd = root) {
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
				console.error(`Malformed EVAL_RESULT line in ${file}: ${line}`);
				process.exit(1);
			}
		} else if (line.startsWith("EVAL_AGGREGATE ")) {
			try {
				agg = JSON.parse(line.slice("EVAL_AGGREGATE ".length));
			} catch {
				console.error(`Malformed EVAL_AGGREGATE line in ${file}: ${line}`);
				process.exit(1);
			}
		}
	}
	return { results, agg };
}

function verdict(actual, expected) {
	if (expected.outcome !== actual.outcome) return "WRONG";
	if (expected.outcome === "rejected" && !actual.code) return "WRONG";
	if (expected.preserve !== undefined) {
		if (!actual.finalContent.includes(expected.preserve)) return "WRONG";
	}
	return "ok";
}

function linkPackage(target) {
	const scratch = join(scratchRoot, target.replace(/[^A-Za-z0-9_.-]/g, "_"));
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(scratch, { recursive: true });
	writeFileSync(
		join(scratch, "package.json"),
		JSON.stringify({ name: "eval-target", private: true }),
	);
	console.log(`Installing ${target} into scratch ...`);
	run(`npm install --silent --no-package-lock ${target}`, scratch);
	const link = join(root, "node_modules/pi-hashline-edit-pro");
	symlinkSync(join(scratch, "node_modules/pi-hashline-edit-pro"), link, "dir");
	return link;
}

const outDir = mkdtempSync(join(tmpdir(), "pi-eval-"));
const collected = {};

for (const target of targets) {
	const isPkg = target !== "local";
	const label = isPkg ? target.replace(/[^A-Za-z0-9_.-]/g, "_") : "local";
	const link = isPkg ? linkPackage(target) : undefined;
	try {
		const out = join(outDir, `${label}.json`);
		run(
			`RUN_EVAL=1 EVAL_TARGET=${isPkg ? "package" : "local"} EVAL_OUT=${out} npx vitest run test/eval/comparison-battery.test.ts`,
		);
		collected[target] = parseOut(out);
	} finally {
		if (link) {
			rmSync(link, { recursive: true, force: true });
		}
	}
}

const names = Object.keys(collected);
const scenarioNames = collected[names[0]].results.map((r) => r.scenario);

console.log("\n=== EVAL comparison (correctness) ===");
console.log(`scenario`.padEnd(48) + names.map((n) => n.padEnd(26)).join(""));
const correct = {};
for (const n of names) correct[n] = 0;
for (const s of scenarioNames) {
	const exp = EXPECTED[s];
	const cells = names.map((n) => {
		const r = collected[n].results.find((x) => x.scenario === s);
		const v = exp ? verdict(r, exp) : "?";
		if (exp && v === "ok") correct[n] += 1;
		const tag = v === "ok" ? `${r.outcome}${r.code ? " " + r.code : ""}` : v;
		return tag.padEnd(26);
	});
	console.log(`${s.slice(0, 46).padEnd(48)}${cells.join("")}`);
}

console.log("\n=== aggregate ===");
for (const n of names) {
	const a = collected[n].agg;
	console.log(
		`${n}: ${a.version} — correct ${correct[n]}/${scenarioNames.length}, success ${a.byOutcome.success ?? 0}, rejected ${a.byOutcome.rejected ?? 0}, calls ${a.totalCalls}, chars ${a.totalChars}`,
	);
}

rmSync(scratchRoot, { recursive: true, force: true });
