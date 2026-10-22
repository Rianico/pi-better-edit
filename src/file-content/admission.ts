/**
 * SAFETY: admission — the read request's admission seam: payload → admitted request → window plan.
 *
 * WHY: this is validation and windowing, not orchestration. `read.ts` runs the tool (prepare → enroll
 * WHY: → recordServes); the rules that decide whether a payload is readable and which lines a file's
 * WHY: windows become belong beside the walker/preview that gives those windows their meaning. The
 * WHY: seam is one-way: the caller imports admission, admission never imports the tool.
 *
 * WHY: every rule here is fail-closed on the same payload error, because a tool call that bypasses the
 * WHY: schema (the exhaustiveness contract tests do) must reach identical wording and identical
 * WHY: refusals as a validated one (ADR-0041).
 */
import { MAX_READ_WINDOWS, MAX_READ_WINDOWS_MESSAGE } from "../constants.js";
import { DomainError } from "../domain-errors.js";
import type { HashStore } from "../hash-store.js";
import { HASH_LEN } from "../hashline/alphabet.js";
import { resolveLineIdentity } from "../hashline/resolve.js";
import { leaseSpanSource } from "../mutation-engine/edit-source.js";
import { assertNever } from "../utils.js";
import { visibleLineTotal, walkLines } from "./line-walker.js";

/** Default `limit` for an `{ offset }` window that names none. */
export const DEFAULT_WINDOW_LIMIT = 50;
/** `radius` default for `around_anchor` (spec §4.1/§4.3). */
export const DEFAULT_ANCHOR_RADIUS = 10;

/** Render mode of one file: `served` (anchored rows) or `verbatim` (plain text, no leases). */
export type RenderMode = "served" | "verbatim";

/** A line window of one file, in the reader's 1-indexed terms (spec §4.1). */
interface OffsetWindow {
  offset: number;
  limit: number;
}

/** A window anchored to a line identity this session served (spec §4.1). */
interface AnchorWindow {
  /** The anchor this window centres on, `${HASH_LEN}` characters wide. */
  anchor: string;
  /** Lines before and after the anchor's line. */
  radius: number;
}

export type RawReadParams = Record<string, unknown>;

/** One admitted window: an offset window, or an anchor window not yet resolved to one. */
type AdmittedWindow =
  | { kind: "offset"; offset: number; limit: number }
  | { kind: "anchor"; anchor: string; radius: number };

export interface AdmittedRequest {
  file: string;
  /** Absent when the request named no windows (`undefined` and `[]` both read from line 1). */
  windows?: AdmittedWindow[];
  mode: RenderMode;
}

function badPayload(message: string): DomainError {
  return new DomainError("E_BAD_PAYLOAD", { message });
}

function positiveInt(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw badPayload(`Read request field "${name}" must be a positive integer.`);
  }
  return value as number;
}

/**
 * Admits a render mode. An out-of-union mode fails closed HERE, not only in schema validation: the
 * tool's exhaustiveness guard (read verbatim's contract test) runs `execute` without a validator.
 */
function admitMode(value: unknown): RenderMode | undefined {
  if (value === undefined) return undefined;
  if (value === "served" || value === "verbatim") return value;
  // WHY: `assertNever` carries the union's exhaustiveness to runtime and keeps the wording the
  // WHY: schema rejection uses for the same payload.
  return assertNever(value as never);
}

function admitWindow(window: unknown, label: string): AdmittedWindow {
  if (window === null || typeof window !== "object") {
    throw badPayload(`Read request field "${label}" must be an object.`);
  }
  const raw = window as RawReadParams;
  if (raw.around_anchor !== undefined) {
    const anchor = raw.around_anchor;
    if (typeof anchor !== "string" || anchor.length !== HASH_LEN) {
      throw badPayload(
        `Read request field "${label}.around_anchor" must be a ${HASH_LEN}-character anchor.`,
      );
    }
    const radius = raw.radius === undefined ? DEFAULT_ANCHOR_RADIUS : raw.radius;
    return { kind: "anchor", anchor, radius: positiveInt(radius, `${label}.radius`) };
  }
  const offset = positiveInt(raw.offset, `${label}.offset`);
  // WHY: an offset with no limit still names a window, so it takes the canonical default size
  const limit =
    raw.limit === undefined ? DEFAULT_WINDOW_LIMIT : positiveInt(raw.limit, `${label}.limit`);
  return { kind: "offset", offset, limit };
}

