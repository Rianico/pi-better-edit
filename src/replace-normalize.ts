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

function normalizeEditItem(item: unknown): unknown {
	if (!isRec(item)) return item;
	const record: Record<string, unknown> = { ...item };
	// Rename old_range to hash_range_incl for backward compatibility
	if (has(record, "old_range") && !has(record, "hash_range_incl")) {
		record.hash_range_incl = record.old_range;
		delete record.old_range;
	}
	return record;
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

	// Normalize each edit item: rename old_range to hash_range_incl
	if (Array.isArray(record.edits)) {
		record.edits = record.edits.map(normalizeEditItem);
	}

	return record;
}