import { HASH_LEN, ALPHA, ALPHA_RE as _ALPHA_RE, HASH_RE } from "./alphabet.js";
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

const HASH_SPACE = ALPHA.length ** HASH_LEN;
const _MAX_HASH_LINES = HASH_SPACE;

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  return true;
}
const _HASH_PROBE_STRIDE = ALPHA.length ** 2 + ALPHA.length + 1;

// SAFETY: one definition of the canon digest for the whole toolchain — `hash-identity.ts` owns it
// SAFETY: beside the canonical `canon`, and consumers reach it through either facade (#151).
export { canonDigest } from "./hash-identity.js";

export const CANON_VERSION = 2;
const CANON_RE = /[ \t\r\n]+/g;

export function canon(line: string): string {
  return line.replace(CANON_RE, "");
}

export function _lineHashesPure(content: string, tombstone?: ReadonlySet<string>): string[] {
  return _defaultHI.hashesForSync(content, tombstone);
}

async function _lineHashes(
  content: string,
  path?: string,
  previous?: { content: string; hashes: string[]; removedHashes?: Set<string> },
  io?: HashSnapshotIO,
  persist?: boolean,
  tombstone?: ReadonlySet<string>,
): Promise<string[]> {
  return _defaultHI.hashesFor(content, {
    path,
    prior: previous,
    persist: persist ?? true,
    snapshotIO: io as any,
    tombstone,
  });
}
