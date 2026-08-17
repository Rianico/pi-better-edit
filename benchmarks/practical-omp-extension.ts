import { spawnSync } from "node:child_process";
import { Type } from "typebox";

const workerPath = process.env.OMP_BENCH_WORKER;
if (!workerPath) throw new Error("OMP_BENCH_WORKER is required");
const resolvedWorkerPath = workerPath;

function runWorker(mode: "read" | "patch", cwd: string, payload: string) {
	const result = spawnSync(
		process.env.OMP_BENCH_BUN ?? "bun",
		[resolvedWorkerPath, mode, cwd, payload],
		{ cwd, encoding: "utf8" },
	);
	if (result.status !== 0) {
		throw new Error(result.stderr || `omp worker exited with ${result.status}`);
	}
	try {
		return JSON.parse(result.stdout) as {
			text: string;
			path?: string;
			file?: string;
		};
	} catch (error) {
		throw new Error(
			`omp worker returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export default function register(pi: any): void {
	pi.registerTool({
		name: "omp_read",
		label: "OMP Read",
		description:
			"Read a file and return its oh-my-pi hashline snapshot tag and content.",
		parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
		async execute(
			_id: string,
			params: { path: string },
			_signal: unknown,
			_update: unknown,
			ctx: { cwd: string },
		) {
			const result = runWorker("read", ctx.cwd, params.path);
			return { content: [{ type: "text", text: result.text }] };
		},
	});

	pi.registerTool({
		name: "omp_patch",
		label: "OMP Patch",
		description:
			"Apply an oh-my-pi hashline patch atomically after snapshot validation.",
		parameters: Type.Object({ patch: Type.String({ minLength: 1 }) }),
		async execute(
			_id: string,
			params: { patch: string },
			_signal: unknown,
			_update: unknown,
			ctx: { cwd: string },
		) {
			const result = runWorker("patch", ctx.cwd, params.patch);
			return { content: [{ type: "text", text: result.text }] };
		},
	});
}
