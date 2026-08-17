import { isRec } from "./utils";

export const normalizedEdit = Symbol("normalizedEdit");

export function normReq(input: unknown): unknown {
	if (!Array.isArray(input)) {
		return input;
	}

	if (input.length !== 3) {
		return input;
	}

	const [path, range, replacement_text] = input;
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
