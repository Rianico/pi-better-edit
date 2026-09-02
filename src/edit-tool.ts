/** SAFETY: EditTool — deep module owning the edit Use Case seam.
 *
 * Graded surface: one narrow interface `EditTool { execute, preview }`
 * hides pipeline delegation, path resolution, warnings/drift stitching.
 * Frameworks (pi TUI) never cross this seam — that lives in TuiPresenter.
 * Clean Architecture: Use Cases depend inward only (mutation-engine),
 * never outward to Frameworks.
 *
 * Typed boundaries: validate once at admission (payload-contract via normReq/assertReq),
 * trust inside. Immutable state: never mutates caller-owned request.
 */

import { constants } from "node:fs";
import { parseHashRef } from "./hashline/index.js";
import { findSnapshotPathsByHashes } from "./snapshot-store.js";
import { sessionKeyFor } from "./served-state.js";
import {
	normReq,
	assertReq,
	type NormalizedEditRequest,
} from "./payload-contract.js";
import {
	execute as engineExecute,
	preview as enginePreview,
} from "./mutation-engine/engine.js";
import { isMutationSuccess } from "./mutation-engine/types.js";
import { genDiff } from "./edit-diff.js";
import { buildBatchResult, type BatchSection } from "./edit-response.js";
import type { ProcessedEditFile } from "./mutation-engine/types.js";

export type EditToolContext = {
	cwd: string;
	sessionManager?: { getSessionId(): string };
};

export async function resolveMissingPath(
	request: Record<string, unknown>,
): Promise<{ path: string; warning: string } | undefined> {
	if (typeof request.path === "string") return undefined;
	const from = request.remove_from;
	const to = request.remove_to;
	if (typeof from !== "string" || typeof to !== "string") return undefined;
	const hashes: string[] = [];
	for (const ref of [from, to]) {
		try {
			hashes.push(parseHashRef(ref).hash);
		} catch {
			return undefined;
		}
	}
	let matches: string[];
	try {
		matches = await findSnapshotPathsByHashes(hashes);
	} catch {
		return undefined;
	}
	if (matches.length === 1) {
		return {
			path: matches[0]!,
			warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
		};
	}
	if (matches.length > 1) {
		throw new Error(
			`[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(", ")}. Include the intended path.`,
		);
	}
	return undefined;
}

function toSection(file: ProcessedEditFile): BatchSection {
	return {
		path: file.path,
		originalNormalized: file.originalNormalized,
		result: file.result,
		originalHashes: file.originalHashes,
		resultHashes: file.resultHashes,
		warnings: file.warnings,
		driftNotice: file.driftNotice,
		appliedCount: file.appliedCount,
		noopCount: file.noopCount,
		totalAddedLines: file.totalAddedLines,
		totalRemovedLines: file.totalRemovedLines,
	};
}

export type PreviewResult = { diff: string } | { error: string };

