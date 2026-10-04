import { ALPHA_RE as _ALPHA_RE, HASH_RE } from "./alphabet.js";
import { defaultHashIdentity as _defaultHI } from "./hash-identity.js";
import type {
  HashSnapshotIO as _HSIO,
  HashSnapshotUpsertOptions as _HSUO,
} from "./hash-identity.js";

export type HashSnapshotUpsertOptions = _HSUO;

export interface HashSnapshotIO {
  get(path: string, content: string, deleteCorrupt: boolean): Promise<string[] | undefined>;
  upsert(
    path: string,
    checksum: string,
    lineCount: number,
    hashes: string[],
    content: string,
    options?: HashSnapshotUpsertOptions,
  ): Promise<void>;
}

export function setDefaultHashSnapshotIO(io: HashSnapshotIO | undefined): void {
  (_defaultHI as any).setSnapshotIO(io as any);
}

export const HASH_SEP = "│";

// WHY: single owner of the capacity figures lives in `hash-identity.ts` — this
// WHY: facade re-exports them so the two cannot drift.
export { HASH_SPACE, USABLE_HASH_SPACE, MAX_HASH_LINES } from "./hash-identity.js";
// WHY: facade parity — tests importing the content-only helper from this facade
// WHY: keep working; the implementation lives in `hash-identity.ts`.
export { contentOnlyHashes, fileHashesFor } from "./hash-identity.js";
export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  return true;
}
// SAFETY: one definition of the canon digest for the whole toolchain — `hash-identity.ts` owns it
// SAFETY: beside the canonical `canon`, and consumers reach it through either facade (#151).
export { canonDigest } from "./hash-identity.js";

// WHY: single owner lives in `hash-identity.ts` — this facade re-exports it so
// WHY: the snapshot cache key cannot drift between facades.
export { CANON_VERSION } from "./hash-identity.js";
const CANON_RE = /[ \t\r\n]+/g;

export function canon(line: string): string {
  return line.replace(CANON_RE, "");
}

async function _lineHashes(
  content: string,
  path: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
  io?: HashSnapshotIO,
  persist?: boolean,
  blockedHashes?: ReadonlySet<string>,
): Promise<string[]> {
  return _defaultHI.hashesFor(content, {
    path,
    prior: previous,
    persist: persist ?? true,
    snapshotIO: io as any,
    blockedHashes,
  });
}
