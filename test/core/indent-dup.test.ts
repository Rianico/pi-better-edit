import { describe, expect, it } from "vitest";
import { lineHashes, resEdit, applyEdit } from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("indentation: pure edit preserves duplicates verbatim", () => {
	it("preserves leading duplication when indentation matches exactly — no stripping", async () => {
		const file = "  foo\nbar\n  baz";
		const hashes = await lineHashes(file, home.testPath);
		const result = applyEdit(file, resEdit(
			{ remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "  foo\n  bar" },
		));
		expect(result.content).toBe("  foo\n  foo\n  bar\n  baz");
	});

	it("preserves leading duplication when both indentation and content match — no stripping", async () => {
		const file = "  foo\n  bar\n  baz";
		const hashes = await lineHashes(file, home.testPath);
		const result = applyEdit(file, resEdit(
			{ remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_text: "  foo\n  new" },
		));
		expect(result.content).toBe("  foo\n  foo\n  new\n  baz");
	});
});
