/**
 * Types for `sandbox-env.mjs`, which the TypeScript benchmark entries import.
 *
 * WHY a declaration file rather than a `.ts` implementation: the four `bench-*.mjs` runners are plain
 * `node` scripts — they cannot import TypeScript at all — so the implementation has to be `.mjs`,
 * and the four `.ts` entries that also pin the sandbox in-process need a shape to import. This file
 * is the type of record; it must not grow behaviour.
 */
export declare function sandboxEnv(dir: string): Record<string, string>;
