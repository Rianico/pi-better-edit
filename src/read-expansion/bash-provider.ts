/** Bash function spans from the existing `unbash` parser; no grammar or second parser. */
import { readFile } from "node:fs/promises";
import type { Function as BashFunction, ParsedScript } from "unbash";
import { lineSpanForOffsets } from "./line-arithmetic.js";
import type { SpanProvider } from "./span-expansion.js";

export interface BashSpanProviderOptions {
  /** Override file reading (tests can supply source directly). */
  readTextFile?: (path: string) => Promise<string | undefined>;
}

/** Mirrors the replay corpus's shell family: `.sh`, `.bash`, `.zsh`. */
const SHELL_EXTENSIONS = [".sh", ".bash", ".zsh"];

let unbash: Promise<typeof import("unbash")> | undefined;

/** Load the parser on first shell read; the extension entry stays free of the 52 KB parser. */
function loadUnbash(): Promise<typeof import("unbash")> {
  unbash ??= import("unbash");
  return unbash;
}

/** Whether a path belongs to the existing shell-file family. */
export function isShellPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SHELL_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function defaultReadText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Collect every Function node in the parsed tree, including nested functions. */
function collectFunctions(node: unknown, out: BashFunction[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectFunctions(item, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record["type"] === "Function") out.push(node as BashFunction);
  // WHY: Word.parts is a prototype getter, so Object.entries cannot see command substitutions.
  if (record["type"] === "Word") collectFunctions((record as { parts?: unknown }).parts, out);
  for (const [key, value] of Object.entries(record)) {
    if (key === "source") continue;
    if (value !== null && typeof value === "object") collectFunctions(value, out);
  }
}

/** Whether any node (including nested substitution scripts) reports a parse error. */
function hasParseErrors(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasParseErrors);
  if (node === null || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  const errors = record["errors"];
  if (Array.isArray(errors) && errors.length > 0) return true;
  if (record["type"] === "Word" && hasParseErrors((record as { parts?: unknown }).parts)) {
    return true;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "source") continue;
    if (value !== null && typeof value === "object" && hasParseErrors(value)) return true;
  }
  return false;
}

function functionName(fn: BashFunction): string {
  const value = fn.name.value ?? fn.name.text;
  return value.trim() === "" ? "function" : value.trim();
}

/** Build a provider over the existing parser; errors and unreadable files decline. */
export function createBashSpanProvider(options: BashSpanProviderOptions = {}): SpanProvider {
  const readText = options.readTextFile ?? defaultReadText;
  return {
    async enclosingSpan(file, window) {
      if (!("offset" in window) || !("limit" in window)) return null;
      if (!isShellPath(file)) return null;
      const text = await readText(file);
      if (text === undefined) return null;

      let script: ParsedScript;
      try {
        const { parse } = await loadUnbash();
        script = parse(text);
      } catch {
        return null;
      }
      // WHY: partial parses cannot prove a boundary; criterion 4 fails closed exactly like #202.
      if (hasParseErrors(script)) return null;

      const requestedEnd = window.offset + window.limit - 1;
      const ownedSource = script.source ?? text;
      const functions: BashFunction[] = [];
      collectFunctions(script, functions);

      let best:
        | { startLine: number; endLine: number; name: string; pos: number; byteLength: number }
        | undefined;
      for (const fn of functions) {
        const range = lineSpanForOffsets(ownedSource, fn.pos, fn.end);
        if (range === null) continue;
        if (range.startLine > window.offset || range.endLine < requestedEnd) continue;
        const byteLength = fn.end - fn.pos;
        if (
          best === undefined ||
          range.endLine - range.startLine < best.endLine - best.startLine ||
          (range.endLine - range.startLine === best.endLine - best.startLine &&
            byteLength < best.byteLength) ||
          (range.endLine - range.startLine === best.endLine - best.startLine &&
            byteLength === best.byteLength &&
            fn.pos > best.pos)
        ) {
          best = { ...range, name: functionName(fn), pos: fn.pos, byteLength };
        }
      }
      if (best === undefined) return null;

      return {
        start: best.startLine,
        end: best.endLine,
        kind: "function",
        name: best.name,
        source: "ast",
      };
    },
  };
}
