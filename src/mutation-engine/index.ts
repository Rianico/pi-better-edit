/**
 * SAFETY: MutationEngine — public interface for the deep mutation seam.
 *
 * One seam, small interface, deep implementation. Internal pipeline phases
 * (load, parse, mutate, finalize, drift, persist, serve) stay private.
 *
 * Callers cross this seam via `execute` / `preview` and switch on the
 * discriminated `MutationResult` (`ok:true` vs `ok:false`). No `any`,
 * no `isError` flag checks, no threading of `sessionKey`/`store` details.
 */

export { isMutationSuccess, isMutationFailure } from "./types.js";

export { execute, preview } from "./engine.js";
