import { isRec, has } from "./utils";

function coerceEditsArray(edits: unknown): unknown {
	if (typeof edits !== "string") {
		return edits;
	}
	try {
		const parsed: unknown = JSON.parse(edits);
		return Array.isArray(parsed) ? parsed : edits;
	} catch {
		return edits;
	}
}

function coerceNewLines(edits: unknown): unknown {
  if (!Array.isArray(edits)) return edits;
  return edits.map((edit: unknown) => {
    if (!isRec(edit)) return edit;
    if (typeof edit.new_lines !== "string") return edit;
    try {
      const parsed: unknown = JSON.parse(edit.new_lines);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return { ...edit, new_lines: parsed };
      }
    } catch {
      // not valid JSON, leave as-is for downstream validation
    }
    return edit;
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

	const hasEditsField = has(record, "edits");

	if (hasEditsField) {
		record.edits = coerceEditsArray(record.edits);
		record.edits = coerceNewLines(record.edits);
	}

	return record;
}
