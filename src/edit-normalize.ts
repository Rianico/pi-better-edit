import { isRec } from "./utils";

export const normalizedEdit = Symbol("normalizedEdit");

export function normReq(input: unknown): unknown {
	let tuple: unknown;
	if (Array.isArray(input)) {
		tuple = input;
	} else if (
		isRec(input) &&
		Object.keys(input).length === 1 &&
		"edit" in input
	) {
		tuple = input.edit;
	} else {
		return input;
	}

	if (!Array.isArray(tuple) || tuple.length !== 3) {
		return input;
	}

	const [path, range, replacement_text] = tuple;
	if (!Array.isArray(range) || range.length !== 2) {
		return input;
	}

	const record: Record<string | symbol, unknown> = {
		path,
		remove_from: range[0],
		remove_to: range[1],
		replacement_text,
	};
	Object.defineProperty(record, normalizedEdit, {
		value: true,
		enumerable: false,
	});
	return record;
}

export function isNormalizedEdit(
	input: unknown,
): input is Record<string, unknown> {
	return (
		isRec(input) &&
		(input as Record<string | symbol, unknown>)[normalizedEdit] === true
	);
}

export const EDIT_TUPLE_HINT =
	"Edit must be called with exactly one edit. Use the canonical payload " +
	'{"edit": [path, [remove_from, remove_to], replacement_text]}: a fixed ' +
	"3-position array where path is a non-empty string (or null to infer from " +
	"anchors), the two anchors are inclusive, and replacement_text is the full " +
	"replacement (an empty string deletes the range).";

function editTupleFrom(value: unknown): unknown[] | undefined {
	if (!Array.isArray(value) || value.length !== 3) return undefined;
	const [path, range, replacement_text] = value;
	if (!Array.isArray(range) || range.length !== 2) return undefined;
	if (path !== null && (typeof path !== "string" || path.length === 0))
		return undefined;
	if (typeof range[0] !== "string" || typeof range[1] !== "string")
		return undefined;
	if (typeof replacement_text !== "string") return undefined;
	return value;
}

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
	let tuple: unknown;
	if (Array.isArray(args)) {
		tuple = args;
	} else if (isRec(args) && "edit" in args) {
		const inner = args.edit;
		if (Array.isArray(inner)) {
			tuple = inner;
		} else if (isRec(inner) && "edit" in inner) {
			tuple = inner.edit;
		} else {
			tuple = undefined;
		}
	} else {
		tuple = undefined;
	}

	const valid = editTupleFrom(tuple);
	if (valid) return { edit: valid };
	throw new Error(`[E_BAD_SHAPE] ${EDIT_TUPLE_HINT} ${describeReceived(args)}`);
}
