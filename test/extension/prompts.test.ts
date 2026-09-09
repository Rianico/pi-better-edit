import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { loadGuide, loadP } from "../../src/prompts";
import { regRead } from "../../src/read";
import { makeFakePiRegistry } from "../support/fixtures";
import {
	EDIT_DESCRIPTION,
	EDIT_SNIPPET,
	EDIT_GUIDELINES,
} from "../../src/payload-contract";
import { buildToolDef } from "../../src/edit";

function collectTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...collectTsFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

const editPrompt = readFileSync(
	new URL("../../prompts/edit.md", import.meta.url),
	"utf-8",
);

const editSnippet = readFileSync(
	new URL("../../prompts/edit-snippet.md", import.meta.url),
	"utf-8",
);

describe("prompts/edit.md (model-facing contract)", () => {
	it("declares the tool purpose", () => {
		expect(editPrompt).toMatch(
			/Edit a range of lines in a text file.*HASH anchors/,
		);
	});

	it("is single-sourced from payload-contract EDIT_DESCRIPTION", () => {
		expect(editPrompt.trim()).toBe(EDIT_DESCRIPTION);
		expect(loadP("../prompts/edit.md").trim()).toBe(EDIT_DESCRIPTION);
	});
});

describe("prompts/edit-snippet.md (single source)", () => {
	it("is single-sourced from payload-contract EDIT_SNIPPET", () => {
		expect(editSnippet.trim()).toBe(EDIT_SNIPPET);
		expect(loadP("../prompts/edit-snippet.md").trim()).toBe(EDIT_SNIPPET);
	});

	it("snippet and description share canonical payload shape (single source)", () => {
		const canonicalDesc = '{ "file": file, "edits": [{ "anchor_from": a, "anchor_to": b, "replace_with": text }, ...] }';
		const canonicalSnippet = '{"file":file,"edits":[{"anchor_from":a,"anchor_to":b,"replace_with":text}]}';
		expect(editPrompt).toContain(canonicalDesc);
		expect(editSnippet).toContain(canonicalSnippet);
		const tool = buildToolDef();
		expect(tool.description).toBe(EDIT_DESCRIPTION);
		expect(tool.promptSnippet).toBe(EDIT_SNIPPET);
		expect(tool.promptSnippet).toContain(canonicalSnippet);
		expect(tool.description).toContain(canonicalDesc);
	});
});

const readPrompt = readFileSync(
	new URL("../../prompts/read.md", import.meta.url),
	"utf-8",
);

describe("prompts/read.md (model-facing contract)", () => {
	it("declares the HASH|content output format", () => {
		expect(readPrompt).toMatch(/HASH│content/);
		expect(readPrompt).toMatch(/3-char/);
	});

	it("specifies the alphanumeric hash alphabet", () => {
		expect(readPrompt).toMatch(/3-char/);
		expect(readPrompt).toContain("alphanumeric");
	});

	it("documents pagination support", () => {
		expect(readPrompt).toContain("offset/limit");
	});

	it("documents file-kind handling", () => {
		expect(readPrompt).toMatch(/Images/);
		expect(readPrompt).toMatch(/Binary/);
		expect(readPrompt).toMatch(/directory/);
	});
});

describe("prompt guidelines", () => {
	it("edit-guidelines.md loads without template variables", () => {
		const content = readFileSync(
			new URL("../../prompts/edit-guidelines.md", import.meta.url),
			"utf-8",
		);
		expect(content).toContain("anchor_from");
		expect(content).toContain("anchor_to");
		expect(content).toContain("replace_with");
		expect(content).toContain("fresh anchors");
		expect(content).not.toContain("hash_bounds");
		expect(content).not.toContain("new_content");
		expect(content).not.toContain("{{");
	});

	it("edit-guidelines.md is single-sourced from payload-contract", () => {
		const fileGuidelines = loadGuide("../prompts/edit-guidelines.md");
		expect(fileGuidelines).toEqual(EDIT_GUIDELINES);
		const tool = buildToolDef();
		expect(tool.promptGuidelines).toEqual(EDIT_GUIDELINES);
	});

	it("loadGuide returns an array of guidelines", () => {
		const guidelines = loadGuide("../prompts/edit-guidelines.md");
		expect(Array.isArray(guidelines)).toBe(true);
		expect(guidelines.length).toBeGreaterThan(0);
	});

	it("read-guidelines.md frames reading as on-demand recovery, not a per-edit ritual", () => {
		const content = readFileSync(
			new URL("../../prompts/read-guidelines.md", import.meta.url),
			"utf-8",
		);
		expect(content).toContain("never served");
		expect(content).toContain("auto-read diff");
		expect(content).not.toContain("re-read");
		expect(content).not.toContain("call again after any edit");
		expect(content).not.toContain("call before `edit`");
		expect(content).not.toContain("{{AUTO_READ_NOTE}}");
	});
	it("undo-last-edit-guidelines.md loads without template variables", () => {
		const content = readFileSync(
			new URL("../../prompts/undo-last-edit-guidelines.md", import.meta.url),
			"utf-8",
		);
		expect(content).not.toContain("{{");
	});
});

describe("read tool guidelines", () => {
	it("always frames reading as on-demand recovery for never-served information", () => {
		const { pi, getTool } = makeFakePiRegistry();
		regRead(pi);
		const tool = getTool("read");
		const guidelines = tool.promptGuidelines as string[];
		expect(guidelines.some((g) => g.includes("never served"))).toBe(true);
		expect(guidelines.some((g) => g.includes("re-read"))).toBe(false);
		expect(guidelines.some((g) => g.includes("call before `edit`"))).toBe(
			false,
		);
	});
});

describe("prompt file packaging", () => {
	it("every loadP/loadGuide reference resolves to a prompt file shipped in the package", () => {
		const pkg = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
		) as { files: string[] };
		expect(pkg.files).toContain("prompts");
		expect(pkg.files).toContain("src");

		const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
		let refs = 0;
		for (const file of collectTsFiles(srcDir)) {
			const content = readFileSync(file, "utf-8");
			for (const match of content.matchAll(
				/load(?:P|Guide)\("((?:\.\.\/)+prompts\/[^"]+)"\)/g,
			)) {
				refs++;
				const promptPath = match[1]!;
				expect(existsSync(resolve(dirname(file), promptPath))).toBe(true);
			}
		}
		expect(refs).toBeGreaterThan(0);
	});
});

describe("payload-contract prompt generation", () => {
	it("generates prompts from single source with no drift", () => {
		expect(readFileSync(new URL("../../prompts/edit.md", import.meta.url), "utf-8").trim()).toBe(EDIT_DESCRIPTION);
		expect(readFileSync(new URL("../../prompts/edit-snippet.md", import.meta.url), "utf-8").trim()).toBe(EDIT_SNIPPET);
		expect(loadGuide("../prompts/edit-guidelines.md")).toEqual(EDIT_GUIDELINES);
	});
});
