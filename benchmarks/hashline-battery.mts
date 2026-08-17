import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	Patcher,
	Patch,
} from "@oh-my-pi/hashline";

interface Result {
	scenario: string;
	outcome: "success" | "rejected";
	code?: string;
	ops: number;
	chars: number;
	finalContent: string;
	warnings: string[];
}

const results: Result[] = [];
const messages: string[] = [];

function emit(result: Result) {
	results.push(result);
	messages.push(
		"EVAL_RESULT " +
			JSON.stringify({
				scenario: result.scenario,
				outcome: result.outcome,
				code: result.code ?? null,
				ops: result.ops,
				chars: result.chars,
				finalContent: result.finalContent,
				warnings: result.warnings,
			}),
	);
}

function makeContext() {
	const fs = new InMemoryFilesystem();
	const snapshots = new InMemorySnapshotStore();
	const patcher = new Patcher({ fs, snapshots });
	return { fs, snapshots, patcher };
}

function codeOf(error: unknown): string | undefined {
	if (error instanceof MismatchError) return "MismatchError";
	return error instanceof Error ? error.constructor.name : undefined;
}

const H1 = await (async (): Promise<Result> => {
	const { fs, snapshots, patcher } = makeContext();
	const before = "aaa\nbbb\nccc\n";
	await fs.writeText("f.ts", before);
	const tag = snapshots.record("f.ts", before, [1, 2, 3]);
	const result = await patcher.apply(
		Patch.parse(`[f.ts#${tag}]\nPUT 2.=2:\n+BBB\n`),
	);
	const finalContent = await fs.readText("f.ts");
	return {
		scenario: "H1 valid PUT apply",
		outcome: "success" as const,
		ops: 2,
		chars: finalContent.length,
		finalContent,
		warnings: result.sections[0]?.warnings ?? [],
	};
})();
emit(H1);

const H2 = await (async (): Promise<Result> => {
	const { fs, snapshots, patcher } = makeContext();
	const before = "aaa\nbbb\nccc\n";
	await fs.writeText("f.ts", before);
	const tag = snapshots.record("f.ts", before, [1, 2, 3]);
	await fs.writeText("f.ts", "aaa\nbbb\nccc\nLINE4\n");
	const result = await patcher.apply(
		Patch.parse(`[f.ts#${tag}]\nPUT 2.=2:\n+BBB\n`),
	);
	const finalContent = await fs.readText("f.ts");
	return {
		scenario: "H2 stale tag + unchanged anchors recovery",
		outcome: "success" as const,
		ops: 3,
		chars: finalContent.length,
		finalContent,
		warnings: result.sections[0]?.warnings ?? [],
	};
})();
emit(H2);

const H3 = await (async (): Promise<Result> => {
	const { fs, snapshots, patcher } = makeContext();
	const before = "aaa\nbbb\nccc\n";
	await fs.writeText("f.ts", before);
	const tag = snapshots.record("f.ts", before, [1, 2, 3]);
	await fs.writeText("f.ts", "xxx\nyyy\nzzz\n");
	let ok = false;
	let error: unknown;
	try {
		await patcher.apply(Patch.parse(`[f.ts#${tag}]\nPUT 2.=2:\n+BBB\n`));
		ok = true;
	} catch (e) {
		error = e;
	}
	const finalContent = await fs.readText("f.ts");
	return {
		scenario: "H3 stale tag + changed anchors mismatch",
		outcome: ok ? "success" : "rejected",
		code: codeOf(error),
		ops: 2,
		chars: ok ? finalContent.length : (error as Error).message.length,
		finalContent,
		warnings: [],
	};
})();
emit(H3);

const H4 = await (async (): Promise<Result> => {
	const { fs, snapshots, patcher } = makeContext();
	const before = "aaa\nbbb\n";
	await fs.writeText("f.ts", before);
	const tag = snapshots.record("f.ts", before, [1, 2]);
	await fs.writeText("f.ts", "aaa\nbbb\nccc\n");
	const result = await patcher.apply(
		Patch.parse(`[f.ts#${tag}]\nPUT >$:\n+ZZZ\n`),
	);
	const finalContent = await fs.readText("f.ts");
	return {
		scenario: "H4 head/tail insert with drift",
		outcome: "success" as const,
		ops: 3,
		chars: finalContent.length,
		finalContent,
		warnings: result.sections[0]?.warnings ?? [],
	};
})();
emit(H4);

const H5 = await (async (): Promise<Result> => {
	const { fs, snapshots, patcher } = makeContext();
	const before = "aaa\nbbb\nccc\n";
	await fs.writeText("f.ts", before);
	const tag = snapshots.record("f.ts", before, [1, 2, 3]);
	const result = await patcher.apply(
		Patch.parse(`[f.ts#${tag}]\nPUT 2.=2:\n+bbb\n`),
	);
	const finalContent = await fs.readText("f.ts");
	return {
		scenario: "H5 noop PUT",
		outcome: "success" as const,
		ops: 2,
		chars: finalContent.length,
		finalContent,
		warnings: result.sections[0]?.warnings ?? [],
	};
})();
emit(H5);

