/**
 * Lazy, hash-pinned grammar cache.
 *
 * WHY fetch on first use instead of bundling: the full grammar set measured megabytes against a
 * small extension bundle, and most sessions never touch most languages. The committed manifest is
 * the trust anchor: bytes are cached only after their SHA-256 matches, and a cache entry whose
 * digest no longer matches is deleted rather than parsed.
 *
 * Failure posture is fail-closed: no manifest entry, no global fetch, a network error, a non-OK
 * response, a digest mismatch, or a write failure all yield `undefined`. The caller turns that into
 * a null span and serves the exact requested window.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "../config-dir.js";
import {
  GRAMMAR_MANIFEST,
  type GrammarManifest,
  type GrammarManifestEntry,
} from "./grammar-manifest.js";

/** One verified grammar artifact on disk, plus the bytes the loader can use directly. */
export interface GrammarArtifact {
  readonly language: string;
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface GrammarCacheOptions {
  /** Override the state-root grammar directory (tests). */
  cacheRoot?: string;
  /** Override `globalThis.fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Bounded wait for a first-use fetch; offline reads must fail fast. */
  timeoutMs?: number;
  /** Override the committed manifest (tests). */
  manifest?: GrammarManifest;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/** `<stateRoot>/grammars` — grammar cache lives beside the store and logs. */
function grammarCacheRoot(root?: string): string {
  return root ?? join(stateRoot(), "grammars");
}

/** Version and digest are in the filename, so a manifest bump cannot reuse old bytes. */
export function grammarCachePath(
  language: string,
  entry: GrammarManifestEntry,
  cacheRoot?: string,
): string {
  return join(
    grammarCacheRoot(cacheRoot),
    `${language}-${entry.version}-${entry.sha256.slice(0, 16)}.wasm`,
  );
}

/** Remove one cached grammar (corrupt bytes, failed parse). Never throws. */
export function discardCachedGrammar(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // SAFETY: best effort — a cache deletion failure must not fail the read.
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readVerifiedCache(path: string, expected: string): Uint8Array | undefined {
  if (!existsSync(path)) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    discardCachedGrammar(path);
    return undefined;
  }
  if (sha256Hex(bytes) === expected) return bytes;
  // WHY: stale or corrupted cache bytes are discarded before any network attempt, so a re-fetch
  // WHY: cannot be skipped by the stale file it is meant to replace.
  discardCachedGrammar(path);
  return undefined;
}

async function fetchVerified(
  entry: GrammarManifestEntry,
  options: GrammarCacheOptions,
): Promise<Uint8Array | undefined> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return undefined;
  try {
    const response = await fetchImpl(entry.url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return sha256Hex(bytes) === entry.sha256 ? bytes : undefined;
  } catch {
    // SAFETY: offline, timeout, DNS failure and a malformed response are all "no grammar".
    return undefined;
  }
}

function writeCache(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // SAFETY: best effort cleanup.
    }
    // WHY: a failed cache write does not invalidate bytes already verified in memory; the caller
    // WHY: can parse them now, and the next use simply retries the write.
  }
}

/**
 * Return verified grammar bytes for `language`, fetching at most once on the successful path.
 * A cached digest mismatch deletes the file and fetches; a fetched digest mismatch yields undefined.
 */
export async function ensureGrammar(
  language: string,
  options: GrammarCacheOptions = {},
): Promise<GrammarArtifact | undefined> {
  const entry = (options.manifest ?? GRAMMAR_MANIFEST)[language];
  if (entry === undefined) return undefined;
  const path = grammarCachePath(language, entry, options.cacheRoot);
  const cached = readVerifiedCache(path, entry.sha256);
  if (cached !== undefined) return { language, path, bytes: cached };

  const fetched = await fetchVerified(entry, options);
  if (fetched === undefined) return undefined;
  writeCache(path, fetched);
  return { language, path, bytes: fetched };
}
