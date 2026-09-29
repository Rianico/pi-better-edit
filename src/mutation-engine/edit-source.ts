/**
 * SAFETY: Edit-source owner — the load/lease boundary of the mutation
 * pipeline: reading the file into the normalized edit view, building the
 * read-only lease identity source, and the session-key admission check.
 * Vocabulary (CONTEXT.md): serve, served state, lease, span — preserved.
 */

import { readNormFile } from "../file-reader.js";
import type { LineEnding } from "../edit-diff.js";
import type { HashStore } from "../hash-store.js";
import { MAX_HASH_LINES, type LeaseSpanSource } from "../hashline/index.js";
import {
  createSessionHandle,
  loadAnchorHomes,
  loadLeases,
  type ServedLease,
} from "../served-session/session.js";
import { snapshotHashFor, positionsByIdentity } from "../snapshot-store";
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
  tombstone: ReadonlySet<string>;
  canonDigests: (string | null)[];
}

export async function loadEditFile(source: EditFileSource): Promise<LoadedEditFile> {
  const { normalized, bom, originalEnding, fileHashes, hadUtf8DecodeErrors, absolutePath } =
    await readNormFile(source.path, source.cwd, {
      signal: source.signal,
      accessMode: source.accessMode,
      maxLines: MAX_HASH_LINES,
      store: source.store,
      noPersist: source.noPersist,
    });
  const served = await createSessionHandle(source.sessionKey, absolutePath).load();
  let tombstone: ReadonlySet<string> = new Set();
  let canonDigests: (string | null)[] = [];
  try {
    const handle = createSessionHandle(source.sessionKey, absolutePath, source.store);
    try {
      tombstone = await handle.loadTombstone();
    } catch (error) {
      console.error("Failed to load legacy tombstone for edit:", error);
      tombstone = new Set<string>();
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
    tombstone,
    canonDigests,
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
