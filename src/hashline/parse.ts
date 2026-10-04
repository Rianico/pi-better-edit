import { ANCHOR_LEN, ALPHA_RE, HASH_CLASS } from "./hash-identity.js";
import { DomainError } from "../domain-errors.js";

export type Anchor = { hash: string };

function diagPayload(ref: string): { rawAnchor: string; reason: string } {
  const trimmed = ref.trim();

  if (!trimmed.length) {
    return {
      rawAnchor: trimmed,
      reason: `Expected a ${ANCHOR_LEN}-char alphanumeric anchor (e.g. "aB3x")`,
    };
  }

  if (/^\d+/.test(trimmed)) {
    return {
      rawAnchor: trimmed,
      reason: 'Use the hash alone (e.g. "aB3x") — no line numbers or trailing content',
    };
  }

  if (trimmed.includes("│") && trimmed.includes("\n")) {
    const lines = trimmed.split("\n");
    const first = lines[0] ?? "";
    const last = lines.at(-1) ?? "";
    // SAFETY: HASH_CLASS is derived from the trusted alphabet at the configured width, bounded linear search — no user-controlled pattern, no ReDoS.
    const hashRe = new RegExp(HASH_CLASS);
    const firstMatch = first.match(hashRe);
    const lastMatch = last.match(hashRe);
    const firstHash = firstMatch?.[0] ?? "wUpX";
    const lastHash = lastMatch?.[0] ?? "AU6y";
    const preview = first.slice(0, 60);
    return {
      rawAnchor: `${lines.length}-line block starting "${preview}…"`,
      reason:
        `anchor_from must be a single bare ${ANCHOR_LEN}-char hash (e.g. "wUpX"), not a block with HASH│. ` +
        `Received ${lines.length} lines starting "${preview}…" — use only the first hash "${firstHash}" as anchor_from and "${lastHash}" as anchor_to, ` +
        `and put the new content (without HASH│) in text. Nothing was written.`,
    };
  }
  if (trimmed.includes("│")) {
    return {
      rawAnchor: trimmed,
      reason: `anchor_from and anchor_to must contain the ${ANCHOR_LEN}-char hash only — remove everything from "│" onward. Nothing was written.`,
    };
  }

  return {
    rawAnchor: trimmed,
    reason: `Expected a ${ANCHOR_LEN}-char alphanumeric anchor (e.g. "aB3x")`,
  };
}

function parseRef(ref: string): Anchor {
  const trimmed = ref.trim();

  if (trimmed.length === ANCHOR_LEN && ALPHA_RE.test(trimmed)) {
    return { hash: trimmed };
  }

  throw new DomainError("E_MALFORMED_ANCHOR", diagPayload(ref));
}

export const parseHashRef = parseRef;

export function parseText(edit: string): string[] {
  if (typeof edit !== "string") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        '"text" must be a string with \\n line separators, not an array. Do not pass an array of lines — pass the replacement text as one string: "line1\\nline2". Use "" to delete a range. Nothing was written.',
    });
  }
  const normalized = edit.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  if (/^\n+$/.test(normalized)) return Array.from({ length: normalized.length }, () => "");
  return normalized.split("\n");
}
