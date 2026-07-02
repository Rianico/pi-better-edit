import {
	ANCHOR_LEN,
	ALPH_RE,
	HASH_CLASS,
	HL_PREFIX_PLUS_RE,
	DIFF_MINUS_RE,
} from "./hash";

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
			DIFF_MINUS_RE.test(line)
		) {
			throw new Error(
			`[E_INVALID_PATCH] "content_lines" must contain literal file content. Offending line looks like the diff preview's +HASH│ row: ${JSON.stringify(line)}. Use literal file content only — plain + or - lines are written literally.`
			);
		}
	}
}

export function parseText(edit: string[] | string | null): string[] {
	if (edit === null) return [];
	const lines =
		typeof edit === "string"
			? (edit.endsWith("\n") ? edit.slice(0, -1) : edit)
					.replaceAll("\r", "")
					.split("\n")
			: edit;
	assertNoPrefixes(lines);
	return lines;
}
