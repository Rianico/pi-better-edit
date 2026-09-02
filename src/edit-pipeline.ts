/**
 * SAFETY: EditPipeline facade — thin delegating seam over MutationEngine.
 *
 * Graded surface: public contract retained for backward compatibility,
 * implementation lives in `src/mutation-engine/`. New code should import
 * from `src/mutation-engine/index.js` and switch on the discriminated
 * `MutationResult` (`ok:true` vs `ok:false`).
 *
 * Kept as facade so `src/edit.ts` and legacy callers keep import surface
 * stable during cutover. Delete once all callers migrate — net growth tracked.
 */
export * from "./mutation-engine/index.js";
