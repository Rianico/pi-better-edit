/**
 * SAFETY: Edit-source owner — the load/lease boundary of the mutation
 * pipeline: reading the file into the normalized edit view, building the
 * read-only lease identity source, and the session-key admission check.
 * Vocabulary (CONTEXT.md): serve, served state, lease, span — preserved.
 */

import { readNormFile } from "../file-reader.js";
import { splitLines } from "../utils.js";
import { SERVED_MAX_LINES } from "../constants.js";
import type { LineEnding } from "../edit-diff.js";
import type { HashStore } from "../hash-store.js";
import type { LeaseSpanSource } from "../hashline/index.js";
import {
  createSessionHandle,
  loadAnchorHomes,
  loadLeases,
  type ServedLease,
} from "../served-session/session.js";
import { snapshotHashFor, positionsByIdentity, isCurrentAnchorGeneration } from "../snapshot-store";
import { DomainError } from "../domain-errors.js";
import { identityPositions } from "./batch-span-gate.js";

export interface EditFileSource {
  path: string;
  cwd: string;
  signal?: AbortSignal;
  accessMode?: number;
  sessionKey: string;
  store?: HashStore;
  noPersist?: boolean;
}

export interface LoadedEditFile {
  normalized: string;
  bom: string;
  originalEnding: LineEnding;
  fileHashes: string[];
  hadUtf8DecodeErrors: boolean;
  absolutePath: string;
  served: (string | null)[];
  blockedHashes: ReadonlySet<string>;
  canonDigests: (string | null)[];
}

export async function loadEditFile(source: EditFileSource): Promise<LoadedEditFile> {
  const { normalized, bom, originalEnding, fileHashes, hadUtf8DecodeErrors, absolutePath } =
    await readNormFile(source.path, source.cwd, {
      ...(source.signal !== undefined ? { signal: source.signal } : {}),
      ...(source.accessMode !== undefined ? { accessMode: source.accessMode } : {}),
      maxLines: SERVED_MAX_LINES,
      ...(source.store !== undefined ? { store: source.store } : {}),
      ...(source.noPersist !== undefined ? { noPersist: source.noPersist } : {}),
    });
  const served = await createSessionHandle(source.sessionKey, absolutePath).load();
  let blockedHashes: ReadonlySet<string> = new Set();
  let canonDigests: (string | null)[] = [];
  try {
    const handle = createSessionHandle(source.sessionKey, absolutePath, source.store);
    try {
      blockedHashes = await handle.loadBlockedHashes();
    } catch (error) {
      console.error("Failed to load legacy blocked hashes for edit:", error);
      blockedHashes = new Set<string>();
    }
    try {
      canonDigests = await handle.loadCanonDigests();
    } catch (error) {
      console.error("Failed to load served canon digests for edit:", error);
      canonDigests = [];
    }
  } catch (error) {
    console.error("Failed to load served state for edit:", error);
  }
  return {
    normalized,
    bom,
    originalEnding,
    fileHashes,
    hadUtf8DecodeErrors,
    absolutePath,
    served,
    blockedHashes,
    canonDigests,
  };
}

/**
 * SAFETY: (ticket-04 §9.5, keel F2) the foreign read-only authority lives here, beside
 * SAFETY: `loadEditFile`, and cannot be mistaken for it: `loadEditFile` forwards `noPersist`
 * SAFETY: verbatim, so reuse would let a foreign read flip into a persisting, lease-retiring
 * SAFETY: load. This entry accepts no such flag, passes the CALLER's store to the served-state
 * SAFETY: load (an injected store must not see a split served view), and records nothing.
 *
 * Assembles one foreign file's served view: the never-persisting read, its served-state load,
 * and the read-only lease identity source — the single place the foreign pre-pass gets these.
 */
export type ForeignServedView = {
  absolutePath: string;
  normalized: string;
  fileLines: string[];
  fileHashes: string[];
  served: (string | null)[];
  source: LeaseSpanSource;
};

