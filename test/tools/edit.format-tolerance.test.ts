import { describe, expect, it } from "vitest";
import { writeFile, readFile } from "fs/promises";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
} from "../support/fixtures";
import { lineHashes } from "../../src/hashline";
import { recordDiffServes, sessionKeyFor } from "../../src/served-session/index.js";

const CLEAN = "function hello() {\n  const x = 1;\n  return x;\n}\n";

const MESSY_REPLACEMENT =
	"}\nfunction   multiply( a:  number,   b:  number )  {\n  return   a  *  b;\n}\n";

const REFORMATTED =
	"function hello() {\n  const x = 1;\n  return x;\n}\nfunction multiply(a: number, b: number) {\n  return a * b;\n}\n";

function extractPlusHashes(diff: string): string[] {
	const out: string[] = [];
	for (const line of diff.split("\n")) {
		const m = line.match(/^\+([A-Za-z0-9]{3})│/);
		if (m) out.push(m[1]!);
	}
	return out;
}

describe("format-tolerance across edits (whitespace-only external reformat)", () => {
	it("second edit anchored on post-edit diff rows survives an external whitespace-only reformat", async () => {
		await withTempFile("sample.ts", CLEAN, async ({ cwd, path }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);

			await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, ctx);

			const hashes = await lineHashes(CLEAN, path);
			const lastHash = hashes[hashes.length - 1]!;

			const first = await editTool.execute(
				"e1",
				{
					path: "sample.ts",
					edits: [[lastHash, lastHash, MESSY_REPLACEMENT]],
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(first)).toContain("Successfully edited");
			const diff = first.details?.diff as string | undefined;
			expect(diff).toBeDefined();
			const plusHashes = extractPlusHashes(diff!);
			expect(plusHashes.length).toBeGreaterThan(0);
			const anchor = plusHashes[0]!;

			await recordDiffServes({
				sessionKey: sessionKeyFor(ctx),
				path,
				servedRows: first.details?.servedRows as any,
				resultLineCount: first.details?.resultLineCount,
				firstChangedLine: first.details?.firstChangedLine,
			});

			await writeFile(path, REFORMATTED, "utf-8");

			const second = await editTool.execute(
				"e2",
				{
					path: "sample.ts",
					edits: [[anchor, anchor, "REPLACED"]],
				},
				undefined,
				undefined,
				ctx,
			);
			expect(getText(second)).toContain("Successfully edited");
			const content = await readFile(path, "utf-8");
			expect(content).toContain("REPLACED");
		});
	});
});
