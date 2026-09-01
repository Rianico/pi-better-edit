import { describe, expect, it } from "vitest";
import * as Presentation from "../../src/edit-presentation.js";
import { buildChanged, buildNoop } from "../../src/edit-response.js";
import { genDiff } from "../../src/edit-diff.js";
import { scanDrift } from "../../src/drift.js";
import { runNoopPolicy } from "../../src/noop-guard.js";
import { lineHashes } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("EditPresentation deep module", () => {
	it("exposes single seam for pipeline — re-exports diff, response, render, drift, noop", () => {
		expect(typeof Presentation.genDiff).toBe("function");
		expect(typeof Presentation.buildChanged).toBe("function");
		expect(typeof Presentation.buildNoop).toBe("function");
		expect(typeof Presentation.buildBatchResult).toBe("function");
		expect(typeof Presentation.scanDrift).toBe("function");
		expect(typeof Presentation.runNoopPolicy).toBe("function");
		expect(typeof Presentation.clearNoopLoop).toBe("function");
		// render seam
		expect(typeof Presentation.fmtResult).toBe("function");
		expect(typeof Presentation.buildAppliedText).toBe("function");
	});

	it("unified presentChanged delegates to buildChanged with same result", async () => {
		const original = "aaa\nbbb\nccc\n";
		const result = "aaa\nBBB\nccc\n";
		const originalHashes = await lineHashes(original, home.testPath);
		const resultHashes = await lineHashes(result, home.testPath);
		const input = {
			path: "test.txt",
			originalNormalized: original,
			originalHashes,
			result,
			resultHashes,
			warnings: undefined as string[] | undefined,
			snapshotId: "snap1",
			editMeta: {
				editsAttempted: 1,
				noopEditsCount: 0,
				firstChangedLine: 2,
				lastChangedLine: 2,
				addedLines: 1,
				removedLines: 1,
			},
			driftNotice: undefined as string | undefined,
		};
		const viaPresentation = Presentation.presentChanged(input);
		const viaDirect = buildChanged(input);
		expect(viaPresentation.details.diff).toBe(viaDirect.details.diff);
		expect(viaPresentation.content[0]!.text).toBe(viaDirect.content[0]!.text);
	});

	it("genDiff via presentation seam matches direct genDiff", async () => {
		const a = "aaa\nbbb\n";
		const b = "aaa\nBBB\n";
		const aHashes = await lineHashes(a, home.testPath);
		const bHashes = await lineHashes(b, home.testPath);
		const viaPres = Presentation.genDiff(a, b, 1, bHashes, aHashes);
		const viaDirect = genDiff(a, b, 1, bHashes, aHashes);
		expect(viaPres.diff).toBe(viaDirect.diff);
	});

	it("pipeline single-seam invariant: presentation re-exports drift/noop for pipeline", () => {
		expect(Presentation.scanDrift).toBe(scanDrift);
		expect(Presentation.runNoopPolicy).toBe(runNoopPolicy);
	});
});
