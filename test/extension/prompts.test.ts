import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const replacePrompt = readFileSync(
	new URL("../../prompts/replace.md", import.meta.url),
	"utf-8",
);

describe("prompts/replace.md (model-facing contract)", () => {
	it("shows the end-to-end workflow with read", () => {
		expect(replacePrompt).toMatch(/Call `read` to get HASH anchors/);
		expect(replacePrompt).toMatch(/Copy the 3-character HASH/);
	});

	it("includes worked examples", () => {
		expect(replacePrompt).toMatch(/Single line replace/);
		expect(replacePrompt).toMatch(/Range replace/);
		expect(replacePrompt).toMatch(/Multiple regions in one call/);
		expect(replacePrompt).toContain('"new_lines": []');
	});

	it("requires old_range pair", () => {
		expect(replacePrompt).toMatch(/old_range/i);
	});

	it("declares that edits must be non-conflicting", () => {
		expect(replacePrompt).toContain("[E_EDIT_CONFLICT]");
		expect(replacePrompt).toMatch(/non-conflicting/);
	});

	it("tells the model not to include HASH or line content in anchors", () => {
		expect(replacePrompt).toMatch(/Do not include.*│.*line content/i);
	});

	it("documents that response is empty after successful edit", () => {
		expect(replacePrompt).toContain("response text is empty");
	});

	it("documents error recovery", () => {
		expect(replacePrompt).toContain("[E_STALE_ANCHOR]");
		expect(replacePrompt).toContain("[E_BAD_REF]");
	});
});

const readPrompt = readFileSync(
	new URL("../../prompts/read.md", import.meta.url),
	"utf-8",
);

describe("prompts/read.md (model-facing contract)", () => {
	it("declares the HASH|content output format", () => {
		expect(readPrompt).toMatch(/`HASH|content`/);
		expect(readPrompt).toMatch(/3 characters/);
	});

	it("specifies the URL-safe base64 alphabet", () => {
		expect(readPrompt).toContain("A-Za-z0-9-_");
	});

	it("documents pagination", () => {
		expect(readPrompt).toContain("pagination hint");
		expect(readPrompt).toMatch(/offset=N/);
	});

	it("documents file-kind handling", () => {
		expect(readPrompt).toMatch(/Images? \(JPEG, PNG, GIF, WebP\)/);
		expect(readPrompt).toMatch(/Binary/);
		expect(readPrompt).toMatch(/directories/);
	});
});
