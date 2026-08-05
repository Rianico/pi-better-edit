import {
	ANCHOR_LEN,
	ALPH_RE,
} from "./hash";
import { CONTENT_LINES_NOT_STRING_MSG } from "../constants";

export type Anchor = { hash: string };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a 3-char alphanumeric anchor (e.g. "aB3").`;
	}

	if (/^\d+/.test(trimmed)) {
		return `[E_BAD_REF] Invalid anchor. Use the hash alone (e.g. "aB3") — no line numbers or trailing content.`;
	}

	if (trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${trimmed}". hash_range_inclusive must contain the 3-char hash only — remove everything from "│" onward.`;
	}

	return `[E_BAD_REF] Invalid anchor "${trimmed}". Expected a 3-char alphanumeric anchor (e.g. "aB3").`;
}

function parseRef(ref: string): Anchor {
	const trimmed = ref.trim();

	if (
		trimmed.length === ANCHOR_LEN &&
		ALPH_RE.test(trimmed)
	) {
		return { hash: trimmed };
	}

	throw new Error(diagRef(ref));
}

export const parseHashRef = parseRef;

export function parseText(edit: string[] | string | null): string[] {
  if (edit === null) {
    throw new Error('[E_BAD_SHAPE] "content_lines" must be a string array; use [] to delete a range.');
  }
  if (typeof edit === "string") {
    throw new Error(CONTENT_LINES_NOT_STRING_MSG);
  }
  const lineBreakIndex = edit.findIndex((line) => /[\r\n]/.test(line));
  if (lineBreakIndex >= 0) {
    throw new Error(
      `[E_BAD_SHAPE] "content_lines" entry at index ${lineBreakIndex} contains a \\r or \\n line break. Pass each line as its own array entry.`,
    );
  }
  return edit;
}
