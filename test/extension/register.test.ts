import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import register from "../../index";

describe("extension registration", () => {
	it("registers the read and edit tools", () => {
		const toolNames: string[] = [];
		const eventNames: string[] = [];
		const pi = {
			registerTool(tool: { name: string }) {
				toolNames.push(tool.name);
			},
			on(name: string) {
				eventNames.push(name);
			},
		} as any;

		register(pi);

		expect(toolNames.sort()).toEqual(["edit", "read", "read_skill", "undo_last_edit"]);

		expect(eventNames).toEqual(["session_start", "tool_result"]);
	});
});

describe("tool prompt file references", () => {
	it("edit.ts loads the consolidated edit.md prompt", () => {
		const source = readFileSync(
			new URL("../../src/edit.ts", import.meta.url),
			"utf-8",
		);
		expect(source).toContain("../prompts/edit.md");
		expect(source).toContain("../prompts/edit-snippet.md");
		expect(source).toContain("../prompts/edit-guidelines.md");
	});

	it("read-skill.ts loads the read-skill prompts", () => {
		const source = readFileSync(
			new URL("../../src/read-skill.ts", import.meta.url),
			"utf-8",
		);
		expect(source).toContain("../prompts/read-skill.md");
		expect(source).toContain("../prompts/read-skill-snippet.md");
	});
});