export interface EditTool {
	/** SAFETY: Execute a validated edit; returns pi tool_result or throws on failure. Admission: params validated by normReq/assertReq. */
	execute(
		params: unknown,
		signal: AbortSignal | undefined,
		ctx: EditToolContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
	/** SAFETY: Preview without persisting — mirrors pi's compPreview(request, cwd) */
	preview(request: unknown, cwd: string): Promise<PreviewResult>;
}

export function createEditTool(): EditTool {
	return {
		async execute(params, signal, ctx) {
			const canonical = normReq(params);
			assertReq(canonical);
			let effectiveCanonical = canonical;
			let pathWarning: string | undefined;
			if (canonical.path === null) {
				// SAFETY: canonical validated by assertReq — accessing edits for path inference is trusted inside boundary
				const editsForProbe = (canonical as unknown as { edits: Array<{ remove_from: string; remove_to: string }> }).edits;
				const resolution = await resolveMissingPath({
					path: canonical.path,
					remove_from: editsForProbe[0]?.remove_from,
					remove_to: editsForProbe[0]?.remove_to,
				});
				if (resolution) {
					// SAFETY: Immutable evolve: never mutate caller-owned canonical
					// SAFETY: preserve normalizedEdit brand — re-brand via symbol copy, not normReq (which expects tuple form)
				// SAFETY: symbol brand is untyped at runtime — cast to symbol | undefined validated by getOwnPropertySymbols
				const _sym = Object.getOwnPropertySymbols(canonical)[0] as symbol | undefined;
				// SAFETY: spread preserves NormalizedEditRequest shape — cast to typeof canonical trusted after brand copy
				effectiveCanonical = { ...canonical, path: resolution.path } as typeof canonical;
				if (_sym) Object.defineProperty(effectiveCanonical, _sym, { value: true, enumerable: false });
					pathWarning = resolution.warning;
				}
			}
			assertReq(effectiveCanonical);
			if (effectiveCanonical.path === null) {
				throw new Error("[E_BAD_SHAPE] Edit request path could not be inferred from anchors.");
			}
			// SAFETY: ctx is untyped at pi boundary — cast validated by pi's runtime context shape (cwd + sessionManager)
			const sessionKey = sessionKeyFor(ctx as unknown as { sessionManager?: { getSessionId(): string } });
			// SAFETY: effectiveCanonical is validated NormalizedEditRequest after assertReq — trusted inside boundary
			const result = await engineExecute(effectiveCanonical as NormalizedEditRequest, ctx.cwd, {
				accessMode: constants.R_OK | constants.W_OK,
				// SAFETY: signal is AbortSignal | undefined at pi boundary — runtime check via engine's abortIf
				signal: signal as AbortSignal | undefined,
				sessionKey,
			});
			if (isMutationSuccess(result)) {
				if (pathWarning) {
					// SAFETY: Immutable evolve: create new warnings array and new raw object instead of mutating
					const patchedRaw = { ...result.raw, warnings: [pathWarning, ...(result.raw.warnings ?? [])] };
					const patched = buildBatchResult([toSection(patchedRaw)]);
					// SAFETY: buildBatchResult output is trusted tool_result shape after isMutationSuccess guard
					return patched as { content: Array<{ type: "text"; text: string }>; details: unknown };
				}
				// SAFETY: toolResult is validated by isMutationSuccess discriminated union guard
				return result.toolResult as { content: Array<{ type: "text"; text: string }>; details: unknown };
			}
			throw new Error(result.message);
		},
		async preview(request, cwd) {
			try {
				const normalized = normReq(request);
				assertReq(normalized);
				let effectiveNormalized = normalized;
				let pathWarning: string | undefined;
				// SAFETY: normalized validated by assertReq — path check trusted inside boundary
				if ((normalized as NormalizedEditRequest).path === null) {
					// SAFETY: normalized is validated NormalizedEditRequest — accessing edits for path inference trusted
					const req = normalized as unknown as { edits: Array<{ remove_from: string; remove_to: string }> };
					const resolution = await resolveMissingPath({
						// SAFETY: same validated normalized — path is null here, cast preserves narrowing
						path: (normalized as NormalizedEditRequest).path,
						remove_from: req.edits[0]?.remove_from,
						remove_to: req.edits[0]?.remove_to,
					});
					if (resolution) {
							// SAFETY: Immutable evolve: never mutate caller-owned normalized — re-brand via normReq to preserve normalizedEdit symbol
						// SAFETY: preserve normalizedEdit brand — copy symbol from validated normalized (tuple vs object mismatch prevents normReq)
				// SAFETY: symbol brand is untyped at runtime — cast to symbol | undefined validated by getOwnPropertySymbols
				const _sym2 = Object.getOwnPropertySymbols(normalized)[0] as symbol | undefined;
				// SAFETY: spread preserves NormalizedEditRequest shape — cast to typeof normalized trusted after brand copy
				effectiveNormalized = { ...normalized, path: resolution.path } as typeof normalized;
				if (_sym2) Object.defineProperty(effectiveNormalized, _sym2, { value: true, enumerable: false });
						pathWarning = resolution.warning;
					}
				}
				assertReq(effectiveNormalized);
				// SAFETY: effectiveNormalized is validated NormalizedEditRequest after assertReq
				const result = await enginePreview(effectiveNormalized as NormalizedEditRequest, cwd, {
					accessMode: constants.R_OK,
				});
				if (!isMutationSuccess(result)) {
					return { error: result.message };
				}
				const file = result.raw;
				// SAFETY: Immutable evolve: derive warnings without mutating file
				const effectiveFile = pathWarning ? { ...file, warnings: [pathWarning, ...(file.warnings ?? [])] } : file;
				if (effectiveFile.originalNormalized === effectiveFile.result) {
					return { error: `No changes made to ${effectiveFile.path}. The edit produced identical content.` };
				}
				return {
					diff: genDiff(
						effectiveFile.originalNormalized,
						effectiveFile.result,
						4,
						effectiveFile.resultHashes,
						effectiveFile.originalHashes,
					).diff,
				};
			} catch (error: unknown) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
