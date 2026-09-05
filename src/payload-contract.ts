import { Type } from "typebox";
import { EDITS_MAX_ITEMS } from "./constants.js";

const normalizedEdit = Symbol("normalizedEdit");

export type EditItem = {
	anchor_from: string;
	anchor_to: string;
	replace_with: string;
};

export type NormalizedEditRequest = {
	file: string | null;
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

export const replaceWithSchema = Type.String({
	description: 'Bare file content for the range; use "" to delete',
});

export const anchorFromSchema = Type.String({
	description: "Bare 3-char hash anchor of the first range line (inclusive)",
});

export const anchorToSchema = Type.String({
	description: "Bare 3-char hash anchor of the last range line (inclusive)",
});

export const editFileSchema = Type.String({
	minLength: 1,
	description: "Path to the text file to edit (a file, never a directory)",
});

export const editItemSchema = Type.Object(
	{
		anchor_from: anchorFromSchema,
		anchor_to: anchorToSchema,
		replace_with: replaceWithSchema,
	},
	{ additionalProperties: false },
);

export const editToolSchema = Type.Object(
	{
		file: editFileSchema,
		edits: Type.Array(editItemSchema, {
			description: "Ordered list of edit items",
			minItems: 1,
			maxItems: EDITS_MAX_ITEMS,
		}),
	},
	{ additionalProperties: false },
);

const EDIT_PAYLOAD_HINT =
	"Edit must be called with exactly one payload. Use the canonical payload " +
	'{"file": file, "edits": [{ "anchor_from": anchor_from, "anchor_to": anchor_to, "replace_with": replace_with }, ...]}: ' +
	'"file" is the text file to edit (a non-empty string, never a directory); each item names ' +
	"two inclusive bare-3-char anchors and the full replacement " +
	"(an empty string deletes the range).";
export const EDIT_DESCRIPTION =
	'Edit a range of lines in a text file via `edit`: `{ "file": file, "edits": [{ "anchor_from": a, "anchor_to": b, "replace_with": text }, ...] }` (arity = edits.length, atomic, one file per call). Use `edit` for content seen via `read` or a diff; never for directories, binary files, or images. `anchor_from`/`anchor_to` are bare 3-char HASH anchors (e.g. "wUp") — copy the 3 chars before `│` in served `HASH│content` lines, never `│` or content. `replace_with` is bare content (`\\n` joins lines, `""` deletes). Example: `{"file":"s.py","edits":[{"anchor_from":"wUp","anchor_to":"AU6","replace_with":"x:\\n    y"}]}`. Chain from diff anchors (no re-read). `[MODEL]` in `content` is your retry instruction; dimmed `[USER]` in `details` is human info.';
export const EDIT_SNIPPET =
	'Edit a file range via `edit`: `{"file":file,"edits":[{"anchor_from":a,"anchor_to":b,"replace_with":text}]}` — anchors are bare 3-char HASHes copied from served `HASH│content` (never copy `│`), `replace_with` is bare content (`""` deletes). Chain from diff anchors with no re-read.';
export const EDIT_GUIDELINES: string[] = [
	'edit: `anchor` vs `HASH│content` — an `anchor` is a bare 3-char content hash (e.g. "wUp"); a `HASH│content` line (e.g. `wUp│    pass`) is a served row; the `│` is a separator — copy only the 3 chars before it into `anchor_from`/`anchor_to`, and never emit `│` anywhere in your call.',
	'edit: payload shape `{ "file": file, "edits": [{ "anchor_from": a, "anchor_to": b, "replace_with": text }, ...] }` — `file` is the text file (never a directory); `edits` length is the arity (1 = single, >1 = batched atomically to the one file).',
	"edit: `anchor_from`/`anchor_to` bound the inclusive range (both lines replaced); when an anchor no longer matches, re-read the file and copy fresh anchors.",
	'edit: `replace_with` is plain file content — join lines with `\\n`, mirror trailing blank lines, use `""` to delete the range; write no `HASH│` prefixes (the call is refused when a line echoes a served anchor).',
	"edit: after success the diff serves fresh `HASH│content` rows — copy new anchors from there for your next call; no re-read.",
	"edit: a `[MODEL]` line in `content` is your retry instruction — follow it from the message alone; a dimmed `[USER]` line in `details` is human info, never your error.",
	"edit: batch independent ranges via one `edits` array — the call is atomic (any failure writes nothing).",
	"edit: out-of-band writes (`bash`, scripts, formatters) bypass serve recording — your next `edit` correctly reports their lines as changed; re-read to sync.",
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
hint: EDIT_PAYLOAD_HINT,
	};
}

function emitFilePathDeprecationWarning(
	filePathValue: unknown,
	context: string = "payload",
): void {
	console.warn(
	`[DEPRECATED] "file_path" is deprecated, use "file" instead (${context}). Received file_path=${JSON.stringify(filePathValue)}. This alias will be removed in a future version.`,
	);
}

function itemFromTuple(value: unknown): EditItem | undefined {
	if (!Array.isArray(value) || value.length !== 3) return undefined;
	const [anchor_from, anchor_to, replace_with] = value;
	if (
		typeof anchor_from !== "string" ||
		typeof anchor_to !== "string" ||
		typeof replace_with !== "string"
	) {
		return undefined;
	}
	return { anchor_from, anchor_to, replace_with };
}

const ITEM_KS = new Set(["anchor_from", "anchor_to", "replace_with"]);
const LEGACY_ITEM_KS = new Set([
	"remove_from",
	"remove_to",
	"replacement_text",
]);

