import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	Filesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@oh-my-pi/hashline";

class BenchFilesystem implements Filesystem {
	constructor(private readonly cwd: string) {}

	readText(path: string): Promise<string> {
		return readFile(resolve(this.cwd, path), "utf8");
	}

	async writeText(path: string, content: string): Promise<{ text: string }> {
		await writeFile(resolve(this.cwd, path), content, "utf8");
		return { text: content };
	}

	canonicalPath(path: string): string {
		return resolve(this.cwd, path);
	}

	async preflightWrite(): Promise<void> {}

	allowTagPathRecovery(): boolean {
		return true;
	}
}

const [, , mode, cwd, payload] = process.argv;
if (mode !== "read" && mode !== "patch") {
	throw new Error(`unsupported worker mode: ${mode}`);
}
if (!cwd || payload === undefined)
	throw new Error("cwd and payload are required");

const statePath = resolve(cwd, ".omp-bench-state.json");
const fs = new BenchFilesystem(cwd);

if (mode === "read") {
	const content = await fs.readText(payload);
	const snapshots = new InMemorySnapshotStore();
	const lineCount = content.split("\n").length;
	const tag = snapshots.record(
		payload,
		content,
		Array.from({ length: lineCount }, (_, i) => i + 1),
	);
	await writeFile(
		statePath,
		JSON.stringify({ path: payload, content, tag }, null, 2),
		"utf8",
	);
	console.log(JSON.stringify({ text: `[${payload}#${tag}]\n${content}` }));
	process.exit(0);
}

let state: { path: string; content: string; tag: string };
try {
	state = JSON.parse(await readFile(statePath, "utf8")) as typeof state;
} catch (error) {
	throw new Error(
		`could not load OMP snapshot state: ${error instanceof Error ? error.message : String(error)}`,
	);
}
const snapshots = new InMemorySnapshotStore();
snapshots.record(
	state.path,
	state.content,
	state.content.split("\n").map((_, i) => i + 1),
);
const patcher = new Patcher({ fs, snapshots });
const result = await patcher.apply(Patch.parse(payload));
const warnings = result.sections.flatMap((section) => section.warnings);
console.log(
	JSON.stringify({
		text: result.sections
			.map(
				(section) =>
					`${section.op} ${section.path}${warnings.length ? `\n${warnings.join("\n")}` : ""}`,
			)
			.join("\n"),
	}),
);