const H6 = await (async (): Promise<Result> => {
	const { fs, snapshots, patcher } = makeContext();
	await fs.writeText("f.ts", "");
	const tag = snapshots.record("f.ts", "");
	const result = await patcher.apply(
		Patch.parse(`[f.ts#${tag}]\nPUT <1:\n+first\n`),
	);
	const finalContent = await fs.readText("f.ts");
	return {
		scenario: "H6 empty-file insert",
		outcome: "success" as const,
		ops: 2,
		chars: finalContent.length,
		finalContent,
		warnings: result.sections[0]?.warnings ?? [],
	};
})();
emit(H6);

const H7 = await (async (): Promise<Result> => {
	const { fs, snapshots, patcher } = makeContext();
	const before = "aaa\nbbb\nccc\nddd\n";
	await fs.writeText("f.ts", before);
	const tag = snapshots.record("f.ts", before, [1]);
	const patch = `[f.ts#${tag}]\nPUT 3.=3:\n+CCC\n`;
	let first: { outcome: "success" | "rejected"; code?: string; chars: number };
	try {
		await patcher.apply(Patch.parse(patch));
		first = { outcome: "success", chars: 0 };
	} catch (error) {
		first = {
			outcome: "rejected",
			code: codeOf(error),
			chars: (error as Error).message.length,
		};
	}
	let retry: { outcome: "success" | "rejected"; chars: number };
	try {
		await patcher.apply(Patch.parse(patch));
		retry = { outcome: "success", chars: 0 };
	} catch (error) {
		retry = {
			outcome: "rejected",
			chars: (error as Error).message.length,
		};
	}
	const finalContent = await fs.readText("f.ts");
	return {
		scenario: "H7 unseen-anchor blind edit reject + retry",
		outcome:
			first.outcome === "rejected" && retry.outcome === "success"
				? ("success" as const)
				: ("rejected" as const),
		code: first.code,
		ops: 4,
		chars: first.chars + retry.chars,
		finalContent,
		warnings: [],
	};
})();
emit(H7);

const H8 = await (async (): Promise<Result> => {
	const { fs, snapshots, patcher } = makeContext();
	const before = "aaa\nbbb\n";
	await fs.writeText("a.ts", before);
	await fs.writeText("b.ts", before);
	const tagA = snapshots.record("a.ts", before, [1, 2]);
	const tagB = snapshots.record("b.ts", before, [1, 2]);
	await fs.writeText("b.ts", "xxx\nyyy\n");
	let ok = false;
	let error: unknown;
	try {
		await patcher.apply(
			Patch.parse(
				`[a.ts#${tagA}]\nPUT 1.=1:\n+AAA\n[b.ts#${tagB}]\nPUT 1.=1:\n+BBB\n`,
			),
		);
		ok = true;
	} catch (e) {
		error = e;
	}
	const finalContent = (await fs.readText("a.ts")) + (await fs.readText("b.ts"));
	return {
		scenario: "H8 multi-section all-or-nothing",
		outcome: ok ? "success" : "rejected",
		code: codeOf(error),
		ops: 2,
		chars: ok ? finalContent.length : (error as Error).message.length,
		finalContent,
		warnings: [],
	};
})();
emit(H8);

const H9 = await (async (): Promise<Result> => {
	const { fs, snapshots, patcher } = makeContext();
	const before = "aaa\nbbb\nccc\n";
	await fs.writeText("f.ts", before);
	const tag = snapshots.record("f.ts", before, [1, 2, 3]);
	const result = await patcher.apply(
		Patch.parse(`[f.ts#${tag}]\nCUT 2.=2\nPUT >3:\n+bbb\n`),
	);
	const finalContent = await fs.readText("f.ts");
	return {
		scenario: "H9 cut/paste register round-trip",
		outcome: "success" as const,
		ops: 2,
		chars: finalContent.length,
		finalContent,
		warnings: result.sections[0]?.warnings ?? [],
	};
})();
emit(H9);

const H10 = await (async (): Promise<Result> => {
	const { fs, patcher } = makeContext();
	const before = "aaa\nbbb\nccc\n";
	await fs.writeText("f.ts", before);
	let ok = false;
	let error: unknown;
	try {
		await patcher.apply(Patch.parse(`[f.ts]\nPUT 2.=2:\n+BBB\n`));
		ok = true;
	} catch (e) {
		error = e;
	}
	const finalContent = await fs.readText("f.ts");
	return {
		scenario: "H10 missing snapshot tag rejected",
		outcome: ok ? "success" : "rejected",
		code: codeOf(error),
		ops: 1,
		chars: ok ? finalContent.length : (error as Error).message.length,
		finalContent,
		warnings: [],
	};
})();
emit(H10);

const totalOps = results.reduce((sum, r) => sum + r.ops, 0);
const totalChars = results.reduce((sum, r) => sum + r.chars, 0);
const agg = {
	version: "hashline",
	scenarios: results.length,
	byOutcome: results.reduce<Record<string, number>>((m, r) => {
		m[r.outcome] = (m[r.outcome] ?? 0) + 1;
		return m;
	}, {}),
	totalOps,
	totalChars,
};
for (const message of messages) console.log(message);
console.log("EVAL_AGGREGATE " + JSON.stringify(agg));
