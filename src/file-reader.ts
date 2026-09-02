/**
 * SAFETY: Facade — graded surface retained for compat.
 * Implementation lives in `src/file-content/loader.ts` + `preview.ts`.
 * New code should import from `src/file-content/index.js`.
 */
export * from "./file-content/loader.js";
export { fmtReadPreview } from "./file-content/preview.js";
