/** Markdown section provider: fence-aware ATX headings through the read-expansion seam. */
import { readFile } from "node:fs/promises";
import type { SpanProvider } from "./provider-contract.js";
import { findMarkdownSection } from "./markdown-section.js";

export interface MarkdownSpanProviderOptions {
  /** Override file reading (tests can supply source directly). */
  readTextFile?: (path: string) => Promise<string | undefined>;
}

const MARKDOWN_EXTENSIONS = [".md", ".markdown"];

/** Whether the dispatch provider should route this path to the Markdown scanner. */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function defaultReadText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Build a Markdown section provider; any unreadable or non-Markdown file declines. */
export function createMarkdownSpanProvider(
  options: MarkdownSpanProviderOptions = {},
): SpanProvider {
  const readText = options.readTextFile ?? defaultReadText;
  return {
    async enclosingChain(file, window) {
      if (!("offset" in window) || !("limit" in window)) return { refusal: "provider_declined" };
      if (!isMarkdownPath(file)) return { refusal: "no_provider" };
      const text = await readText(file);
      if (text === undefined) return { refusal: "provider_declined" };
      const section = findMarkdownSection(text, window.offset, window.offset + window.limit - 1);
      if (section === null) return { refusal: "boundary_crossing" };
      return {
        spans: [
          {
            start: section.start,
            end: section.end,
            kind: "section",
            name: section.title,
            source: "md",
          },
        ],
      };
    },
  };
}
