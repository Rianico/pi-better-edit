import {
	ANCHOR_LEN,
	ALPH_RE,
	HASH_CLASS,
} from "./hash-identity";
import { NEW_CONTENT_NOT_STRING_MSG } from "../constants";

export type Anchor = { hash: string };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a 3-char alphanumeric anchor (e.g. "aB3").`;
	}

	if (/^\d+/.test(trimmed)) {
		return `[E_BAD_REF] Invalid anchor. Use the hash alone (e.g. "aB3") — no line numbers or trailing content.`;
	}

	if (trimmed.includes("│") && trimmed.includes("\n")) {
		const lines = trimmed.split("\n");
		const first = lines[0] ?? "";
		const last = lines[lines.length - 1] ?? "";
		const hashRe = new RegExp(HASH_CLASS);
		const firstMatch = first.match(hashRe);
		const lastMatch = last.match(hashRe);
		const firstHash = firstMatch?.[0] ?? "wUp";
		const lastHash = lastMatch?.[0] ?? "AU6";
		const preview = first.slice(0, 60);
		return `[E_BAD_REF] Invalid anchor — remove_from must be a single bare 3-char hash (e.g. "wUp"), not a block with HASH│. Received ${lines.length} lines starting "${preview}…" — use only the first hash "${firstHash}" as remove_from and "${lastHash}" as remove_to, and put the new content (without HASH│) in replacement_text.`;
	}
	if (trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${trimmed}". remove_from and remove_to must contain the 3-char hash only — remove everything from "│" onward.`;
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

export function parseText(edit: string): string[] {
  if (typeof edit !== "string") {
    throw new Error(NEW_CONTENT_NOT_STRING_MSG);
  }
  const normalized = edit.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  if (/^\n+$/.test(normalized)) return new Array(normalized.length).fill("");
  return normalized.split("\n");
}
