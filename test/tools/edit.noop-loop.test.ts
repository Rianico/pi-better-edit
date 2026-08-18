import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";
import { compPreview } from "../../src/edit";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
	extractHash,
} from "../support/fixtures";

const NOOP_LINE_1 = "bbb";

async function readSample(ctx: any, readTool: any): Promise<string[]> {
	await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);
	return await lineHashes("aaa\nbbb\nccc\n");
}

describe("edit tool noop-loop guard", () => {
	it("rejects the third identical noop with [E_NOOP_LOOP] and echoes the current range", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await readSample(ctx, readTool);
			const payload = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] };

			const first = await editTool.execute("e1", payload, undefined, undefined, ctx);
			expect(first.details.classification).toBe("noop");
			expect(getText(first)).toContain("No changes made");
			expect(getText(first)).not.toContain("[E_NOOP_LOOP]");

			const second = await editTool.execute("e2", payload, undefined, undefined, ctx);
			expect(second.details.classification).toBe("noop");
			expect(getText(second)).toContain("No changes made");
			expect(getText(second)).toContain("[E_NOOP_LOOP] Notice:");
			expect(getText(second)).toContain("no-op'd twice");

			const err = (await editTool
				.execute("e3", payload, undefined, undefined, ctx)
				.catch((e: unknown) => e)) as Error;
			expect(err).toBeInstanceOf(Error);
			expect(err.message).toContain("[E_NOOP_LOOP]");
			expect(err.message).toContain("submitted 3×");
			expect(err.message).toContain(`│${NOOP_LINE_1}`);
		});
	});

	it("resets the counter when a real applied edit lands on the same file", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await readSample(ctx, readTool);
			const noopPayload = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] };

			await editTool.execute("e1", noopPayload, undefined, undefined, ctx);

			await editTool.execute(
				"e2",
				{ path: "sample.ts", edits: [[hashes[0]!, hashes[0]!, "AAA"]] },
				undefined,
				undefined,
				ctx,
			);

			const again = await editTool.execute("e3", noopPayload, undefined, undefined, ctx);
			expect(again.details.classification).toBe("noop");
			expect(getText(again)).toContain("No changes made");
			expect(getText(again)).not.toContain("[E_NOOP_LOOP]");
		});
	});

	it("resets the counter when a noop uses a different payload", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await readSample(ctx, readTool);

			await editTool.execute(
				"e1",
				{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] },
				undefined,
				undefined,
				ctx,
			);
			await editTool.execute(
				"e2",
				{ path: "sample.ts", edits: [[hashes[2]!, hashes[2]!, "ccc"]] },
				undefined,
				undefined,
				ctx,
			);

			const third = await editTool.execute(
				"e3",
				{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] },
				undefined,
				undefined,
				ctx,
			);
			expect(third.details.classification).toBe("noop");
			expect(getText(third)).not.toContain("[E_NOOP_LOOP]");
			expect(getText(third)).not.toContain("no-op'd twice");
		});
	});

	it("keeps counters per file so a loop in one file does not affect another", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			await writeFile(join(cwd, "other.ts"), "aaa\nbbb\nccc\n", "utf-8");

			const hashes = await readSample(ctx, readTool);
			await readTool.execute("r1", { path: "other.ts" }, undefined, undefined, ctx);

			const payloadA = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] };
			await editTool.execute("a1", payloadA, undefined, undefined, ctx);
			await editTool.execute("a2", payloadA, undefined, undefined, ctx);

			const other = await editTool.execute(
				"b1",
				{ path: "other.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] },
				undefined,
				undefined,
				ctx,
			);
			expect(other.details.classification).toBe("noop");
			expect(getText(other)).not.toContain("[E_NOOP_LOOP]");

			const err = (await editTool
				.execute("a3", payloadA, undefined, undefined, ctx)
				.catch((e: unknown) => e)) as Error;
			expect(err.message).toContain("[E_NOOP_LOOP]");
		});
	});

	it("treats a missing-path resend as identical to the explicit-path form", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await readSample(ctx, readTool);

			await editTool.execute(
				"e1",
				{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] },
				undefined,
				undefined,
				ctx,
			);

			const missingPath = await editTool.execute(
				"e2",
				{ path: null, edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] },
				undefined,
				undefined,
				ctx,
			);
			expect(missingPath.details.classification).toBe("noop");
			expect(getText(missingPath)).toContain("[E_NOOP_LOOP] Notice:");
			expect(getText(missingPath)).toContain("no-op'd twice");

			const err = (await editTool
				.execute(
					"e3",
					{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] },
					undefined,
					undefined,
					ctx,
				)
				.catch((e: unknown) => e)) as Error;
			expect(err.message).toContain("[E_NOOP_LOOP]");
			expect(err.message).toContain("submitted 3×");
		});
	});

	it("echoes rows that serve as usable anchors for a follow-up applied edit", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await readSample(ctx, readTool);
			const payload = { path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] };

			await editTool.execute("e1", payload, undefined, undefined, ctx);
			await editTool.execute("e2", payload, undefined, undefined, ctx);
			const err = (await editTool
				.execute("e3", payload, undefined, undefined, ctx)
				.catch((e: unknown) => e)) as Error;
			expect(err.message).toContain("[E_NOOP_LOOP]");

			const echoedRow = err.message
				.split("\n")
				.find((l) => l.includes(`│${NOOP_LINE_1}`))!;
			const echoedHash = extractHash(echoedRow);

			const followUp = await editTool.execute(
				"e4",
				{ path: "sample.ts", edits: [[echoedHash, echoedHash, "BBB"]] },
				undefined,
				undefined,
				ctx,
			);
			expect(getText(followUp)).toContain("Successfully edited");
			expect(await readFile(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
		});
	});

	it("never lets previews (noPersist) trip the guard", async () => {
		await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const hashes = await readSample(ctx, readTool);

			for (let i = 0; i < 5; i++) {
				const preview = await compPreview(
					{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] },
					cwd,
				);
				expect("error" in preview ? preview.error : "no error").toContain(
					"No changes made",
				);
			}

			const result = await editTool.execute(
				"e1",
				{ path: "sample.ts", edits: [[hashes[1]!, hashes[1]!, NOOP_LINE_1]] },
				undefined,
				undefined,
				ctx,
			);
			expect(result.details.classification).toBe("noop");
			expect(getText(result)).not.toContain("[E_NOOP_LOOP]");
		});
	});
});
