import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { withTempFile, getText, extractHash } from "../support/fixtures";
import { resolveTarget, type EvalTarget } from "./target";

const RUN = process.env.RUN_EVAL === "1";

interface Call {
	tool: string;
	outLen: number;
}

interface ScenarioResult {
	scenario: string;
	outcome: "success" | "rejected" | "error";
	code?: string;
	calls: Call[];
	finalContent: string;
}

interface Ctx {
	cwd: string;
}

async function call(
	rec: ScenarioResult,
	tool: unknown,
	name: string,
	params: unknown,
	ctx: Ctx,
): Promise<{ ok: boolean; text: string; code?: string; r?: any }> {
	try {
		const r = await (tool as any).execute(
			"x",
			params,
			undefined,
			undefined,
			ctx,
		);
		const text = getText(r);
		rec.calls.push({ tool: name, outLen: text.length });
		const isError = (r as any)?.isError === true;
		return isError
			? { ok: false, text, code: codeOf(text), r }
			: { ok: true, text, r };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		rec.calls.push({ tool: name, outLen: msg.length });
		return { ok: false, text: msg, code: codeOf(msg) };
	}
}

function codeOf(text: string): string | undefined {
	return text.match(/\[E_[A-Z_]+\]/)?.[0];
}

function readAnchor(text: string, marker: string): string {
	const line = text.split("\n").find((l) => l.includes(marker));
	expect(line, `read output should contain "${marker}"`).toBeDefined();
	return extractHash(line!);
}

function setupTarget(
	cwd: string,
	target: EvalTarget,
): {
	ctx: Ctx;
	getTool: (name: string) => unknown;
	handlers: Map<string, (...args: unknown[]) => unknown>;
} {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const tools = new Map<string, unknown>();
	const pi = {
		registerTool(t: any) {
			tools.set(t.name, t);
		},
		registerCommand() {},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		getActiveTools: () => [] as string[],
		setActiveTools() {},
	} as any;
	target.register(pi);
	return { ctx: { cwd } as Ctx, getTool: (n) => tools.get(n), handlers };
}

async function deliverDiff(
	handlers: Map<string, (...args: unknown[]) => unknown>,
	ctx: Ctx,
	event: {
		toolName: string;
		isError: boolean;
		input: unknown;
		details: unknown;
		content: unknown;
	},
): Promise<string> {
	const h = handlers.get("tool_result");
	expect(h).toBeDefined();
	const out = await h!(event, ctx);
	const text = (out as any)?.content?.[0]?.text ?? "";
	return text;
}

async function fireSessionStart(
	handlers: Map<string, (...args: unknown[]) => unknown>,
	ctx: Ctx,
): Promise<void> {
	const h = handlers.get("session_start");
	if (h) await h({ reason: "startup" }, ctx);
}

function sessionCtx(cwd: string, id: string): Ctx {
	return { cwd, sessionManager: { getSessionId: () => id } } as Ctx;
}

const describeGate = RUN ? describe : describe.skip;

