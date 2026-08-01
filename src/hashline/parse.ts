import {
	ANCHOR_LEN,
	ALPH_RE,
	HL_PREFIX_PLUS_RE,
	HL_PREFIX_MINUS_RE,
	DIFF_MINUS_RE,
} from "./hash";
import { CONTENT_LINES_NOT_STRING_MSG } from "../constants";
import { clipLine } from "../utils";

export type Anchor = { hash: string };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a 3-char base64 anchor (e.g. "aB3").`;
	}

	if (/^\d+/.test(trimmed)) {
		return `[E_BAD_REF] Invalid anchor. Use the hash alone (e.g. "aB3") — no line numbers or trailing content.`;
	}

	if (trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${trimmed}". hash_range_inclusive must contain the 3-char hash only — remove everything from "│" onward.`;
	}

	return `[E_BAD_REF] Invalid anchor "${trimmed}". Expected a 3-char base64 anchor (e.g. "aB3").`;
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

function assertNoPrefixes(lines: string[]): void {
	for (const line of lines) {
		if (!line.length) continue;
		if (
			HL_PREFIX_PLUS_RE.test(line) ||
			HL_PREFIX_MINUS_RE.test(line) ||
			DIFF_MINUS_RE.test(line)
		) {
			throw new Error(
			`[E_INVALID_PATCH] "content_lines" must contain literal file content. Offending line looks like a diff preview row (e.g. +HASH│ or -HASH│): ${JSON.stringify(clipLine(line))}. Use literal file content only — plain + or - lines are written literally.`
			);
		}
	}
}

export function parseText(edit: string[] | string | null): string[] {
  if (edit === null) return [];
  if (typeof edit === "string") {
    throw new Error(CONTENT_LINES_NOT_STRING_MSG);
  }
  assertNoPrefixes(edit);
  return edit;
}
