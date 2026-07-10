import { isRec, has } from "./utils";

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

  normalizeField(record, "changes", "changes");
  normalizeField(record, "edits", "changes");

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
