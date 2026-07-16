import { isRec, has } from "./utils";
import { CONTENT_LINES_NOT_STRING_MSG } from "./constants";

function tryParseContentLines(record: Record<string, unknown>, key: string, label: string): void {
  const val = record[key];
  if (typeof val !== "string") return;
  try {
    const parsed = JSON.parse(val);
    if (Array.isArray(parsed)) {
      record[key] = parsed;
      return;
    }
  } catch {
    // fall through to error
  }
  throw new Error(CONTENT_LINES_NOT_STRING_MSG);
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
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        record[to] = parsed;
      } else if (isRec(parsed)) {
        record[to] = [parsed];
      }
    } catch {
      // not valid JSON, leave as-is for downstream validation
    }
  }
  if (from !== to) delete record[from];
}

export function normReq(input: unknown): unknown {
  if (!isRec(input)) {
    return input;
  }

  const record: Record<string, unknown> = { ...input };

  normalizeFilePath(record);

  if (has(record, "content_lines") && typeof record.content_lines === "string") {
    tryParseContentLines(record, "content_lines", "Top-level");
  }

  normalizeField(record, "changes", "changes");
  normalizeField(record, "edits", "changes");

  if (Array.isArray(record.changes)) {
    for (let i = 0; i < record.changes.length; i++) {
      const item = record.changes[i];
      if (isRec(item) && has(item, "content_lines") && typeof item.content_lines === "string") {
        tryParseContentLines(item, "content_lines", `changes[${i}]`);
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
