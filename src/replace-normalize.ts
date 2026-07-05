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

/**
 * Normalizes a field from `from` to `to`: JSON-string arrays → real arrays,
 * single objects → wrapped in array. Shared by the `changes` and `edits`
 * normalization branches.
 */
function normalizeField(
  record: Record<string, unknown>,
  from: string,
  to: string,
): void {
  if (!has(record, from)) return;
  const raw = tryParseJSON(record[from], Array.isArray) ?? record[from];
  if (Array.isArray(raw)) {
    record[to] = coerceEditArray(raw);
  } else {
    const single =
      typeof raw === "string"
        ? tryParseJSON(raw, isRec)
        : isRec(raw)
          ? raw
          : undefined;
    if (single) record[to] = coerceEditArray([single]);
  }
  if (from !== to) delete record[from];
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

  normalizeField(record, "changes", "changes");
  normalizeField(record, "edits", "changes");

  return record;
}

