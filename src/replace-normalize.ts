import { isRec, has } from "./utils";
import { CONTENT_LINES_NOT_STRING_MSG } from "./constants";

export function tryParseContentLines(record: Record<string, unknown>, key: string): void {
  const val = record[key];
  if (typeof val !== "string") return;
  try {
    const parsed = JSON.parse(val);
    if (Array.isArray(parsed)) {
      record[key] = parsed;
      return;
    }
  } catch {
  }
  throw new Error(CONTENT_LINES_NOT_STRING_MSG);
}

export function normalizeFilePath(record: Record<string, unknown>): void {
  if (typeof record.path !== "string" && typeof record.file_path === "string") {
    record.path = record.file_path;
    delete record.file_path;
  }
}

export function normReq(input: unknown): unknown {
  if (!isRec(input)) {
    return input;
  }

  const record: Record<string, unknown> = { ...input };

  normalizeFilePath(record);

  if (has(record, "content_lines") && typeof record.content_lines === "string") {
    tryParseContentLines(record, "content_lines");
  }

  return record;
}
