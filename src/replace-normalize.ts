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
	}


	return record;
}