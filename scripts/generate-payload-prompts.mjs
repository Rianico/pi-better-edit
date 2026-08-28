#!/usr/bin/env node
// Generate prompts/edit.md, edit-snippet.md, edit-guidelines.md from payload-contract single source.
// Run: npx tsx scripts/generate-payload-prompts.mjs  (or node with --loader tsx)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EDIT_DESCRIPTION, EDIT_SNIPPET, EDIT_GUIDELINES } from "../src/payload-contract.js";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "../prompts");
writeFileSync(join(promptsDir, "edit.md"), EDIT_DESCRIPTION + "\n", "utf-8");
writeFileSync(join(promptsDir, "edit-snippet.md"), EDIT_SNIPPET + "\n", "utf-8");
writeFileSync(join(promptsDir, "edit-guidelines.md"), EDIT_GUIDELINES.map(l => `- ${l}`).join("\n") + "\n", "utf-8");

console.log("Generated prompts/edit.md, edit-snippet.md, edit-guidelines.md from src/payload-contract.ts");
