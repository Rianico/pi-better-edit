import { isRec, has } from "./utils";

function tryParseJSON<T>(value: unknown, guard: (v: unknown) => v is T): T | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (guard(parsed)) return parsed;
  } catch {}
  return undefined;
}

/**
 * Coerces an array of edit items: JSON-string items → objects,
 * JSON-string content_lines → string arrays. Shared by the `changes`
 * and `edits` normalization branches.
 */
function coerceEditArray(items: unknown[]): unknown[] {
  return items
    .map((item: unknown) => tryParseJSON(item, isRec) ?? item)
    .map((change: unknown) => {
      if (!isRec(change)) return change;
      if (typeof change.content_lines !== "string") return change;
      const parsed = tryParseJSON(change.content_lines, (v): v is string[] =>
        Array.isArray(v) && v.every((i) => typeof i === "string"),
      );
      return parsed ? { ...change, content_lines: parsed } : change;
    });
}

export function normReq(input: unknown): unknown {
  if (!isRec(input)) {
    return input;
  }

  const record: Record<string, unknown> = { ...input };

  if (typeof record.path !== "string" && typeof record.file_path === "string") {
    record.path = record.file_path;
    delete record.file_path;
  }

  const hasChangesField = has(record, "changes");
  const hasEditsField = has(record, "edits");

  if (hasChangesField) {
    const raw = tryParseJSON(record.changes, Array.isArray) ?? record.changes;
    if (Array.isArray(raw)) record.changes = coerceEditArray(raw);
  } else if (hasEditsField) {
    const raw = tryParseJSON(record.edits, Array.isArray) ?? record.edits;
    if (Array.isArray(raw)) record.changes = coerceEditArray(raw);
    delete record.edits;
  }

  return record;
}

