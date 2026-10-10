import { Type } from "typebox";
import { EDITS_MAX_ITEMS } from "./constants.js";
import { DomainError } from "./domain-errors.js";
import { HASH_LEN } from "./hashline/alphabet.js";
import type { EditPlacement } from "./hashline/resolve.js";
import { rejectUnknownFields } from "./utils.js";

const normalizedEdit = Symbol("normalizedEdit");

/**
 * The `text_ref` payload: two inclusive bare anchors bounding a served span, an optional serving
 * `file`, and a REQUIRED `mode` — `"copy"` re-inserts the span bytes, `"cut"` additionally retires
 * them. Both modes apply to this file AND to another served file (ticket-04b): a foreign-source
 * `"cut"` commits the insert and the source retirement as one correlated transaction (ADR-0028).
 */
export type SpanRef = {
  anchor_from: string;
  anchor_to: string;
  file?: string;
  mode: "copy" | "cut";
};

/**
 * Wire item (ticket-04): exactly one payload per item — `text` or `text_ref` — over the inclusive
 * anchor pair, with optional `at` placement. There is no `op` field and no verbs: the key set IS
 * the vocabulary (ADR-0007 line 26; content comes from the copy of another served file, which the
 * wire expresses as `text_ref.file`).
 */
export type EditItem = {
  anchor_from: string;
  anchor_to: string;
  at?: "in-place" | "before" | "after";
  text?: string;
  text_ref?: SpanRef;
};

export type EditMode = "general" | "literal";

/**
 * Internal normalized vocabulary owned by the admission boundary (ticket-01, renamed ticket-04).
 * The wire never names these shapes: `normReq` builds them once from the validated payload and
 * everything downstream consumes the union — the engine switches on `payload.kind` exhaustively.
 */
export type Placement = "in-place" | "before" | "after";

// WHY: (§9.12) the wire `at` union and the engine seam's placement union are one vocabulary by
// WHY: contract, not by copy: this compile-time mutual-assignability assertion fails
// WHY: `pnpm run typecheck` the moment the two unions drift apart.
export const _placementVocabularyAgreement: [
  Placement extends EditPlacement ? true : never,
  EditPlacement extends Placement ? true : never,
] = [true, true];

/** The anchor pair an item targets — placement and payload are relative to its resolved span. */
export type AnchorSpan = { anchor_from: string; anchor_to: string };

export type DesiredContent =
  | { kind: "literal"; text: string }
  | { kind: "reference"; span: SpanRef; mode: "copy" | "cut" }
  | { kind: "empty" };

export type NormalizedEditItem = { target: AnchorSpan; at: Placement; payload: DesiredContent };

export type NormalizedEditRequest = {
  file: string;
  edits: NormalizedEditItem[];
  mode?: EditMode;
};

/** The wire-folded request (the admission analyzer's view): canonical keys, pre-union. */
type PreAdmissionRequest = {
  file: string;
  edits: EditItem[];
  mode?: EditMode;
};
type NormalizedPayload = NormalizedEditRequest & {
  readonly [normalizedEdit]: true;
};

type RawPayload = string | number | boolean | null | undefined | Record<string, unknown>;

export type NormReqResult = NormalizedPayload | RawPayload;