function itemFrom(value: unknown): EditItem | undefined {
	if (Array.isArray(value)) return itemFromTuple(value);
	if (!isRec(value)) return undefined;
	const keys = new Set(Object.keys(value));
	if (keys.size === ITEM_KS.size && [...ITEM_KS].every((k) => keys.has(k))) {
		const { anchor_from, anchor_to, replace_with } = value;
		if (
			typeof anchor_from !== "string" ||
			typeof anchor_to !== "string" ||
			typeof replace_with !== "string"
		) {
			return undefined;
		}
		return { anchor_from, anchor_to, replace_with };
	}
	if (keys.size === LEGACY_ITEM_KS.size && [...LEGACY_ITEM_KS].every((k) => keys.has(k))) {
		const { remove_from, remove_to, replacement_text } = value as Record<
			string,
			unknown
		>;
		if (
			typeof remove_from !== "string" ||
			typeof remove_to !== "string" ||
			typeof replacement_text !== "string"
		) {
			return undefined;
		}
		return {
			anchor_from: remove_from,
			anchor_to: remove_to,
			replace_with: replacement_text,
		};
	}
	return undefined;
}

function sanitizePath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let s = value.trim();
	// WHY: Gemma 4 bleed: model may wrap path in <|>, │, |, quotes, or backticks due to │ confusion — see via https://github.com/Rianico/pi-better-edit/issues/55
	// WHY: Strip leading/trailing wrappers iteratively — model may re-wrap after slice, see sanitizePath
	let changed = true;
	while (changed) {
		changed = false;
		if (s.startsWith("<|>") && s.endsWith("<|>") && s.length > 6) {
			s = s.slice(3, -3).trim();
			changed = true;
		}
		if (s.startsWith("│") && s.endsWith("│") && s.length > 2) {
			s = s.slice(1, -1).trim();
			changed = true;
		}
		if (s.startsWith("|") && s.endsWith("|") && s.length > 2) {
			s = s.slice(1, -1).trim();
			changed = true;
		}
		if (
			(s.startsWith('"') && s.endsWith('"')) ||
			(s.startsWith("'") && s.endsWith("'")) ||
			(s.startsWith("`") && s.endsWith("`"))
		) {
			s = s.slice(1, -1).trim();
			changed = true;
		}
		if (s.startsWith("<|>")) {
			s = s.slice(3).trim();
			changed = true;
		}
		if (s.endsWith("<|>")) {
			s = s.slice(0, -3).trim();
			changed = true;
		}
	}
	return s.length > 0 ? s : null;
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
	const hasFile = "file" in rec;
	if (hasFile) {
		effectivePath = rec.file;
	} else if (hasPath) {
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

	if (typeof effectivePath === "string") {
		const sanitized = sanitizePath(effectivePath);
		if (sanitized === null) return undefined;
		effectivePath = sanitized;
	}

	if (
		effectivePath !== null &&
		(typeof effectivePath !== "string" || (effectivePath as string).length === 0)
	) {
		return undefined;
	}
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	const items: EditItem[] = [];
	for (const item of edits) {
		const normalized = itemFrom(item);
		if (!normalized) return undefined;
		items.push(normalized);
	}
	return { file: effectivePath as string | null, edits: items };
}

export function normReq(input: unknown): NormReqResult {
	const valid = editRequestFrom(input);
	// SAFETY: input is unvalidated at admission — cast to NormReqResult preserves runtime value for caller validation, narrowed by editRequestFrom returning undefined for invalid
	if (!valid) return input as NormReqResult;
	const record = { file: valid.file, edits: valid.edits };
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
		return `Received: ${truncated}… (+truncated, full file+edits in tool input)`;
	}
	return `Received: ${json}`;
}

export function prepareEditArguments(args: unknown): Record<string, unknown> {
	const valid = editRequestFrom(args);
	if (valid) {
		// SAFETY: valid.edits are folded to modern objects (tuples/legacy keys normalized) so the return matches the public schema
		return { file: valid.file, edits: valid.edits as unknown };
	}
	throw new Error(
		`[MODEL] [E_BAD_PAYLOAD] ${EDIT_PAYLOAD_HINT} ${describeReceived(args)}`,
	);
}

export function getPreviewInput(
	args: unknown,
): { file: string | null; edits: EditItem[] } | null {
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
			`[MODEL] [E_BAD_PAYLOAD] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.${suffix}`,
		);
	}
}

const ROOT_KS = new Set(["file", "edits"]);

export function assertReq(
	request: unknown,
): asserts request is NormalizedEditRequest {
	if (!isNormalizedEdit(request)) {
		throw new Error(
			"[MODEL] [E_BAD_PAYLOAD] Edit request must be exactly { file, edits: [{ anchor_from, anchor_to, replace_with }, ...] }. " +
			EDIT_PAYLOAD_HINT,
		);
	}

	rejectUnknownFields(request, ROOT_KS, "Edit request", "Pass \"file\" (the text file to edit) and \"edits\".");

	if (
		request.file !== null &&
		(typeof request.file !== "string" || request.file.length === 0)
	) {
		throw new Error(
			'[MODEL] [E_BAD_PAYLOAD] Edit request "file" must be a non-empty string naming the text file to edit (never a directory).',
		);
	}

	if (!Array.isArray(request.edits) || request.edits.length === 0) {
		throw new Error(
			'[MODEL] [E_BAD_PAYLOAD] Edit request requires a non-empty "edits" array.',
		);
	}

	for (let index = 0; index < request.edits.length; index++) {
		const item = request.edits[index]!;
		if (
			typeof item.anchor_from !== "string" ||
			typeof item.anchor_to !== "string" ||
			typeof item.replace_with !== "string"
		) {
			throw new Error(
				`[MODEL] [E_BAD_PAYLOAD] Edit request edits[${index}] must be { anchor_from, anchor_to, replace_with }: two bare 3-char anchors and the replacement text.`,
			);
		}
	}
}
