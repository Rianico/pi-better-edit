import { isRec, has } from "./utils";

function assertContentLinesNotString(
  value: unknown,
  label: string,
): void {
  if (typeof value === "string") {
    throw new Error(
      `[E_BAD_SHAPE] ${label}: "content_lines" must be a native JSON array of strings, not a JSON string.`
      + ` Do not serialize the array (e.g. '["line1", "line2"]') — pass it as a proper JSON array: ["line1", "line2"].`
    );
  }
}

export function normalizeFilePath(record: Record<string, unknown>): void {
  if (typeof record.path !== "string" && typeof record.file_path === "string") {
    record.path = record.file_path;
    delete record.file_path;
  }
}

function normalizeField(
  record: Record<string, unknown>,
  from: string,
  to: string,
): void {
  if (!has(record, from)) return;
  const raw = record[from];
  if (Array.isArray(raw)) {
    record[to] = raw;
  } else if (isRec(raw)) {
    record[to] = [raw];
  }
  if (from !== to) delete record[from];
}

export function normReq(input: unknown): unknown {
  if (!isRec(input)) {
    return input;
  }

  const record: Record<string, unknown> = { ...input };

  normalizeFilePath(record);

  // Early validation: reject string-typed content_lines at the top level
  if (has(record, "content_lines") && typeof record.content_lines === "string") {
    assertContentLinesNotString(record.content_lines, "Top-level");
  }

  normalizeField(record, "changes", "changes");
  normalizeField(record, "edits", "changes");

  // Validate items in the changes array before wrapping flat format
  if (Array.isArray(record.changes)) {
    for (let i = 0; i < record.changes.length; i++) {
      const item = record.changes[i];
      if (isRec(item) && has(item, "content_lines") && typeof item.content_lines === "string") {
        assertContentLinesNotString(item.content_lines, `changes[${i}]`);
      }
    }
  }

  if (!Array.isArray(record.changes) && has(record, "hash_range_inclusive") && has(record, "content_lines")) {
    const hri = record.hash_range_inclusive;
    const cl = record.content_lines;
    if (Array.isArray(hri) && Array.isArray(cl)) {
      record.changes = [{ content_lines: cl, hash_range_inclusive: hri }];
      delete record.hash_range_inclusive;
      delete record.content_lines;
    }
  }

  return record;
}
