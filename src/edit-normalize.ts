import { isRec } from "./utils";

export const normalizedEdit = Symbol("normalizedEdit");

export type EditItem = {
	remove_from: string;
	remove_to: string;
	replacement_text: string;
};

export type NormalizedEditRequest = {
	path: string | null;
	edits: EditItem[];
};

export function isNormalizedEdit(
	input: unknown,
): input is Record<string, unknown> {
	return (
		isRec(input) &&
		(input as Record<string | symbol, unknown>)[normalizedEdit] === true
	);
}

export function itemFromTuple(value: unknown): EditItem | undefined {
	if (!Array.isArray(value) || value.length !== 3) return undefined;
	const [remove_from, remove_to, replacement_text] = value;
	if (
		typeof remove_from !== "string" ||
		typeof remove_to !== "string" ||
		typeof replacement_text !== "string"
	) {
		return undefined;
	}
	return { remove_from, remove_to, replacement_text };
}

export function editRequestFrom(
	input: unknown,
): NormalizedEditRequest | undefined {
	if (!isRec(input) || !("path" in input) || !("edits" in input)) {
		return undefined;
	}
	const { path, edits } = input as { path?: unknown; edits?: unknown };
	if (path !== null && (typeof path !== "string" || path.length === 0)) {
		return undefined;
	}
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	const items: EditItem[] = [];
	for (const item of edits) {
		const normalized = itemFromTuple(item);
		if (!normalized) return undefined;
		items.push(normalized);
	}
	return { path: path as string | null, edits: items };
}

export function normReq(input: unknown): unknown {
	const valid = editRequestFrom(input);
	if (!valid) return input;
	const record = { path: valid.path, edits: valid.edits };
	Object.defineProperty(record, normalizedEdit, {
		value: true,
		enumerable: false,
	});
	return record;
}

export const EDIT_TUPLE_HINT =
	"Edit must be called with exactly one payload. Use the canonical payload " +
	'{"path": path, "edits": [[remove_from, remove_to, replacement_text], ...]}: ' +
	"path is a non-empty string (or null to infer from anchors), each item is a " +
	"fixed 3-position array of two inclusive bare-3-char anchors and the full " +
	"replacement (an empty string deletes the range).";

function describeReceived(input: unknown): string {
	if (input === undefined) return "Received no arguments.";
	if (input === null) return "Received null.";
	if (typeof input === "string")
		return `Received a bare string (${JSON.stringify(input)}).`;
	const json = JSON.stringify(input);
	const preview =
		typeof json === "string" && json.length > 160
			? `${json.slice(0, 160)}…`
			: json;
	return `Received: ${preview}`;
}

export function prepareEditArguments(args: unknown): Record<string, unknown> {
	const valid = editRequestFrom(args);
	if (valid) {
		return { path: valid.path, edits: (args as Record<string, unknown>).edits };
	}
	throw new Error(`[E_BAD_SHAPE] ${EDIT_TUPLE_HINT} ${describeReceived(args)}`);
}
