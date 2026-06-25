import { isRec, has } from "./utils";

function coerceChangesArray(changes: unknown): unknown {
  if (typeof changes !== "string") {
    return changes;
  }
  try {
    const parsed: unknown = JSON.parse(changes);
    return Array.isArray(parsed) ? parsed : changes;
  } catch {
    return changes;
  }
}

function coerceContentLines(changes: unknown): unknown {
  if (!Array.isArray(changes)) return changes;
  return changes.map((change: unknown) => {
    if (!isRec(change)) return change;
    if (typeof change.content_lines !== "string") return change;
    try {
      const parsed: unknown = JSON.parse(change.content_lines);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return { ...change, content_lines: parsed };
      }
    } catch {
      // not valid JSON, leave as-is for downstream validation
    }
    return change;
  });
}

function coerceChangeItems(changes: unknown): unknown {
  if (!Array.isArray(changes)) return changes;
  return changes.map((item: unknown) => {
    if (typeof item !== "string") return item;
    try {
      const parsed: unknown = JSON.parse(item);
      if (isRec(parsed)) return parsed;
    } catch {
      // not valid JSON, leave as-is for downstream validation
    }
    return item;
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
    record.changes = coerceChangesArray(record.changes);
    record.changes = coerceChangeItems(record.changes);
    record.changes = coerceContentLines(record.changes);
  } else if (hasEditsField) {
    // Accept "edits" as an alias for "changes" for backward compatibility
    record.changes = coerceChangesArray(record.edits);
    record.changes = coerceChangeItems(record.changes);
    record.changes = coerceContentLines(record.changes);
    delete record.edits;
  }

  return record;
}
