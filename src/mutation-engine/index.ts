/**
 * SAFETY: MutationEngine — public interface for the deep mutation seam.
 *
 * One seam, small interface, deep implementation. Internal pipeline phases
 * (load, parse, mutate, finalize, drift, persist, serve) stay private.
 * Two adapters justify the seam: SQLiteSnapshotStore (prod) vs
 * MemorySnapshotStore (tests) — local-substitutable.
 *
 * Callers cross this seam via `execute` / `preview` and switch on the
 * discriminated `MutationResult` (`ok:true` vs `ok:false`). No `any`,
 * no `isError` flag checks, no threading of `sessionKey`/`store` details.
 */

// WHY: Public typed boundary — validated at admission, trusted inside.
export type { PipelineOptions, ProcessedEditFile, MutationSuccess, MutationFailure, MutationResult } from "./types.js";
export { isMutationSuccess, isMutationFailure } from "./types.js";

// WHY: Deep seam — small interface.
export { execute, preview } from "./engine.js";

// WHY: Re-export pipeline legacy names for callers that still import from
// WHY: `edit-pipeline.ts` facade — keeps import surface stable during cutover.
// WHY: Prefer `execute`/`preview` with `MutationResult` for new code.
export { previewEdits, apply, execEdits } from "./pipeline.js";
export type { ProcessedEditFile as PipelineFile } from "./pipeline.js";
