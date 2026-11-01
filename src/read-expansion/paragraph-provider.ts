/** Plain-text paragraph provider with an explicit data-file refusal list. */
import { readFile } from "node:fs/promises";
import type { SpanProvider } from "./span-expansion.js";
import { findParagraph } from "./paragraph-section.js";

export interface ParagraphSpanProviderOptions {
  /** Override file reading (tests can supply source directly). */
  readTextFile?: (path: string) => Promise<string | undefined>;
}

const PLAIN_TEXT_EXTENSIONS = [".txt", ".text"];
const DATA_EXTENSIONS = new Set([".log", ".csv", ".tsv", ".jsonl", ".ndjson"]);

/** `.txt` and `.text` are paragraph-shaped plain text. */
export function isPlainTextPath(path: string): boolean {
  const lower = path.toLowerCase();
  return PLAIN_TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Line-oriented data extensions never get paragraph expansion, regardless of their shape. */
export function isDataPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && DATA_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

async function defaultReadText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Build a paragraph provider; unreadable or non-text files decline. */
export function createParagraphSpanProvider(
  options: ParagraphSpanProviderOptions = {},
): SpanProvider {
  const readText = options.readTextFile ?? defaultReadText;
  return {
    async enclosingSpan(file, window) {
      if (!("offset" in window) || !("limit" in window)) return { refusal: "provider_declined" };
      if (!isPlainTextPath(file)) return { refusal: "no_provider" };
      const text = await readText(file);
      if (text === undefined) return { refusal: "provider_declined" };
      const paragraph = findParagraph(text, window.offset, window.offset + window.limit - 1);
      if (paragraph === null) return { refusal: "boundary_crossing" };
      return {
        start: paragraph.start,
        end: paragraph.end,
        kind: "paragraph",
        name: `lines ${paragraph.start}-${paragraph.end}`,
        source: "text",
      };
    },
  };
}
