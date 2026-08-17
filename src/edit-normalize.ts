import { isRec } from "./utils";

export const normalizedEdit = Symbol("normalizedEdit");

export function normReq(input: unknown): unknown {
	let tuple: unknown;
	if (Array.isArray(input)) {
		tuple = input;
	} else if (isRec(input) && Object.keys(input).length === 1 && "edit" in input) {
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

export function isNormalizedEdit(input: unknown): input is Record<string, unknown> {
	return isRec(input) && (input as Record<string | symbol, unknown>)[normalizedEdit] === true;
}