describeGate("EVAL comparison battery", () => {
	it("runs the battery", async () => {
		const target = await resolveTarget();
		const results: ScenarioResult[] = [];

		await withTempFile("b1.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B1 single-line replace",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b1.ts" },
				ctx,
			);
			const anchor = readAnchor(r1.text, "│bbb");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b1.ts",
					anchor_from: anchor,
					anchor_to: anchor,
					replace_with: "BBB",
				},
				ctx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile(
			"b2.ts",
			"aaa\nbbb\nccc\nddd\n",
			async ({ cwd, path }) => {
				const rec: ScenarioResult = {
					scenario: "B2 range replace",
					outcome: "success",
					calls: [],
					finalContent: "",
				};
				const { ctx, getTool } = setupTarget(cwd, target);
				const r1 = await call(
					rec,
					getTool(target.toolNames.read),
					target.toolNames.read,
					{ path: "b2.ts" },
					ctx,
				);
				const a = readAnchor(r1.text, "│bbb");
				const b = readAnchor(r1.text, "│ccc");
				const e1 = await call(
					rec,
					getTool(target.toolNames.edit),
					target.toolNames.edit,
					{
						path: "b2.ts",
						anchor_from: a,
						anchor_to: b,
						replace_with: "X\nY",
					},
					ctx,
				);
				rec.outcome = e1.ok ? "success" : "rejected";
				rec.finalContent = await readFile(path, "utf-8");
				results.push(rec);
			},
		);

		await withTempFile(
			"b3.ts",
			"aaa\nbbb\nccc\nddd\n",
			async ({ cwd, path }) => {
				const rec: ScenarioResult = {
					scenario: "B3 interior drift must-not-silently-overwrite",
					outcome: "success",
					calls: [],
					finalContent: "",
				};
				const { ctx, getTool } = setupTarget(cwd, target);
				const r1 = await call(
					rec,
					getTool(target.toolNames.read),
					target.toolNames.read,
					{ path: "b3.ts" },
					ctx,
				);
				const a = readAnchor(r1.text, "│bbb");
				const b = readAnchor(r1.text, "│ddd");
				await writeFile(path, "aaa\nbbb\nCCC\nddd\n", "utf-8");
				const e1 = await call(
					rec,
					getTool(target.toolNames.edit),
					target.toolNames.edit,
					{
						path: "b3.ts",
						anchor_from: a,
						anchor_to: b,
						replace_with: "X\nY\nZ",
					},
					ctx,
				);
				rec.outcome = e1.ok ? "success" : "rejected";
				rec.code = e1.code;
				rec.finalContent = await readFile(path, "utf-8");
				results.push(rec);
			},
		);

		await withTempFile(
			"b4.ts",
			"aaa\nbbb\nccc\nddd\n",
			async ({ cwd, path }) => {
				const rec: ScenarioResult = {
					scenario: "B4 out-of-range in-place change",
					outcome: "success",
					calls: [],
					finalContent: "",
				};
				const { ctx, getTool } = setupTarget(cwd, target);
				const r1 = await call(
					rec,
					getTool(target.toolNames.read),
					target.toolNames.read,
					{ path: "b4.ts" },
					ctx,
				);
				const a = readAnchor(r1.text, "│bbb");
				const b = readAnchor(r1.text, "│ccc");
				await writeFile(path, "AAA\nbbb\nccc\nddd\n", "utf-8");
				const e1 = await call(
					rec,
					getTool(target.toolNames.edit),
					target.toolNames.edit,
					{
						path: "b4.ts",
						anchor_from: a,
						anchor_to: b,
						replace_with: "X\nY",
					},
					ctx,
				);
				rec.outcome = e1.ok ? "success" : "rejected";
				rec.finalContent = await readFile(path, "utf-8");
				results.push(rec);
			},
		);

		await withTempFile("b5.ts", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B5 deletion-above-range positional-shift",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b5.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│b");
			const b = readAnchor(r1.text, "│c");
			await writeFile(path, "b\nc\nd\ne\n", "utf-8");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b5.ts",
					anchor_from: a,
					anchor_to: b,
					replace_with: "X\nY",
				},
				ctx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b6.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B6 change-then-revert interior",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b6.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│b");
			const b = readAnchor(r1.text, "│c");
			await writeFile(path, "a\nB\nc\nd\n", "utf-8");
			await writeFile(path, "a\nb\nc\nd\n", "utf-8");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b6.ts",
					anchor_from: a,
					anchor_to: b,
					replace_with: "X\nY",
				},
				ctx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile(
			"b7.ts",
			Array.from({ length: 9 }, (_, i) => `l${i + 1}`).join("\n"),
			async ({ cwd, path }) => {
				const rec: ScenarioResult = {
					scenario: "B7 never-served interior paged-read-gap",
					outcome: "success",
					calls: [],
					finalContent: "",
				};
				const { ctx, getTool } = setupTarget(cwd, target);
				const r1 = await call(
					rec,
					getTool(target.toolNames.read),
					target.toolNames.read,
					{ path: "b7.ts", limit: 3 },
					ctx,
				);
				const r2 = await call(
					rec,
					getTool(target.toolNames.read),
					target.toolNames.read,
					{ path: "b7.ts", offset: 7 },
					ctx,
				);
				const a = readAnchor(r1.text, "│l3");
				const b = readAnchor(r2.text, "│l7");
				const e1 = await call(
					rec,
					getTool(target.toolNames.edit),
					target.toolNames.edit,
					{
						path: "b7.ts",
						anchor_from: a,
						anchor_to: b,
						replace_with: "X\nY\nZ\nW\nV",
					},
					ctx,
				);
				rec.outcome = e1.ok ? "success" : "rejected";
				rec.code = e1.code;
				rec.finalContent = await readFile(path, "utf-8");
				results.push(rec);
			},
		);

		await withTempFile("b8.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B8 blind-edit no-read never-served-boundary",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const hashes = await target.lineHashes(
				"aaa\nbbb\nccc\n",
				join(cwd, "b8.ts"),
			);
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b8.ts",
					anchor_from: hashes[1]!,
					anchor_to: hashes[1]!,
					replace_with: "BBB",
				},
				ctx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b9.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B9 boundary-changed stale-anchor",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b9.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│bbb");
			await writeFile(path, "aaa\nBBB\nccc\n", "utf-8");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{ path: "b9.ts", anchor_from: a, anchor_to: a, replace_with: "X" },
				ctx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b10.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B10 duplicate-content drift must-still-reject",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b10.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│a");
			const b = readAnchor(r1.text, "│d");
			await writeFile(path, "a\nb\nb\nd\n", "utf-8");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b10.ts",
					anchor_from: a,
					anchor_to: b,
					replace_with: "X\nY\nZ\nW",
				},
				ctx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b11.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B11 noop replace",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b11.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│bbb");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b11.ts",
					anchor_from: a,
					anchor_to: a,
					replace_with: "bbb",
				},
				ctx,
			);
			rec.outcome = e1.ok
				? e1.text.includes("noop")
					? "success"
					: "error"
				: "rejected";
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b12.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B12 noop-with-out-of-range-drift",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b12.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│a");
			await writeFile(path, "a\nb\nc\nD\n", "utf-8");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{ path: "b12.ts", anchor_from: a, anchor_to: a, replace_with: "a" },
				ctx,
			);
			rec.outcome = e1.ok
				? e1.text.includes("noop")
					? "success"
					: "error"
				: "rejected";
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b13.ts", "a\nb\nc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B13 chained-edit-from-diff-rows-no-reread",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool, handlers } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b13.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│b");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{ path: "b13.ts", anchor_from: a, anchor_to: a, replace_with: "B" },
				ctx,
			);
			const diff = await deliverDiff(handlers, ctx, {
				toolName: target.toolNames.edit,
				isError: false,
				input: { path: "b13.ts" },
				details: e1.r?.details,
				content: e1.r?.content,
			});
			const plusRow = diff
				.split("\n")
				.find((l) => l.startsWith("+") && l.includes("│B"));
			if (plusRow) {
				const plusHash = plusRow.replace(/^\+/, "").split("│")[0]!;
				const e2 = await call(
					rec,
					getTool(target.toolNames.edit),
					target.toolNames.edit,
					{
						path: "b13.ts",
						anchor_from: plusHash,
						anchor_to: plusHash,
						replace_with: "B2",
					},
					ctx,
				);
				if (!e2.ok) {
					rec.outcome = "rejected";
					rec.code = e2.code;
				}
			} else {
				rec.outcome = "error";
			}
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b14.ts", "", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B14 empty-file insert",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b14.ts" },
				ctx,
			);
			const emptyHash = r1.text.split("\n")[0]!.split("│")[0]!;
			expect(emptyHash).toMatch(/^[A-Za-z0-9]{3}$/);
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b14.ts",
					anchor_from: emptyHash,
					anchor_to: emptyHash,
					replace_with: "first\nsecond",
				},
				ctx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile(
			"b15.ts",
			Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"),
			async ({ cwd, path }) => {
				const rec: ScenarioResult = {
					scenario: "B15 large-range drift capped-feedback",
					outcome: "success",
					calls: [],
					finalContent: "",
				};
				const { ctx, getTool } = setupTarget(cwd, target);
				const r1 = await call(
					rec,
					getTool(target.toolNames.read),
					target.toolNames.read,
					{ path: "b15.ts" },
					ctx,
				);
				const a = readAnchor(r1.text, "│line 1");
				const b = readAnchor(r1.text, "│line 200");
				await writeFile(
					path,
					Array.from({ length: 200 }, (_, i) =>
						i === 99 ? "LINE 100" : `line ${i + 1}`,
					).join("\n"),
					"utf-8",
				);
				const e1 = await call(
					rec,
					getTool(target.toolNames.edit),
					target.toolNames.edit,
					{
						path: "b15.ts",
						anchor_from: a,
						anchor_to: b,
						replace_with: "replacement",
					},
					ctx,
				);
				rec.outcome = e1.ok ? "success" : "rejected";
				rec.code = e1.code;
				rec.finalContent = await readFile(path, "utf-8");
				results.push(rec);
			},
		);

		await withTempFile("b16.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B16a undo after replace",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b16.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│bbb");
			await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b16.ts",
					anchor_from: a,
					anchor_to: a,
					replace_with: "BBB",
				},
				ctx,
			);
			const u1 = await call(
				rec,
				getTool(target.toolNames.undo),
				"undo",
				{ path: "b16.ts" },
				ctx,
			);
			rec.outcome = u1.ok ? "success" : "rejected";
			rec.code = u1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b16b.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B16b undo after external change",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b16b.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│bbb");
			await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b16b.ts",
					anchor_from: a,
					anchor_to: a,
					replace_with: "BBB",
				},
				ctx,
			);
			await writeFile(path, "AAA\nBBB\nccc\n", "utf-8");
			const u1 = await call(
				rec,
				getTool(target.toolNames.undo),
				"undo",
				{ path: "b16b.ts" },
				ctx,
			);
			rec.outcome = u1.ok ? "success" : "rejected";
			rec.code = u1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b17.ts", "a\nb\nc\nd\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B17 reversed-range autocorrect",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b17.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│b");
			const b = readAnchor(r1.text, "│c");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b17.ts",
					anchor_from: b,
					anchor_to: a,
					replace_with: "X\nY",
				},
				ctx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b18.ts", "a\nb\nc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B18 boundary-dup autocorrect",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { ctx, getTool } = setupTarget(cwd, target);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b18.ts" },
				ctx,
			);
			const a = readAnchor(r1.text, "│b");
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b18.ts",
					anchor_from: a,
					anchor_to: a,
					replace_with: "a\nX",
				},
				ctx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b19.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B19 sub-agent-session-does-not-wipe-main",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { getTool, handlers } = setupTarget(cwd, target);
			const mainCtx = sessionCtx(cwd, "eval-main");
			const subCtx = sessionCtx(cwd, "eval-sub");
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b19.ts" },
				mainCtx,
			);
			const a = readAnchor(r1.text, "│bbb");
			await fireSessionStart(handlers, subCtx);
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b19.ts",
					anchor_from: a,
					anchor_to: a,
					replace_with: "BBB",
				},
				mainCtx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b20.ts", "a\nb\nc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B20 main-and-sub-agent-both-edit",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { getTool, handlers } = setupTarget(cwd, target);
			const mainCtx = sessionCtx(cwd, "eval-main");
			const subCtx = sessionCtx(cwd, "eval-sub");
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b20.ts" },
				mainCtx,
			);
			const aC = readAnchor(r1.text, "│c");
			await fireSessionStart(handlers, subCtx);
			const s1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b20.ts", limit: 2 },
				subCtx,
			);
			const sB = readAnchor(s1.text, "│b");
			const se = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b20.ts",
					anchor_from: sB,
					anchor_to: sB,
					replace_with: "B",
				},
				subCtx,
			);
			if (se.ok) {
				await deliverDiff(handlers, subCtx, {
					toolName: target.toolNames.edit,
					isError: false,
					input: { path: "b20.ts" },
					details: se.r?.details,
					content: se.r?.content,
				});
			}
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b20.ts",
					anchor_from: aC,
					anchor_to: aC,
					replace_with: "C",
				},
				mainCtx,
			);
			rec.outcome = se.ok ? (e1.ok ? "success" : "rejected") : "error";
			rec.code = se.ok ? e1.code : se.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b21.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B21 same-session-restart-keeps-served-state",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { getTool, handlers } = setupTarget(cwd, target);
			const mainCtx = sessionCtx(cwd, "eval-main");
			await fireSessionStart(handlers, mainCtx);
			const r1 = await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b21.ts" },
				mainCtx,
			);
			const a = readAnchor(r1.text, "│bbb");
			await fireSessionStart(handlers, mainCtx);
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b21.ts",
					anchor_from: a,
					anchor_to: a,
					replace_with: "BBB",
				},
				mainCtx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		await withTempFile("b22.ts", "a\nb\nc\n", async ({ cwd, path }) => {
			const rec: ScenarioResult = {
				scenario: "B22 sub-agent-serves-not-visible-to-main",
				outcome: "success",
				calls: [],
				finalContent: "",
			};
			const { getTool } = setupTarget(cwd, target);
			const mainCtx = sessionCtx(cwd, "eval-main");
			const subCtx = sessionCtx(cwd, "eval-sub");
			await call(
				rec,
				getTool(target.toolNames.read),
				target.toolNames.read,
				{ path: "b22.ts" },
				subCtx,
			);
			const hashes = await target.lineHashes("a\nb\nc\n", join(cwd, "b22.ts"));
			const e1 = await call(
				rec,
				getTool(target.toolNames.edit),
				target.toolNames.edit,
				{
					path: "b22.ts",
					anchor_from: hashes[1]!,
					anchor_to: hashes[1]!,
					replace_with: "B",
				},
				mainCtx,
			);
			rec.outcome = e1.ok ? "success" : "rejected";
			rec.code = e1.code;
			rec.finalContent = await readFile(path, "utf-8");
			results.push(rec);
		});

		const totalCalls = results.reduce((s, r) => s + r.calls.length, 0);
		const totalChars = results.reduce(
			(s, r) => s + r.calls.reduce((t, c) => t + c.outLen, 0),
			0,
		);
		const agg = {
			version: target.version,
			scenarios: results.length,
			byOutcome: results.reduce<Record<string, number>>((m, r) => {
				m[r.outcome] = (m[r.outcome] ?? 0) + 1;
				return m;
			}, {}),
			totalCalls,
			totalChars,
		};
		const outLines: string[] = [];
		for (const r of results) {
			outLines.push(
				"EVAL_RESULT " +
					JSON.stringify({
						scenario: r.scenario,
						outcome: r.outcome,
						code: r.code ?? null,
						calls: r.calls.map((c) => c.tool),
						callsLen: r.calls.reduce((t, c) => t + c.outLen, 0),
						finalContent: r.finalContent,
					}),
			);
		}
		outLines.push("EVAL_AGGREGATE " + JSON.stringify(agg));
		const evalOut = process.env.EVAL_OUT;
		if (evalOut) {
			await writeFile(evalOut, outLines.join("\n") + "\n", "utf-8");
		}
		for (const line of outLines) {
			console.log(line);
		}
	});
});