function isRec(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedEdit(input: unknown): input is Record<string, unknown> {
  return isRec(input) && (input as Record<string | symbol, unknown>)[normalizedEdit] === true;
}

export const anchorFromSchema = Type.String({
  description: `Bare ${HASH_LEN}-char hash anchor of the first range line (inclusive)`,
});

export const anchorToSchema = Type.String({
  description: `Bare ${HASH_LEN}-char hash anchor of the last range line (inclusive)`,
});

export const editFileSchema = Type.String({
  minLength: 1,
  description: "Path to the text file to edit (a file, never a directory)",
});

export const editAtSchema = Type.Union(
  [Type.Literal("in-place"), Type.Literal("before"), Type.Literal("after")],
  {
    description:
      'Placement of the payload relative to the resolved target span: "in-place" (default) rewrites the span, "before"/"after" insert at its boundary and require a single-line resolved target',
  },
);

export const textRefSchema = Type.Object(
  {
    anchor_from: anchorFromSchema,
    anchor_to: anchorToSchema,
    file: Type.Optional(
      Type.Union([
        Type.String({
          description:
            'Served file the span is read from; another served file supports both "copy" and "cut" like this file does',
        }),
        Type.Null(),
      ]),
    ),
    mode: Type.Union([Type.Literal("copy"), Type.Literal("cut")], {
      description:
        '"copy" re-inserts the referenced span bytes; "cut" additionally retires them, in the serving file, foreign-source included',
    }),
  },
  { additionalProperties: false },
);

export const editModeSchema = Type.Union([Type.Literal("general"), Type.Literal("literal")], {
  description:
    'How to treat bytes reproducing served rows: "general" refuses them, "literal" declares them as intended file content',
});

// WHY: structurally permissive-but-typed (ticket-04): exactly-one-payload and the finite key sets
// WHY: are owned by the admission analyzer (`itemFrom` + `assertReq`), not by the schema — the
// WHY: schema's `additionalProperties: false` still refuses unknown keys at the pi seam.
export const editItemSchema = Type.Object(
  {
    anchor_from: anchorFromSchema,
    anchor_to: anchorToSchema,
    // WHY: (binary-selection-remediation Option C, ADR-0036) every optional property is declared
    // WHY: NULLABLE so the served schema agrees with admission: `null` reads as absent
    // WHY: (`foldAbsentSlots`). TypeBox's natural union-optional form serialises as
    // WHY: `anyOf: [<schema>, {"type":"null"}]`, the same spelling pi's strict compiler emits
    // WHY: (`makeJsonSchemaNodeStrict`). Required properties stay non-nullable on purpose.
    at: Type.Optional(Type.Union([editAtSchema, Type.Null()])),
    text: Type.Optional(
      Type.Union([
        Type.String({ description: 'Bare file content for the range; use "" to delete' }),
        Type.Null(),
      ]),
    ),
    text_ref: Type.Optional(Type.Union([textRefSchema, Type.Null()])),
  },
  {
    // WHY: (ticket-67, CORRECTION-1) no oneOf/anyOf union here by trade-off: available today, but it would foreclose a future strict constrained-decoding opt-in; admission-time XOR already enforces the rule.
    additionalProperties: false,
    description:
      'Exactly one payload per item: supply "text" or "text_ref", never both (a null in an optional field reads as absent; every anchor and "text_ref.mode" are required).',
  },
);

export const editToolSchema = Type.Object(
  {
    file: editFileSchema,
    edits: Type.Array(editItemSchema, {
      description: "Ordered list of edit items",
      minItems: 1,
      maxItems: EDITS_MAX_ITEMS,
    }),
    mode: Type.Optional(Type.Union([editModeSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

const ITEM_SHAPE =
  "an item is exactly { anchor_from, anchor_to, text[, at] } or { anchor_from, anchor_to, text_ref[, at] }";

const EDIT_PAYLOAD_HINT =
  "Edit must be called with exactly one payload per item. Use the canonical payload " +
  '{"file": file, "edits": [{ "anchor_from": anchor_from, "anchor_to": anchor_to, "text": text }, ...], "mode"?: "general" | "literal"}: ' +
  '"file" is the text file to edit (a non-empty string, never a directory); each item names two inclusive ' +
  `bare-${HASH_LEN}-char anchors and exactly one payload — "text" (bare replacement content; an empty string deletes the ` +
  'range) or "text_ref" ({ anchor_from, anchor_to, file?, mode (required): "copy" | "cut" } — the served span\'s bytes, ' +
  '"file" may name another served file, where both modes apply too); optional "at" is "in-place" (default), ' +
  '"before" or "after" (single-line resolved target only); optional "mode" is "general" (default, reproduced ' +
  'served rows are refused) or "literal" (declared literal content).';
export const EDIT_DESCRIPTION = `Edit a range of lines in a text file via \`edit\`: \`{ "file": file, "edits": [{ "anchor_from": a, "anchor_to": b, "text": text }, ...] }\` (one top-level file per call). For text files seen via \`read\`/diff. \`anchor_from\`/\`anchor_to\` are bare ${HASH_LEN}-char HASH anchors — copy the ${HASH_LEN} chars before \`│\` in this file's served rows (lease (session, file, anchor)), never \`│\` or content. Exactly one payload field per item: \`text\` (\`\\n\` joins lines, \`""\` deletes) or \`text_ref\` \`{anchor_from, anchor_to, mode (required), file?}\` — a served span's bytes (\`mode\` \`"copy"\`|\`"cut"\`; \`file\`=another served file, where \`cut\` retires the span there too); \`at\`: "in-place" (default), "before", "after". A null optional field reads as absent. \`[MODEL]\` in \`content\` is your retry instruction.`;
export const EDIT_SNIPPET = `Edit a file range via \`edit\`: \`{"file":file,"edits":[{"anchor_from":a,"anchor_to":b,"text":text}]}\` — anchors are bare ${HASH_LEN}-char hashes copied from served \`HASH│content\` (never copy \`│\`), one payload per item: \`text\` is bare content (\`""\` deletes) or \`text_ref\` writes a served span (\`"copy"\` keeps the source, \`"cut"\` also retires it — in this file or in the \`file\` it names). \`at\`: "in-place" (default), "before", "after". Chain from diff anchors with no re-read.`;
export const EDIT_GUIDELINES: string[] = [
  `edit: \`anchor\` vs \`HASH│content\` — an \`anchor\` is a bare ${HASH_LEN}-char hash (e.g. "wUpX"); a \`HASH│content\` line (e.g. \`wUpX│    pass\`) is a served row; the \`│\` is a separator — copy only the ${HASH_LEN} chars before it into \`anchor_from\`/\`anchor_to\`.`,
  `edit: give each item two anchors and exactly one payload: \`{ "file": file, "edits": [{ "anchor_from": a, "anchor_to": b, "text": text }, ...] }\` — \`file\` is the text file (never a directory); one item is a single edit, and several items are batched to that one file; choose exactly one payload field per item: the "text" field OR the "text_ref" field, plus optional \`at\`; providing both fields or omitting both fields is refused (a null in an optional field — \`text\`, \`text_ref\`, \`at\`, the top-level \`mode\`, \`text_ref.file\` — reads as absent; a null in a required one — \`file\`, \`edits\`, any anchor, or \`text_ref.mode\` — is refused).`,
  "edit: `anchor_from`/`anchor_to` bound the inclusive range — in-place replaces both boundary lines, while `before`/`after` insert at the boundary instead; out-of-band writes (bash, scripts, formatters) bypass serve recording, so when an anchor no longer matches, re-read the file and copy fresh anchors.",
  'edit: `text` is plain file content — join lines with `\\n`, mirror trailing blank lines, use `""` to delete the range; a line reproducing a served row (served anchor plus its served content) is refused; `text` is verbatim, so include the indentation you want.',
  'edit: place the payload with `at` — "in-place" (default) rewrites it, "before"/"after" insert at its boundary and require a single-line resolved target; `text: ""` with "before"/"after" writes nothing (noop).',
  'edit: `text_ref` `{anchor_from, anchor_to, mode}` writes the bytes of a served span into the target — `mode: "copy"` keeps the source, `mode: "cut"` also retires it; with `file` naming another served file, both modes apply to that file\'s served rows and a `cut` retires the span there in the same call; `mode` is required, never inferred. Prefer `text_ref` to reproduce served bytes exactly or to move them. Use `text` for content you author.',
  "edit: anchors are bound to the file that served them — each anchor's lease is (session, file, anchor), so copy `anchor_from`/`anchor_to` only from the served rows of the file the payload names: this file by default, `text_ref.file` when it names another file.",
  "edit: after success the diff serves fresh `HASH│content` rows — copy new anchors from there for your next call; no re-read. Verify that the returned diff matches your intended mutation.",
  "edit: a `[MODEL] [W_*]` line in `content` is informational — the mutation was applied; a `[MODEL] [E_*]` line is your retry instruction or a rejection — follow it from the message alone; a `[MODEL]` line that presents rows as a fresh read (`Current range (fresh read):`) is not a blind retry — decide from those rows; a dimmed `[USER]` line in `details` is human info, never your error.",
  "edit: batch independent ranges via one `edits` array — every edit validates BEFORE the first rename and any failure there writes nothing; a foreign `cut` writes its files in a fixed order, a defeated rollback restores captured bytes or is repaired on the next run.",
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

function describeReceived(input: unknown): string {
  if (input === undefined) return "Received no arguments.";
  if (input === null) return "Received null.";
  if (typeof input === "string") return `Received a bare string (${JSON.stringify(input)}).`;
  const json = JSON.stringify(input);
  if (typeof json === "string" && json.length > 600) {
    const truncated = json.slice(0, 600);
    return `Received: ${truncated}… (+truncated, full file+edits in tool input)`;
  }
  return `Received: ${json}`;
}

function quoted(keys: string[]): string {
  return keys.map((key) => `"${key}"`).join(", ");
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

// WHY: (ticket-04 §3) the finite key-set gate: an item is legal only when its key set is EXACTLY
// WHY: one of S1 {anchor_from, anchor_to, text}, S2 = S1 + at, S3 {anchor_from, anchor_to,
// WHY: text_ref}, S4 = S3 + at — set EQUALITY, never superset, so a legacy key, an `op` field,
// WHY: both payloads or neither payload all refuse with the offending keys named.
const ITEM_KEY_SETS: readonly (readonly string[])[] = [
  ["anchor_from", "anchor_to", "text"],
  ["anchor_from", "anchor_to", "at", "text"],
  ["anchor_from", "anchor_to", "text_ref"],
  ["anchor_from", "anchor_to", "at", "text_ref"],
];

function keySetEquals(keys: Set<string>, shape: readonly string[]): boolean {
  if (keys.size !== shape.length) return false;
  return shape.every((key) => keys.has(key));
}

function isLegalItemKeySet(keys: Set<string>): boolean {
  return ITEM_KEY_SETS.some((shape) => keySetEquals(keys, shape));
}

// WHY: bound to the union (§9.12): a list element outside `Placement` fails `pnpm run typecheck`.
const AT_SPELLINGS = ["in-place", "before", "after"] as const satisfies readonly Placement[];

// WHY: (ticket-67) strict structured-output harnesses spell "absent" as an explicit `null`
// WHY: (every property required). Key existence alone then lies: `{ text: "…", text_ref: null }`
// WHY: was refused as carrying both. `null`/`undefined` in the four optional slots (`text`,
// WHY: `text_ref`, `at`, root `mode`) reads as ABSENT wherever presence is decided — one
// WHY: predicate, so the gate, the validators and the normalizers cannot disagree.
// WHY: (ticket-75) the nested reference's optional `file` is the same slot one level down: a
// WHY: harness that must spell an omitted optional property emits `"file": null`, and reading it
// WHY: as present refused a call no retry could satisfy — the #67 class, one object deeper.
function isAbsentValue(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

// WHY: (ticket-75) ONE fold site for the declaration and for the stored item: the item's optional
// WHY: slots and the nested optional `file` fold together, so `analyzeItem` validates exactly the
// WHY: shape `analyzeRequest` stores and nothing downstream can see an absent value as present.
function foldAbsentSlots(item: Record<string, unknown>): Record<string, unknown> {
  const folded: Record<string, unknown> = { ...item };
  for (const key of ["text", "text_ref", "at"] as const) {
    if (isAbsentValue(folded[key])) delete folded[key];
  }
  if (isRec(folded.text_ref)) {
    const reference: Record<string, unknown> = { ...folded.text_ref };
    if (isAbsentValue(reference.file)) delete reference.file;
    folded.text_ref = reference;
  }
  return folded;
}
function analyzeItem(value: unknown, index: number): string | undefined {
  if (!isRec(value)) {
    return `edit[${index}] must be an object: ${ITEM_SHAPE}.`;
  }
  // WHY: (ticket-75) `value` arrives already folded by `foldAbsentSlots`: an absent optional slot
  // WHY: is gone, nested `text_ref.file` included, so this key set IS the declaration the gate
  // WHY: reads and no second fold site can disagree with the one that stored the item.
  const keys = new Set(Object.keys(value));
  const hasText = keys.has("text");
  const hasRef = keys.has("text_ref");
  if (!isLegalItemKeySet(keys)) {
    if (hasText && hasRef) {
      return (
        `edit[${index}] carries both "text" and "text_ref" fields: choose exactly one payload field per item (${ITEM_SHAPE}). ` +
        `Choice A (literal content): Keep "text" and delete "text_ref" from the JSON object. ` +
        `Choice B (copy/cut served span): keep "text_ref" and delete "text" from the JSON object.`
      );
    }
    // WHY: (§9.3) an illegal key set is often also MISSING a required key; the unsupported-field
    // WHY: list alone renders blank there, so the refusal must name the missing keys too.
    const payloadKeys = new Set(["anchor_from", "anchor_to", "at", "text", "text_ref"]);
    const offending = [...keys].filter((key) => !payloadKeys.has(key));
    const missing = ["anchor_from", "anchor_to"].filter((key) => !keys.has(key));
    const clauses: string[] = [];
    if (offending.length > 0) clauses.push(`unsupported field(s) ${quoted(offending)}`);
    if (missing.length > 0) clauses.push(`missing required field(s) ${quoted(missing)}`);
    if (!hasText && !hasRef) {
      const named = clauses.length > 0 ? `${clauses.join(";")} — ` : "";
      return (
        `edit[${index}] carries no payload (neither "text" nor "text_ref" fields): ${named}choose exactly one payload field per item (${ITEM_SHAPE}) — ` +
        `supply the "text" field (authored content) OR the "text_ref" field (served span).`
      );
    }
    return `edit[${index}] has ${clauses.join(";")} (${ITEM_SHAPE}).`;
  }
  const { anchor_from, anchor_to, at, text, text_ref } = value;
  if (typeof anchor_from !== "string" || typeof anchor_to !== "string") {
    return `edit[${index}] "anchor_from"/"anchor_to" must be bare ${HASH_LEN}-char hash anchor strings copied from served output (before │): both anchors are required, so null is not a value here.`;
  }
  if (!isAbsentValue(at)) {
    if (at === "in_place") {
      return `edit[${index}] "at" was "in_place" — the canonical spelling is "in-place": "at" must be "in-place", "before" or "after".`;
    }
    if (typeof at !== "string" || !(AT_SPELLINGS as readonly string[]).includes(at)) {
      return `edit[${index}] "at" must be "in-place", "before" or "after" when present.`;
    }
  }
  if (hasText) {
    if (typeof text !== "string") {
      return `edit[${index}] "text" must be a string with \\n line separators, not an array. Use "" to delete the range.`;
    }
    return undefined;
  }
  if (!isRec(text_ref)) {
    return `edit[${index}] "text_ref" must be an object { anchor_from, anchor_to, file?, mode }.`;
  }
  const refKeys = new Set(Object.keys(text_ref));
  if (!refKeys.has("mode")) {
    return `edit[${index}] "text_ref" requires "mode": "copy" or "cut".`;
  }
  const refBase = new Set(["anchor_from", "anchor_to", "file", "mode"]);
  const refOffending = [...refKeys].filter((key) => !refBase.has(key));
  if (refOffending.length > 0) {
    return `edit[${index}] "text_ref" has unsupported field(s) ${quoted(refOffending)}; it is { anchor_from, anchor_to, file?, mode }.`;
  }
  const { mode } = text_ref;
  if (mode !== "copy" && mode !== "cut") {
    return `edit[${index}] "text_ref" "mode" must be "copy" or "cut": "mode" is required, so null is not a value here.`;
  }
  const refFile = text_ref.file;
  if ("file" in text_ref && typeof refFile !== "string") {
    return `edit[${index}] "text_ref" "file" must be a string naming the served file to read from — omit "file" to reference this file.`;
  }
  // WHY: (§9.2) an empty "file" was admitted and only failed deep in the loader as
  // WHY: `[E_UNSUPPORTED_FILE] Path is a directory: .` — the field-level refusal belongs here.
  if (refFile === "") {
    return `edit[${index}] "text_ref" "file" must name a served file to read from — an empty string is not a path (omit "file" to reference this file).`;
  }
  if (typeof text_ref.anchor_from !== "string" || typeof text_ref.anchor_to !== "string") {
    return `edit[${index}] "text_ref" "anchor_from"/"anchor_to" must be bare ${HASH_LEN}-char hash anchor strings copied from the served output of the file they name: both anchors are required, so null is not a value here.`;
  }
  return undefined;
}

// WHY: (remediation-2 B3 → ticket-04b) there was previously a second, LEXICAL "same file" test
// WHY: here that refused foreign `mode: "cut"` at admission. One definition owns the question —
// WHY: the engine's realpath classification (`sameResolvedPath`, mutation-engine/pipeline.ts) —
// WHY: and admission stays a pure shape check: a foreign `cut` is ADMITTED and committed as one
// WHY: correlated transaction (`runCutTransaction`, ADR-0028), witnessed through the entry point
// WHY: by `edit.wire-contract.test.ts` and `edit.foreign-cut.test.ts`. Path identity on the real
// WHY: filesystem belongs to the engine seam.
/**
 * The single admission analyzer shared by `editRequestFrom` (normReq), `prepareEditArguments` and
 * `assertReq` (ticket-04): every entry point rejects the same inputs with the same message, so the
 * tool seam and the engine seam cannot drift apart.
 */
type Admission = { ok: true; request: PreAdmissionRequest } | { ok: false; message: string };

function analyzeRequest(input: unknown): Admission {
  if (!isRec(input)) {
    return { ok: false, message: `${EDIT_PAYLOAD_HINT} ${describeReceived(input)}` };
  }
  const rec = input as Record<string, unknown>;
  const rootBase = new Set(["file", "edits", "mode"]);
  const rootOffending = Object.keys(rec).filter((key) => !rootBase.has(key));
  if (rootOffending.length > 0) {
    return {
      ok: false,
      message:
        `Edit request has unsupported field(s) ${quoted(rootOffending)}; it is exactly ` +
        `{ file, edits: [{ anchor_from, anchor_to, text | text_ref[, at] }, ...], mode?: "general" | "literal" }. ` +
        describeReceived(input),
    };
  }
  let mode: EditMode | undefined;
  if ("mode" in rec && !isAbsentValue(rec.mode)) {
    if (rec.mode !== "general" && rec.mode !== "literal") {
      return {
        ok: false,
        message: `Edit request "mode" must be "general" or "literal" (absent means "general"). ${EDIT_PAYLOAD_HINT}`,
      };
    }
    mode = rec.mode;
  }
  if (!("file" in rec)) {
    return {
      ok: false,
      message: `Edit request requires "file" (the text file to edit). ${EDIT_PAYLOAD_HINT}`,
    };
  }
  const sanitized = sanitizePath(rec.file);
  if (sanitized === null) {
    return {
      ok: false,
      message: `Edit request "file" must be a non-empty string path to a text file. ${EDIT_PAYLOAD_HINT}`,
    };
  }
  if (!("edits" in rec) || !Array.isArray(rec.edits) || rec.edits.length === 0) {
    return {
      ok: false,
      message: `Edit request requires a non-empty "edits" array. ${EDIT_PAYLOAD_HINT}`,
    };
  }
  const file = sanitized;
  const items = rec.edits as unknown[];
  const failures: string[] = [];
  const edited: EditItem[] = [];
  for (let index = 0; index < items.length; index++) {
    // WHY: (ticket-75) fold BEFORE validation, so the item the gate reads is the item stored.
    const raw = items[index];
    const item = isRec(raw) ? foldAbsentSlots(raw) : raw;
    const refusal = analyzeItem(item, index);
    if (refusal !== undefined) {
      failures.push(refusal);
      continue;
    }
    edited.push(item as unknown as EditItem);
  }
  if (failures.length > 0) {
    return { ok: false, message: `${failures.join(" ")} ${describeReceived(input)}` };
  }
  if (mode !== undefined) return { ok: true, request: { file, edits: edited, mode } };
  return { ok: true, request: { file, edits: edited } };
}

export function editRequestFrom(input: unknown): PreAdmissionRequest | undefined {
  const admitted = analyzeRequest(input);
  return admitted.ok ? admitted.request : undefined;
}

function normalizedItemFrom(item: EditItem): NormalizedEditItem {
  const at = item.at ?? "in-place";
  const payload: DesiredContent =
    item.text_ref !== undefined
      ? { kind: "reference", span: item.text_ref, mode: item.text_ref.mode }
      : item.text === ""
        ? { kind: "empty" }
        : { kind: "literal", text: item.text ?? "" };
  return {
    target: { anchor_from: item.anchor_from, anchor_to: item.anchor_to },
    at,
    payload,
  };
}

export function normReq(input: unknown): NormReqResult {
  const admitted = analyzeRequest(input);
  // SAFETY: input is unvalidated at admission — cast to NormReqResult preserves runtime value for caller validation, narrowed by analyzeRequest refusing invalid shapes
  if (!admitted.ok) return input as NormReqResult;
  const items = admitted.request.edits.map(normalizedItemFrom);
  const record: Record<string, unknown> & { file: string; edits: NormalizedEditItem[] } =
    admitted.request.mode !== undefined
      ? { file: admitted.request.file, edits: items, mode: admitted.request.mode }
      : { file: admitted.request.file, edits: items };
  Object.defineProperty(record, normalizedEdit, {
    value: true,
    enumerable: false,
  });
  return record;
}

export function prepareEditArguments(args: unknown): Record<string, unknown> {
  const admitted = analyzeRequest(args);
  if (admitted.ok) {
    return admitted.request as unknown as Record<string, unknown>;
  }
  throw new DomainError("E_BAD_PAYLOAD", { message: admitted.message });
}

export function getPreviewInput(args: unknown): { file: string; edits: EditItem[] } | null {
  const req = editRequestFrom(args);
  if (!req) return null;
  return req;
}

const ROOT_KS = new Set(["file", "edits", "mode"]);

// WHY: bound to the union (§9.12): a list element outside `Placement` fails `pnpm run typecheck`.
const PLACEMENTS = ["in-place", "before", "after"] as const satisfies readonly Placement[];

function isPlacementValue(value: string): value is Placement {
  return (PLACEMENTS as readonly string[]).includes(value);
}

function isNormalizedEditItem(value: unknown): value is NormalizedEditItem {
  if (!isRec(value)) return false;
  const { target, at, payload } = value;
  if (!isRec(target)) return false;
  if (typeof target.anchor_from !== "string" || typeof target.anchor_to !== "string") return false;
  if (typeof at !== "string" || !isPlacementValue(at)) return false;
  if (!isRec(payload)) return false;
  if (payload.kind === "empty") return true;
  if (payload.kind === "literal") return typeof payload.text === "string";
  if (payload.kind === "reference") {
    return (
      isRec(payload.span) &&
      typeof payload.span.anchor_from === "string" &&
      typeof payload.span.anchor_to === "string" &&
      (payload.mode === "copy" || payload.mode === "cut")
    );
  }
  return false;
}

export function assertReq(request: unknown): asserts request is NormalizedEditRequest {
  if (!isNormalizedEdit(request)) {
    // WHY: a raw (un-normalized) request reaching assertReq must hit the SAME finite key-set gate
    // WHY: as `prepareEditArguments` — one analyzer, one refusal message, both entry points.
    const admitted = analyzeRequest(request);
    if (!admitted.ok) {
      throw new DomainError("E_BAD_PAYLOAD", { message: admitted.message });
    }
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        "Edit request must pass through normReq before assertReq: the engine consumes the normalized shape. " +
        EDIT_PAYLOAD_HINT,
    });
  }

  rejectUnknownFields(
    request,
    ROOT_KS,
    "Edit request",
    'Pass "file" (the text file to edit), "edits", and optional "mode" ("general" | "literal").',
  );

  const modeValue = (request as Record<string, unknown>).mode;
  if (modeValue !== undefined && modeValue !== "general" && modeValue !== "literal") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        'Edit request "mode" must be "general" or "literal" (absent means "general"). ' +
        EDIT_PAYLOAD_HINT,
    });
  }

  // WHY: the file was answered at admission (analyzeRequest); the narrowed type carries it here.
  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: 'Edit request requires a non-empty "edits" array.',
    });
  }

  for (let index = 0; index < request.edits.length; index++) {
    const item = request.edits[index];
    if (!isNormalizedEditItem(item)) {
      throw new DomainError("E_BAD_PAYLOAD", {
        message: `Edit request edits[${index}] must be { target, at, payload } with exactly one payload: text content, a served-span reference with mode "copy" or "cut", or a deletion (no content).`,
      });
    }
    // WHY: (ticket-04 item (i), remediation-2 B4) the wire folds `"text": ""` into the deletion
    // WHY: payload, so this guard is a defense for direct `assertReq` callers only; the
    // WHY: enforcement point for the engine seam is the parse guard in
    // WHY: `mutation-engine/pipeline.ts` (`parseEdits`, same message), which `execute()` cannot
    // WHY: bypass. Naming the wire field `"text"` keeps the model-actionable wording.
    if (item.payload.kind === "literal" && item.payload.text === "") {
      throw new DomainError("E_BAD_PAYLOAD", {
        message: `Edit request edits[${index}] "text" must carry at least one line; "text": "" is the deletion payload. Nothing was written.`,
      });
    }
  }
}
