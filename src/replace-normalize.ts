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
 * Returns a warning if any item was a JSON string.
 */
function coerceEditArray(items: unknown[]): { result: unknown[]; warnings: string[] } {
  const warnings: string[] = [];
  const result = items
    .map((item: unknown) => {
      if (typeof item === "string") {
        const parsed = tryParseJSON(item, isRec);
        if (parsed) {
          warnings.push("Edit item was passed as a JSON string instead of a native object. Use native JSON values, not serialized strings.");
          return parsed;
        }
      }
      return item;
    })
    .map((change: unknown) => {
      if (!isRec(change)) return change;
      if (typeof change.content_lines !== "string") return change;
      const parsed = tryParseJSON(change.content_lines, (v): v is string[] =>
        Array.isArray(v) && v.every((i) => typeof i === "string"),
      );
      if (parsed) {
        warnings.push("content_lines was passed as a JSON string inside an edit item. Use a native array of strings.");
        return { ...change, content_lines: parsed };
      }
      return change;
    });
  return { result, warnings };
}

/**
 * Normalizes a field from `from` to `to`: JSON-string arrays → real arrays,
 * single objects → wrapped in array. Shared by the `changes` and `edits`
 * normalization branches.
 * Returns a warning if the field was a JSON string.
 */
function normalizeField(
  record: Record<string, unknown>,
  from: string,
  to: string,
): string | undefined {
  if (!has(record, from)) return undefined;
  const raw = tryParseJSON(record[from], Array.isArray) ?? record[from];
  const wasString = typeof record[from] === "string" && raw !== record[from];
  if (Array.isArray(raw)) {
    const { result, warnings } = coerceEditArray(raw);
    record[to] = result;
    if (warnings.length > 0) {
      return warnings.join(" ");
    }
  } else {
    const single =
      typeof raw === "string"
        ? tryParseJSON(raw, isRec)
        : isRec(raw)
          ? raw
          : undefined;
    if (single) {
      const { result, warnings } = coerceEditArray([single]);
      record[to] = result;
      if (warnings.length > 0) {
        return warnings.join(" ");
      }
    }
  }
  if (from !== to) delete record[from];
  if (wasString) {
    return `Field "${from}" was passed as a JSON string instead of a native array. Use native JSON values, not serialized strings.`;
  }
  return undefined;
}

export function normReq(input: unknown): unknown {
  if (!isRec(input)) {
    return input;
  }

  const record: Record<string, unknown> = { ...input };
  const warnings: string[] = [];

  if (typeof record.path !== "string" && typeof record.file_path === "string") {
    record.path = record.file_path;
    delete record.file_path;
  }

  const w1 = normalizeField(record, "changes", "changes");
  if (w1) warnings.push(w1);
  const w2 = normalizeField(record, "edits", "changes");
  if (w2) warnings.push(w2);

  // Handle flat format: hash_range_inclusive and content_lines at top level
  // (no changes array). Wrap them into a single-element changes array.
  if (!Array.isArray(record.changes) && has(record, "hash_range_inclusive") && has(record, "content_lines")) {
    const hriRaw = record.hash_range_inclusive;
    const hri = tryParseJSON(hriRaw, (v): v is string[] =>
      Array.isArray(v) && v.length === 2 && v.every((i) => typeof i === "string")
    ) ?? hriRaw;
    if (typeof hriRaw === "string" && hri !== hriRaw) {
      warnings.push("hash_range_inclusive was passed as a JSON string instead of a native array. Use native JSON values.");
    }

    const clRaw = record.content_lines;
    const cl = tryParseJSON(clRaw, (v): v is string[] =>
      Array.isArray(v) && v.every((i) => typeof i === "string")
    ) ?? clRaw;
    if (typeof clRaw === "string" && cl !== clRaw) {
      warnings.push("content_lines was passed as a JSON string instead of a native array. Use native JSON values.");
    }

    if (Array.isArray(hri) && Array.isArray(cl)) {
      record.changes = [{ hash_range_inclusive: hri, content_lines: cl }];
      delete record.hash_range_inclusive;
      delete record.content_lines;
    }
  }

  if (warnings.length > 0) {
    (record as Record<string, unknown>)._normWarnings = warnings;
  }

  return record;
}