export async function loadForeignServedView(input: {
  path: string;
  cwd: string;
  sessionKey: string;
  store: HashStore;
}): Promise<ForeignServedView> {
  const { normalized, absolutePath, fileHashes, hadUtf8DecodeErrors } = await readNormFile(
    input.path,
    input.cwd,
    {
      maxLines: SERVED_MAX_LINES,
      store: input.store,
      noPersist: true,
    },
  );
  // WHY: (04b-rem P2-3) the admission round-trip guard applies to the FOREIGN source exactly as
  // WHY: it applies to the target: the cut materializes span bytes decoded from THIS file, so
  // WHY: lossy bytes here would write destroyed content into the target. The refusal names the
  // WHY: member whose bytes broke the round-trip — the cause is observed, not assumed.
  if (hadUtf8DecodeErrors) {
    throw new DomainError("E_LOSSY_TEXT", { path: absolutePath });
  }
  const served = await createSessionHandle(input.sessionKey, absolutePath, input.store).load();
  const source = leaseSpanSource({
    store: input.store,
    sessionKey: input.sessionKey,
    absolutePath,
    content: normalized,
  });
  return {
    absolutePath,
    normalized,
    // WHY: (§9.6) `splitLines` is the fileLines every hash/coordinate computation uses —
    // WHY: `normalized.split("\n")` misaligns the trailing line against `fileHashes`, and the
    // WHY: leased seam skips `assertAligned`, so the violation would be silent.
    fileLines: splitLines(normalized),
    fileHashes,
    served,
    source,
  };
}

/**
 * Builds the read-only lease identity source for one edit (spec §3.1.1). Leases come straight from
 * `served_leases`; the `line_id` -> current-line map comes from the working buffer's own identity map
 * when one is in flight (a chained batch edit), else from `line_lineage(C)` when the edit load path
 * materialized C, else from an in-memory `pairSnapshots(S_latest, content)` for preview. Nothing is
 * written: the edit path never re-stamps a lease.
 */
export function leaseSpanSource(input: {
  store: HashStore;
  sessionKey: string;
  absolutePath: string;
  content: string;
  currentIds?: (number | null)[];
}): LeaseSpanSource {
  const byAnchor = new Map<string, ServedLease>();
  for (const lease of loadLeases(input.store, input.sessionKey, input.absolutePath)) {
    // WHY: generation-gated lease source — a pre-bump lease is never honoured, so a
    // WHY: stale generation cannot resolve by line_id alone. The open-time sweep
    // WHY: deletes these rows; this gate covers rows written between sweep and read.
    if (!isCurrentAnchorGeneration(lease.served_snapshot_hash)) continue;
    byAnchor.set(lease.anchor, lease);
  }
  const positions = input.currentIds
    ? identityPositions(input.currentIds)
    : positionsByIdentity(input.store, input.absolutePath, input.content);
  // WHY: the session-wide home lookup runs on the failure path only: the happy
  // WHY: path never calls it, so serving one more file costs nothing at edit time.
  const { store, sessionKey, absolutePath } = input;
  return {
    currentSnapshotHash: snapshotHashFor(input.content),
    leaseFor: (anchor) => {
      const lease = byAnchor.get(anchor);
      if (!lease) return undefined;
      return {
        lineId: lease.line_id,
        canonHash: lease.canon_hash,
        servedSnapshotHash: lease.served_snapshot_hash,
        servedLineNumber: lease.served_line_number,
        retiredAt: lease.retired_at,
      };
    },
    rebasedLineOf: (lineId) => positions.get(lineId),
    anchorHomes: (anchor) =>
      loadAnchorHomes(store, sessionKey, anchor).filter((home) => home !== absolutePath),
  };
}

// WHY: (#165) the pipeline never mints a session key: a key that was never served anything makes
// WHY: every lease lookup miss and surfaces a misleading E_UNKNOWN_ANCHOR. Missing sessions fail
// WHY: here, at the boundary, with the real cause.
export function requireSessionKey(sessionKey: string | undefined): string {
  if (!sessionKey) {
    throw new Error("edit pipeline requires options.sessionKey — entrypoints must carry a session");
  }
  return sessionKey;
}
