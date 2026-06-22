
import {
	ANCHOR_LENGTH,
	HASH_ALPHABET_RE,
	HASH_CHARS_CLASS,
	HASHLINE_PREFIX_PLUS_RE,
	DIFF_MINUS_RE,
} from "./hash";


export type Anchor = { hash: string };


function diagnoseHashRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a 3-character base64 anchor (e.g. "aB3").`;
	}

	if (/^\d+/.test(trimmed)) {
		return `[E_BAD_REF] Invalid anchor. Use the hash alone (e.g. "aB3") — no line numbers or trailing content.`;
	}

	if (trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${trimmed}". old_range must contain the 3-character hash only — remove everything from "│" onward (including the separator).`;
	}

	return `[E_BAD_REF] Invalid anchor "${trimmed}". Expected a 3-character base64 anchor (e.g. "aB3").`;
}

function parseAnchorRef(ref: string): Anchor {
	const trimmed = ref.trim();

	if (
		trimmed.length === ANCHOR_LENGTH &&
		HASH_ALPHABET_RE.test(trimmed)
	) {
		return { hash: trimmed };
	}

	throw new Error(diagnoseHashRef(ref));
}

export const parseHashRef = parseAnchorRef;


function assertNoDisplayPrefixes(lines: string[]): void {
	for (const line of lines) {
		if (!line.length) continue;
		if (
			HASHLINE_PREFIX_PLUS_RE.test(line) ||
			DIFF_MINUS_RE.test(line)
		) {
			throw new Error(
			`[E_INVALID_PATCH] \"lines\" must contain literal file content, not HASH| or diff prefixes. Offending line: ${JSON.stringify(line)}`
			);
		}
	}
}

export function hashlineParseText(edit: string[] | string | null): string[] {
	if (edit === null) return [];
	const lines =
		typeof edit === "string"
			? (edit.endsWith("\n") ? edit.slice(0, -1) : edit)
					.replaceAll("\r", "")
					.split("\n")
			: edit;
	assertNoDisplayPrefixes(lines);
	return lines;
}
