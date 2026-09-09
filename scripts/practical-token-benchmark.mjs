import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const model = "opencode-go/gpt-5.6-luna";
const thinking = "high";
const engineArg = process.argv.find((arg) => arg.startsWith("--engine="));
const engines = engineArg
	? [engineArg.slice("--engine=".length)]
	: ["local", "omp"];
const keepScratch = process.env.KEEP_PRACTICAL_BENCH === "1";

const initial = `export function buildConfig() {
  const timeoutMs = 1000;
  const retries = 2;
  const cacheTtl = 60;
  const batchSize = 16;
  const maxItems = 100;
  const logLevel = "info";
  const useCache = false;
  const keepAlive = false;
  return { timeoutMs, retries, cacheTtl, batchSize, maxItems, logLevel, useCache, keepAlive };
}
`;
const expected = `export function buildConfig() {
  const timeoutMs = 1500;
  const retries = 5;
  const cacheTtl = 120;
  const batchSize = 32;
  const maxItems = 250;
  const logLevel = "debug";
  const useCache = true;
  const keepAlive = true;
  return { timeoutMs, retries, cacheTtl, batchSize, maxItems, logLevel, useCache, keepAlive };
}
`;
const prompt = (readTool, patchTool) => {
	const application =
		patchTool === "edit"
			? `Call edit once with { "file": "scenario.ts", "edits": [...] }. Use one { anchor_from, anchor_to, replace_with } object for each requested line change.`
			: `Call omp_patch once with one patch document for the requested changes.`;
	return `You are running a practical file-edit benchmark using ${patchTool}.

Work only on scenario.ts and follow this exact sequence:
1. Call ${readTool} to read scenario.ts completely.
2. Call bash exactly once to simulate a concurrent external edit: replace the text const retries = 2; with const retries = 5; in scenario.ts. Do not use bash for any other file mutation.
3. ${application} Apply this requested refactor: timeoutMs=1500, cacheTtl=120, batchSize=32, maxItems=250, logLevel="debug", useCache=true, keepAlive=true. Preserve the externally changed retries=5. Do not insert duplicate declarations.
4. If the operation is rejected because the file changed after the read, use the fresh anchors or snapshot information returned by the tool and retry the same complete operation. Do not use bash or write to bypass the editing tool.
5. The final file must exactly match this content:
${expected}
6. Stop after the requested refactor succeeds.
`;
};

function createFixture() {
	const cwd = mkdtempSync(join(tmpdir(), "practical-hashline-bench-"));
	writeFileSync(join(cwd, "scenario.ts"), initial, "utf8");
	return cwd;
}

function parseRun(log) {
	const events = [];
	for (const line of log.split("\n").filter(Boolean)) {
		try {
			events.push(JSON.parse(line));
		} catch (error) {
			throw new Error(
				`pi emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const assistantEnds = events.filter(
		(event) =>
			event.type === "message_end" && event.message?.role === "assistant",
	);
	const usage = assistantEnds.reduce(
		(total, event) => {
			const value = event.message.usage ?? {};
			for (const key of [
				"input",
				"output",
				"reasoning",
				"cacheRead",
				"cacheWrite",
				"totalTokens",
			]) {
				total[key] += Number(value[key] ?? 0);
			}
			return total;
		},
		{
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		},
	);
	const toolCalls = events.filter(
		(event) => event.type === "tool_execution_start",
	);
	const final = events.findLast((event) => event.type === "agent_end");
	return {
		usage,
		toolCalls: toolCalls.map((event) => event.toolName),
		stopReason: final?.messages?.at(-1)?.usage
			? final.messages.at(-1).stopReason
			: undefined,
	};
}

function runPi({ cwd, extension, tools, promptText, env }) {
	const result = spawnSync(
		"pi",
		[
			"--model",
			model,
			"--thinking",
			thinking,
			"--mode",
			"json",
			"--no-session",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--approve",
			"--tools",
			tools,
			"--extension",
			extension,
			"-p",
			promptText,
		],
		{
			cwd,
			encoding: "utf8",
			maxBuffer: 50 * 1024 * 1024,
			env: {
				...process.env,
				PI_PROVIDER: "opencode-go",
				PI_MODEL: "gpt-5.6-luna",
				PI_REASONING_LEVEL: thinking,
				...env,
			},
		},
	);
	if (result.status !== 0) {
		throw new Error(
			`pi exited with ${result.status}:\n${result.stderr}\n${result.stdout.slice(-4000)}`,
		);
	}
	return { log: result.stdout, metrics: parseRun(result.stdout) };
}

function prepareOmpScratch() {
	const scratch = mkdtempSync(join(tmpdir(), "practical-omp-runtime-"));
	execFileSync(
		"npm",
		[
			"install",
			"--silent",
			"--no-package-lock",
			"@oh-my-pi/hashline@17.3.5",
			"bun",
		],
		{ cwd: scratch, stdio: ["ignore", "inherit", "inherit"] },
	);
	const extension = join(scratch, "omp-extension.ts");
	const worker = join(scratch, "omp-worker.mts");
	copyFileSync(join(root, "benchmarks/practical-omp-extension.ts"), extension);
	copyFileSync(join(root, "benchmarks/practical-omp-worker.mts"), worker);
	return {
		scratch,
		extension,
		worker,
		bun: join(scratch, "node_modules/.bin/bun"),
	};
}

function runEngine(engine) {
	const cwd = createFixture();
	let runtime;
	try {
		if (engine === "local") {
			runtime = {
				extension: join(root, "index.ts"),
				tools: "read,bash,edit",
				env: {},
			};
		} else if (engine === "omp") {
			runtime = prepareOmpScratch();
			runtime.tools = "omp_read,omp_patch,bash";
			runtime.env = {
				OMP_BENCH_WORKER: runtime.worker,
				OMP_BENCH_BUN: runtime.bun,
			};
		} else {
			throw new Error(`unknown engine ${engine}`);
		}
		const readTool = engine === "local" ? "read" : "omp_read";
		const patchTool = engine === "local" ? "edit" : "omp_patch";
		const run = runPi({
			cwd,
			extension: runtime.extension,
			tools: runtime.tools,
			promptText: prompt(readTool, patchTool),
			env: runtime.env,
		});
		const finalContent = readFileSync(join(cwd, "scenario.ts"), "utf8");
		return {
			engine,
			model,
			thinking,
			correct: finalContent === expected,
			finalContent,
			usage: run.metrics.usage,
			toolCalls: run.metrics.toolCalls,
		};
	} finally {
		if (runtime?.scratch && !keepScratch)
			rmSync(runtime.scratch, { recursive: true, force: true });
		if (!keepScratch) rmSync(cwd, { recursive: true, force: true });
	}
}
const results = engines.map(runEngine);
const baselineResult = results.find((result) => result.engine === "omp");
const baselineTokens = baselineResult?.usage.totalTokens ?? 0;
for (const result of results) {
	result.relativeSavedPercent =
		baselineTokens > 0
			? Number(((1 - result.usage.totalTokens / baselineTokens) * 100).toFixed(1))
			: null;
}
console.log(
	JSON.stringify(
		{
			benchmark: "practical-token-correctness",
			model,
			thinking,
			baseline: baselineResult?.engine,
			results,
		},
		null,
		2,
	),
);
