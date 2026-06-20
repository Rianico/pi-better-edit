import { readFileSync } from "fs";

export function loadPrompt(relativePath: string, replacements?: Record<string, string>): string {
	let content = readFileSync(new URL(relativePath, import.meta.url), "utf-8").trim();
	if (replacements) {
		for (const [key, value] of Object.entries(replacements)) {
			content = content.replaceAll(`{{${key}}}`, value);
		}
	}
	return content;
}

export function loadPromptGuidelines(relativePath: string): string[] {
	return readFileSync(new URL(relativePath, import.meta.url), "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2));
}