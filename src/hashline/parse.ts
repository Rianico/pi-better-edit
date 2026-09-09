import { ANCHOR_LEN, ALPHA_RE, HASH_CLASS } from "./hash-identity.js";
import { NEW_CONTENT_NOT_STRING_MSG } from "../constants.js";

export type Anchor = { hash: string };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[MODEL] [E_BAD_ANCHOR] Invalid anchor. Expected a 3-char alphanumeric anchor (e.g. "aB3").`;
	}

	if (/^\d+/.test(trimmed)) {
		return `[MODEL] [E_BAD_ANCHOR] Invalid anchor. Use the hash alone (e.g. "aB3") — no line numbers or trailing content.`;
	}

	if (trimmed.includes("│") && trimmed.includes("\n")) {
		const lines = trimmed.split("\n");
		const first = lines[0] ?? "";
		const last = lines.at(-1) ?? "";
		// SAFETY: HASH_CLASS is trusted constant [A-Za-z0-9]{3}, bounded 3-char linear search — no user-controlled pattern, no ReDoS.
		const hashRe = new RegExp(HASH_CLASS);
		const firstMatch = first.match(hashRe);
		const lastMatch = last.match(hashRe);
		const firstHash = firstMatch?.[0] ?? "wUp";
		const lastHash = lastMatch?.[0] ?? "AU6";
		const preview = first.slice(0, 60);
		return `[MODEL] [E_BAD_ANCHOR] Invalid anchor — anchor_from must be a single bare 3-char hash (e.g. "wUp"), not a block with HASH│. Received ${lines.length} lines starting "${preview}…" — use only the first hash "${firstHash}" as anchor_from and "${lastHash}" as anchor_to, and put the new content (without HASH│) in replace_with. Nothing was written.`;
	}
	if (trimmed.includes("│")) {
		return `[MODEL] [E_BAD_ANCHOR] Invalid anchor "${trimmed}". anchor_from and anchor_to must contain the 3-char hash only — remove everything from "│" onward. Nothing was written.`;
	}

	return `[MODEL] [E_BAD_ANCHOR] Invalid anchor "${trimmed}". Expected a 3-char alphanumeric anchor (e.g. "aB3").`;
}

function parseRef(ref: string): Anchor {
	const trimmed = ref.trim();

	if (trimmed.length === ANCHOR_LEN && ALPHA_RE.test(trimmed)) {
		return { hash: trimmed };
	}

	throw new Error(diagRef(ref));
}

export const parseHashRef = parseRef;

export function parseText(edit: string): string[] {
	if (typeof edit !== "string") {
		throw new Error(NEW_CONTENT_NOT_STRING_MSG);
	}
	const normalized = edit.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (normalized === "") return [];
	if (/^\n+$/.test(normalized))
		return Array.from({ length: normalized.length }, () => "");
	return normalized.split("\n");
}
