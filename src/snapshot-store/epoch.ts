/**
 * Single owner of the snapshot-epoch shape: a committed `file_snapshots.snapshot_hash` is
 * `${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}` (issue #339).
 *
 * The two constants are independent evidence axes and this module never conflates them. Raw-byte
 * anchors survive a canon-only change, so anchor reuse asks the generation alone. The canon evidence
 * stored beside an anchor — lineage and lease `canon_hash`, and the `line_id`s paired through it — is
 * only comparable to today's digest under the canon that wrote it, so every seam that reuses that
 * evidence asks the full epoch.
 * Ref: docs/adr/0013-anchor-identity-derives-from-raw-bytes.md
 */
import { ANCHOR_GENERATION, CANON_VERSION } from "../hashline/hash-identity.js";

/** The three components of a cache key. Internal: callers ask the predicates below, never the parts. */
interface SnapshotEpoch {
  canonVersion: number;
  anchorGeneration: number;
  checksum: string;
}

/**
 * Splits a cache key into its components. `undefined` unless the key carries exactly three
 * `:`-separated parts whose first two are integers, so a pre-epoch two-part row, a pre-rename key
 * and malformed text are all unparseable rather than silently foreign.
 */
export function parseEpoch(hash: string | null | undefined): SnapshotEpoch | undefined {
  if (hash === null || hash === undefined) return undefined;
  const parts = hash.split(":");
  if (parts.length !== 3) return undefined;
  const [canon, generation, checksum] = parts;
  if (canon === undefined || generation === undefined || checksum === undefined) return undefined;
  if (!/^\d+$/.test(canon) || !/^\d+$/.test(generation)) return undefined;
  return {
    canonVersion: Number(canon),
    anchorGeneration: Number(generation),
    checksum,
  };
}

/** The epoch prefix of a cache key — `CANON_VERSION:ANCHOR_GENERATION:` — with the checksum left out. */
export function epochKey(epoch: { canonVersion: number; anchorGeneration: number }): string {
  return `${epoch.canonVersion}:${epoch.anchorGeneration}:`;
}

/**
 * Whether a cache key names the current epoch on BOTH axes. Gates every seam that reuses the canon
 * evidence a snapshot stored, because that evidence is only comparable under the canon that wrote it.
 */
export function isCurrentSnapshotEpoch(hash: string | null | undefined): hash is string {
  const epoch = parseEpoch(hash);
  return (
    epoch !== undefined &&
    epoch.canonVersion === CANON_VERSION &&
    epoch.anchorGeneration === ANCHOR_GENERATION
  );
}

/**
 * Whether the raw anchors are still derivable at the same generation. Gates anchor reuse only —
 * the anchors are a function of raw bytes, which no canon change can move.
 */
export function isCurrentRawAnchorGeneration(generation: number | null | undefined): boolean {
  return generation === ANCHOR_GENERATION;
}
