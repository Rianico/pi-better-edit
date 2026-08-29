import { Type } from "typebox";
import { EDITS_MAX_ITEMS } from "./constants.js";

const normalizedEdit = Symbol("normalizedEdit");

export type EditItem = {
	remove_from: string;
	remove_to: string;
	replacement_text: string;
};

export type NormalizedEditRequest = {
	path: string | null;
	edits: EditItem[];
};

type NormalizedPayload = NormalizedEditRequest & {
	readonly [normalizedEdit]: true;
};

type RawPayload =
	| string
	| number
	| boolean
	| null
	| undefined
	| Record<string, unknown>;

export type NormReqResult = NormalizedPayload | RawPayload;

function isRec(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedEdit(input: unknown): input is Record<string, unknown> {
	return (
		isRec(input) &&
		(input as Record<string | symbol, unknown>)[normalizedEdit] === true
	);
}

export const replacementTextSchema = Type.String({
	description: 'Complete replacement for the range; use "" to delete',
});

export const removeFromSchema = Type.String({
	description: "First line to remove (inclusive)",
});

export const removeToSchema = Type.String({
	description: "Last line to remove (inclusive)",
});

const editPathSchema = Type.Union([
	Type.String({
		minLength: 1,
		description: "File path; null infers it from anchors",
	}),
	Type.Null(),
]);

export const editTupleSchema = Type.Tuple(
	[removeFromSchema, removeToSchema, replacementTextSchema],
	{
		description: "[remove_from, remove_to, replacement_text]",
	},
);

export const editToolSchema = Type.Object(
	{
		path: editPathSchema,
		edits: Type.Array(editTupleSchema, {
			description: "Ordered list of edit tuples",
			minItems: 1,
			maxItems: EDITS_MAX_ITEMS,
		}),
	},
	{ additionalProperties: false },
);

const EDIT_TUPLE_HINT =
	"Edit must be called with exactly one payload. Use the canonical payload " +
	'{"path": path, "edits": [[remove_from, remove_to, replacement_text], ...]}: ' +
	"path is a non-empty string (or null to infer from anchors), each item is a " +
	"fixed 3-position array of two inclusive bare-3-char anchors and the full " +
	"replacement (an empty string deletes the range).";

export const EDIT_DESCRIPTION =
	'Edit a range of lines in a text file with `{ "path": path, "edits": [[remove_from, remove_to, replacement_text], ...] }`. `path` is the file path or `null`. `read` returns `HASH│content` (e.g. `wUp│    "site": {`) — for `edit`, `remove_from`/`remove_to` are HASH anchors (bare 3-char value before `│`, e.g. "wUp", "AU6"), never `HASH│content` or line content. `replacement_text` is bare content without `HASH│`, lines joined by \\n (e.g. "    "site": {\\n        "class": SiteScraper,"); use "" to delete. Example: read shows `wUp│    "site": {` + `AU6│        "name": "old",` → edit `{"path":"scrape.py","edits":[["wUp","AU6","    "site": {\\n        "class": SiteScraper,"]]}`. Edits in one call apply atomically; after success reuse `HASH│content` from the returned diff for the next edit (no re-read needed). On failure follow the error hint.';

export const EDIT_SNIPPET =
	'Edit with `{ "path": path, "edits": [[remove_from, remove_to, replacement_text], ...] }` — `remove_from`/`remove_to` are bare 3-char `HASH` anchors (e.g. "aB3"), `replacement_text` is bare content (no `HASH│`). `read` → `wUp│    "site": {` vs `edit` → `{"path":"scrape.py","edits":[["wUp","AU6","    "site": {\\n        "class": SiteScraper,"]]}`. After success chain from diff `HASH│content` (no re-read); on error follow hint — `no read needed` → retry from echo, `re-read` → call `read`.';

export const EDIT_GUIDELINES: string[] = [
	'edit: `HASH` vs `HASH│content` — `HASH` is the bare 3-char (e.g. "wUp"), `HASH│content` is the full line from `read`/`diff` (e.g. `wUp│    "site": {`); never mix them.',
	"edit: get `remove_from`/`remove_to` by copying only the 3 chars before `│` from `read` output — never include `│` or content after it.",
	'edit: `replacement_text` is plain file content without `HASH│` — e.g. "    "site": {\\n        "class": SiteScraper," — never prefix lines with `HASH│`.',
	'edit: every `\\n` in `replacement_text` separates lines; mirror trailing blank lines explicitly (use "" to delete a range).',
	"edit: after a successful edit the returned diff shows fresh anchors (`HASH│content`) — copy new `HASH` values from there for the next edit; no need to re-read.",
	"edit: `remove_from`/`remove_to` are inclusive; batch multiple edits to the same file only when independent — they apply atomically (fail → nothing written).",
];

function _getPayloadPromptFragments(): {
	description: string;
	snippet: string;
	guidelines: string[];
	hint: string;
} {
	return {
		description: EDIT_DESCRIPTION,
		snippet: EDIT_SNIPPET,
		guidelines: [...EDIT_GUIDELINES],
		hint: EDIT_TUPLE_HINT,
	};
}

function emitFilePathDeprecationWarning(
	filePathValue: unknown,
	context: string = "payload",
): void {
	console.warn(
		`[DEPRECATED] "file_path" is deprecated, use "path" instead (${context}). Received file_path=${JSON.stringify(filePathValue)}. This alias will be removed in a future version.`,
	);
}

function _normalizeFilePathRecord(
	record: Record<string, unknown>,
	context: string = "payload",
): boolean {
	if (typeof record.path !== "string" && typeof record.file_path === "string") {
		const fp = record.file_path as string;
		emitFilePathDeprecationWarning(fp, context);
		record.path = fp;

		delete record.file_path;
		return true;
	}
	if (typeof record.file_path === "string") {
		emitFilePathDeprecationWarning(record.file_path, context);

		delete record.file_path;
		return true;
	}
	if ("file_path" in record) {
		if (record.file_path !== undefined) {
			emitFilePathDeprecationWarning(record.file_path, context);
		}

		delete record.file_path;
		return true;
	}
	return false;
}

function itemFromTuple(value: unknown): EditItem | undefined {
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
	if (!isRec(input)) return undefined;
	const rec = input as Record<string, unknown>;
	const hasFilePath = "file_path" in rec;
	const hasPath = "path" in rec;
	if (hasFilePath) {
		emitFilePathDeprecationWarning(rec.file_path, "edit payload");
	}
	let effectivePath: unknown;
	if (hasPath) {
		effectivePath = rec.path;
		if (
			(typeof effectivePath !== "string" && effectivePath !== null) ||
			(effectivePath === undefined && typeof rec.file_path === "string")
		) {
			if (typeof rec.file_path === "string") {
				effectivePath = rec.file_path;
			}
		}
	} else if (hasFilePath) {
		effectivePath = rec.file_path;
	} else {
		return undefined;
	}

	if (!("edits" in rec)) return undefined;
	const edits = rec.edits;

	if (
		effectivePath !== null &&
		(typeof effectivePath !== "string" || (effectivePath as string).length === 0)
	) {
		return undefined;
	}
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	const items: EditItem[] = [];
	for (const item of edits) {
		const normalized = itemFromTuple(item);
		if (!normalized) return undefined;
		items.push(normalized);
	}
	return { path: effectivePath as string | null, edits: items };
}

export function normReq(input: unknown): NormReqResult {
	const valid = editRequestFrom(input);
	// SAFETY: input is unvalidated at admission — cast to NormReqResult preserves runtime value for caller validation, narrowed by editRequestFrom returning undefined for invalid
	if (!valid) return input as NormReqResult; // SAFETY: input unvalidated at admission, preserves runtime value for caller validation
	const record = { path: valid.path, edits: valid.edits };
	Object.defineProperty(record, normalizedEdit, {
		value: true,
		enumerable: false,
	});
	return record;
}

function describeReceived(input: unknown): string {
	if (input === undefined) return "Received no arguments.";
	if (input === null) return "Received null.";
	if (typeof input === "string")
		return `Received a bare string (${JSON.stringify(input)}).`;
	const json = JSON.stringify(input);
	if (typeof json === "string" && json.length > 600) {
		const truncated = json.slice(0, 600);
		return `Received: ${truncated}… (+truncated, full path+edits in tool input)`;
	}
	return `Received: ${json}`;
}

export function prepareEditArguments(args: unknown): Record<string, unknown> {
	const valid = editRequestFrom(args);
	if (valid) {
		const original = args as Record<string, unknown>;
		return { path: valid.path, edits: original.edits as unknown };
	}
	throw new Error(`[E_BAD_SHAPE] ${EDIT_TUPLE_HINT} ${describeReceived(args)}`);
}

export function getPreviewInput(
	args: unknown,
): { path: string | null; edits: EditItem[] } | null {
	const req = editRequestFrom(args);
	if (!req) return null;
	return req;
}

function rejectUnknownFields(
	obj: Record<string, unknown>,
	allowed: Set<string>,
	label: string,
	hint?: string,
): void {
	const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		const suffix = hint ? ` ${hint}` : "";
		throw new Error(
			`[E_BAD_SHAPE] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.${suffix}`,
		);
	}
}

const ROOT_KS = new Set(["path", "edits"]);

export function assertReq(
	request: unknown,
): asserts request is NormalizedEditRequest {
	if (!isNormalizedEdit(request)) {
		throw new Error(
			"[E_BAD_SHAPE] Edit request must be exactly { path, edits: [[remove_from, remove_to, replacement_text], ...] }.",
		);
	}

	rejectUnknownFields(request, ROOT_KS, "Edit request");

	if (
		request.path !== null &&
		(typeof request.path !== "string" || request.path.length === 0)
	) {
		throw new Error(
			"[E_BAD_SHAPE] Edit request path must be a non-empty string or null.",
		);
	}

	if (!Array.isArray(request.edits) || request.edits.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires a non-empty "edits" array.',
		);
	}

	for (let index = 0; index < request.edits.length; index++) {
		const item = request.edits[index]!;
		if (
			typeof item.remove_from !== "string" ||
			typeof item.remove_to !== "string" ||
			typeof item.replacement_text !== "string"
		) {
			throw new Error(
				`[E_BAD_SHAPE] Edit request edits[${index}] must be a three-position array [remove_from, remove_to, replacement_text].`,
			);
		}
	}
}
