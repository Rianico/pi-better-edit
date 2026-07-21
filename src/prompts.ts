import { readFileSync } from "fs";

export function loadP(relativePath: string, replacements?: Record<string, string>): string {
  let content = readFileSync(new URL(relativePath, import.meta.url), "utf-8").trim();
  if (replacements) {
    for (const [key, value] of Object.entries(replacements)) {
      content = content.split(`{{${key}}}`).join(value);
    }
  }
  return content;
}

export function loadGuide(relativePath: string, replacements?: Record<string, string>): string[] {
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