/**
 * Admission for the flat single-file shape (ADR-0041 D1): validates the file, every window,
 * and the window cap. A payload without `file` was already rejected by the schema; the check
 * below is the safety net for callers that bypass validation.
 */
export function admitReadRequest(params: RawReadParams): AdmittedRequest {
  const mode = admitMode(params.mode) ?? "served";
  const file = params.file;
  if (typeof file !== "string" || file === "") {
    throw badPayload('Read request field "file" must be a non-empty path.');
  }
  const rawWindows = params.windows;
  if (rawWindows !== undefined && !Array.isArray(rawWindows)) {
    throw badPayload('Read request field "windows" must be an array.');
  }
  const windows =
    rawWindows === undefined || rawWindows.length === 0
      ? undefined
      : rawWindows.map((window, windowIndex) => admitWindow(window, `windows[${windowIndex}]`));
  // WHY: the schema's `maxItems` and this guard enforce the same cap for validated and
  // WHY: unvalidated callers alike — window count is what multiplies the auto-read budget.
  if ((windows?.length ?? 0) > MAX_READ_WINDOWS) {
    throw badPayload(MAX_READ_WINDOWS_MESSAGE);
  }
  return { file, ...(windows !== undefined ? { windows } : {}), mode };
}

/** The inline warning one unresolvable anchor window leaves behind (spec §4.3). */
function anchorWarning(anchor: string): string {
  return `[Window warning: Anchor '${anchor}' not found; window omitted]`;
}

/** What one file's requested windows became: the windows to walk, the warnings, and the flags. */
export interface WindowPlan {
  /** The offset windows the preview walks, or `undefined` for a file that named no windows. */
  windows: OffsetWindow[] | undefined;
  /** One warning per unresolvable anchor window, in request order. */
  warnings: string[];
  /** The request named windows but none survived: the file renders its warnings alone. */
  omittedAll: boolean;
}

/** The identity seam an anchor window resolves against: the file's current content and its leases. */
export interface AnchorResolver {
  sessionKey: string;
  absolutePath: string;
  normalized: string;
  store: HashStore;
}

/**
 * Resolves `around_anchor` against the file's ACTIVE lineage for the session (spec §4.3): a served
 * lease names a `line_id`, `resolveLineIdentity` says where that identity lives now, and the window
 * is `line ± radius` clamped to the file. Unknown, expired or foreign anchors all resolve to
 * `undefined` — the caller emits one warning and lets the remaining windows proceed.
 */
function resolveAnchorWindow(
  window: AnchorWindow,
  resolver: AnchorResolver,
): OffsetWindow | undefined {
  const source = leaseSpanSource({
    store: resolver.store,
    sessionKey: resolver.sessionKey,
    absolutePath: resolver.absolutePath,
    content: resolver.normalized,
  });
  const lease = source.leaseFor(window.anchor);
  // WHY: no lease for this file is the whole warning (spec §4.3): an unknown anchor, one this session
  // WHY: holds for another file, and a foreign-generation row all fail closed the same way, and the
  // WHY: specification pins one wording for all three — so no homes lookup is needed to say it.
  if (lease === undefined) return undefined;
  const decision = resolveLineIdentity(lease, source);
  if (decision.kind !== "line") return undefined;
  const totalLines = visibleLineTotal(resolver.normalized, walkLines(resolver.normalized).total);
  if (totalLines === 0) return undefined;
  const start = Math.max(1, decision.line - window.radius);
  const end = Math.min(totalLines, decision.line + window.radius);
  return { offset: start, limit: end - start + 1 };
}

/** Turns a file's requested windows into the offset windows to walk, resolving anchors along the way. */
export function planWindows(
  target: AdmittedRequest,
  resolver: AnchorResolver | undefined,
): WindowPlan {
  const requested = target.windows;
  if (requested === undefined) return { windows: undefined, warnings: [], omittedAll: false };
  const windows: OffsetWindow[] = [];
  const warnings: string[] = [];
  for (const window of requested) {
    if (window.kind === "offset") {
      windows.push({ offset: window.offset, limit: window.limit });
      continue;
    }
    // WHY: an anchor window can only resolve against served lineage; a non-text or anchor-less load
    // WHY: leaves it unresolved, which is the same "not found" the model has to re-read past.
    const resolved = resolver === undefined ? undefined : resolveAnchorWindow(window, resolver);
    if (resolved === undefined) {
      warnings.push(anchorWarning(window.anchor));
      continue;
    }
    windows.push(resolved);
  }
  return { windows, warnings, omittedAll: windows.length === 0 && warnings.length > 0 };
}
