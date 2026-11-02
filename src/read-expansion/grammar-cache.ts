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
interface GrammarArtifact {
  readonly language: string;
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface GrammarCacheOptions {
  /** Override the state-root grammar directory (tests). */
  cacheRoot?: string;
  /** Override `globalThis.fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Read budget for a first-use fetch; the fetch itself continues after this wait. */
  timeoutMs?: number;
  /** Override the committed manifest (tests). */
  manifest?: GrammarManifest;
}

/** Why a grammar request did not produce verified bytes. */
export type GrammarFetchResult =
  | { readonly status: "ready"; readonly artifact: GrammarArtifact }
  | { readonly status: "cold"; readonly language: string }
  | { readonly status: "unavailable"; readonly language: string };

/** Production read budget before a first-use fetch reports cold. */
const DEFAULT_GRAMMAR_READ_BUDGET_MS = 250;
const FETCH_HARD_TIMEOUT_MS = 30_000;
const COLD = Symbol("cold");

const inFlight = new Map<string, Promise<Uint8Array | undefined>>();
/** `<stateRoot>/grammars` — grammar cache lives beside the store and logs. */
function grammarCacheRoot(root?: string): string {
  return root ?? join(stateRoot(), "grammars");
}

/** Version and digest are in the filename, so a manifest bump cannot reuse old bytes. */
function grammarCachePath(
  language: string,
  entry: GrammarManifestEntry,
  cacheRoot?: string,
): string {
  return join(
    grammarCacheRoot(cacheRoot),
    `${language}-${entry.version}-${entry.sha256.slice(0, 16)}.wasm`,
  );
}

/**
 * Seed the cache from a committed fixture. TEST-ONLY: production code never calls it; the name is
 * the guard. A witness needs verified bytes without a network fetch, and the read budget would
 * otherwise report `cold` before a fetch could land.
 */
export function primeGrammarForTests(
  language: string,
  bytes: Uint8Array,
  options: GrammarCacheOptions = {},
): string {
  const entry = (options.manifest ?? GRAMMAR_MANIFEST)[language];
  if (entry === undefined) throw new Error(`No grammar manifest entry for "${language}".`);
  const path = grammarCachePath(language, entry, options.cacheRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
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
      signal: AbortSignal.timeout(FETCH_HARD_TIMEOUT_MS),
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
/** Wait for a shared fetch inside the read budget, or report that it is still cold. */
function waitWithin<T>(task: Promise<T>, timeoutMs: number): Promise<T | typeof COLD> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof COLD>((resolve) => {
    timer = setTimeout(() => resolve(COLD), Math.max(0, timeoutMs));
  });
  return Promise.race([task, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function fetchAndCache(
  entry: GrammarManifestEntry,
  path: string,
  options: GrammarCacheOptions,
): Promise<Uint8Array | undefined> {
  return (async () => {
    try {
      const bytes = await fetchVerified(entry, options);
      if (bytes === undefined) return undefined;
      writeCache(path, bytes);
      return bytes;
    } catch {
      // SAFETY: a fetch/write failure is the same answer as an offline grammar.
      return undefined;
    }
  })();
}

/**
 * Request verified grammar bytes. The first requester starts one shared fetch; every caller waits
 * only its read budget. A budget expiry returns `cold` while the shared fetch keeps running, so the
 * next read can widen once it lands.
 */
export async function requestGrammar(
  language: string,
  options: GrammarCacheOptions = {},
): Promise<GrammarFetchResult> {
  const entry = (options.manifest ?? GRAMMAR_MANIFEST)[language];
  if (entry === undefined) return { status: "unavailable", language };
  const path = grammarCachePath(language, entry, options.cacheRoot);
  const cached = readVerifiedCache(path, entry.sha256);
  if (cached !== undefined) return { status: "ready", artifact: { language, path, bytes: cached } };

  let pending = inFlight.get(path);
  if (pending === undefined) {
    pending = fetchAndCache(entry, path, options);
    inFlight.set(path, pending);
    const settle = (): void => {
      if (inFlight.get(path) === pending) inFlight.delete(path);
    };
    void pending.then(settle, settle);
  }

  const fetched = await waitWithin(pending, options.timeoutMs ?? DEFAULT_GRAMMAR_READ_BUDGET_MS);
  if (fetched === COLD) return { status: "cold", language };
  if (fetched === undefined) return { status: "unavailable", language };
  return { status: "ready", artifact: { language, path, bytes: fetched } };
}
