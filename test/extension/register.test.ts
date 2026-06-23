import { describe, expect, it } from "vitest";
import register from "../../index";

describe("extension registration", () => {
	it("registers the read and replace tools", () => {
		const toolNames: string[] = [];
		const eventNames: string[] = [];
		const commandNames: string[] = [];
		const pi = {
			registerTool(tool: { name: string }) {
				toolNames.push(tool.name);
			},
			registerCommand(name: string) {
				commandNames.push(name);
			},
			on(name: string) {
				eventNames.push(name);
			},
		} as any;

		register(pi);

		expect(toolNames.sort()).toEqual(["read", "replace"]);
		expect(commandNames).toEqual(["toggle-auto-read"]);

		expect(eventNames).toEqual(["session_start", "tool_result"]);
	});
});
