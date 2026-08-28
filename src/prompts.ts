import { readFileSync } from "node:fs";
import {
	EDIT_DESCRIPTION,
	EDIT_SNIPPET,
	EDIT_GUIDELINES,
} from "./payload-contract.js";


const EDIT_PROMPT_FILES = new Set([
	"../prompts/edit.md",
	"prompts/edit.md",
	"../prompts/edit-snippet.md",
	"prompts/edit-snippet.md",
]);

const EDIT_GUIDE_FILES = new Set([
	"../prompts/edit-guidelines.md",
	"prompts/edit-guidelines.md",
]);

export function loadP(relativePath: string, replacements?: Record<string, string>): string {
	if (EDIT_PROMPT_FILES.has(relativePath)) {
		let content = relativePath.includes("snippet") ? EDIT_SNIPPET : EDIT_DESCRIPTION;
		if (replacements) {
			for (const [key, value] of Object.entries(replacements)) {
				content = content.split(`{{${key}}}`).join(value);
			}
		}
		return content;
	}
	let content = readFileSync(new URL(relativePath, import.meta.url), "utf-8").trim();
	if (replacements) {
		for (const [key, value] of Object.entries(replacements)) {
			content = content.split(`{{${key}}}`).join(value);
		}
	}
	return content;
}

export function loadGuide(relativePath: string, replacements?: Record<string, string>): string[] {
	if (EDIT_GUIDE_FILES.has(relativePath)) {
		let guidelines = [...EDIT_GUIDELINES];
		if (replacements) {
			for (const [key, value] of Object.entries(replacements)) {
				guidelines = guidelines.map((line) => line.split(`{{${key}}}`).join(value));
			}
		}
		return guidelines;
	}
	let content = readFileSync(new URL(relativePath, import.meta.url), "utf-8");
	if (replacements) {
		for (const [key, value] of Object.entries(replacements)) {
			content = content.split(`{{${key}}}`).join(value);
		}
	}
	return content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2));
}
