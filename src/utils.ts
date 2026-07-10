export function isRec(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function has(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

/**
 * Splits text into visible lines, stripping the trailing empty element
 * that `split("\n")` produces when the text ends with "\n".
 *
 * This is the canonical way to get user-visible lines from text.
 * For internal hashing that needs the trailing empty string (e.g.
 * `_lineHashesPure`, `mapStableHashes`, `buildIdx`), use
 * `text.split("\n")` directly with a comment explaining why.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

export function visLines(text: string): string[] {
  return splitLines(text);
}

export function cntLines(text: string): number {
	return visLines(text).length;
}

export function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
  hint?: string,
): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    const suffix = hint ? ` ${hint}` : "";
    throw new Error(
      `[E_BAD_SHAPE] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.${suffix}`,
    );
  }
}

export function cntDiff(diff: string, marker: "+" | "-"): number {
  if (!diff) return 0;
  let count = 0;
  for (const line of diff.split("\n")) {
    if (
      line.startsWith(marker) &&
      !line.startsWith(`${marker}${marker}${marker}`)
    ) {
      count += 1;
    }
  }
  return count;
}
