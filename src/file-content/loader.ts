import { constants } from "node:fs";
import { stat } from "node:fs/promises";
import { defaultHashIdentity } from "../hashline/hash-identity.js";
import { loadFileKindAndText, type FileStats, type LFile } from "./detection.js";
import { resolveTarget } from "../fs-write.js";
import { toCwd } from "../paths.js";
import { detectEnding, toLF, stripBOM } from "../edit-diff.js";
import { abortIf } from "../utils.js";
import { DomainError } from "../domain-errors.js";
import { valKind, valAccess } from "../validation.js";
import { visibleLineCount, visibleLineTotal, walkLines } from "./line-walker.js";
import { loadHashStore, type HashStore } from "../hash-store.js";
import type { AnchorWalk } from "../hashline/hash-identity.js";
import { snapshotIOFor } from "../snapshot-store";
import type { NormFile, NormText } from "./types.js";

export type { NormFile, NormText } from "./types.js";

export type SnapInfo = {
  snapshotId: string;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
};

function fmtSnapId(
  canonicalPath: string,
  info: { ino: number; mtimeMs: number; ctimeMs: number; size: number },
  checksum?: string,
): string {
  return `v2|${canonicalPath}|${info.ino}|${info.mtimeMs}|${info.ctimeMs}|${info.size}${checksum ? `|${checksum}` : ""}`;
}

export async function fileSnap(
  absolutePath: string,
  checksum?: string,
  preloadedStats?: FileStats,
): Promise<SnapInfo> {
  const canonicalPath = await resolveTarget(absolutePath);
  // WHY: the load path stat'd this same canonical path to size the file and reject directories, so
  // WHY: its `Stats` is authoritative for the snapshot id; re-stat'ing could only disagree with the
  // WHY: bytes the caller has already read and hashed.
  const stats: FileStats = preloadedStats ?? (await stat(canonicalPath));
  // WHY: P1: include content checksum in snapshotId for stronger epoch (ADR-0013)
  // WHY: Checksum is optional for backward compat; when provided, epoch distinguishes same-size whitespace changes.
  const effectiveChecksum = checksum ?? undefined;
  return {
    snapshotId: fmtSnapId(canonicalPath, stats, effectiveChecksum),
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    size: stats.size,
  };
}

export interface DecodeNormOptions {
  signal?: AbortSignal;
  accessMode?: number;
  preloadedFile?: LFile;
  /** The anchor-space line cap; omit to load without one (a caller that serves no anchors). */
  maxLines?: number;
}

export interface ReadNormOptions extends DecodeNormOptions {
  store?: HashStore;
  noPersist?: boolean;
}

/**
 * The decode/normalize half of the load path, shared by the served and verbatim seams: kind
 * admission, BOM strip, CRLF→LF, and the invalid-UTF-8 disclosure. `maxLines` is the anchor-space
 * cap — an edit-domain limit — so a caller that serves no anchors omits it and gets an uncapped read.
 */
export async function decodeNormText(
  path: string,
  cwd: string,
  options?: DecodeNormOptions,
): Promise<NormText> {
  const absolutePath = toCwd(path, cwd);
  const resolvedPath = await resolveTarget(absolutePath);
  const signal = options?.signal;
  const accessMode = options?.accessMode ?? constants.R_OK;

  abortIf(signal);
  await valAccess(resolvedPath, path, accessMode);

  abortIf(signal);
  const file =
    options?.preloadedFile ??
    (await loadFileKindAndText(resolvedPath, {
      maxLines: options?.maxLines,
      displayPath: path,
    }));
  valKind(file, path);
  abortIf(signal);
  const { bom, text: rawContent } = stripBOM(file.text);
  const originalEnding = detectEnding(rawContent);
  const normalized = toLF(rawContent);

  if (options?.maxLines !== undefined) {
    // WHY: the decode already counted the newlines any cap needs, so the line count comes back from
    // WHY: the load instead of a second split. A preloaded file that carries no tally pays one
    // WHY: allocation-free walk instead of a line array.
    const lineCount =
      file.newlineCount !== undefined
        ? visibleLineCount(rawContent, file.newlineCount)
        : visibleLineTotal(rawContent, walkLines(rawContent).total);
    if (lineCount > options.maxLines) {
      throw new DomainError("E_LARGE_FILE", {
        path,
        limitKind: "lines",
        lineCount,
        limit: options.maxLines,
      });
    }
  }

  return {
    absolutePath: resolvedPath,
    normalized,
    bom,
    originalEnding,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
  };
}

export async function readNormFile(
  path: string,
  cwd: string,
  options?: ReadNormOptions,
): Promise<NormFile> {
  const norm = await decodeNormText(path, cwd, options);
  const hashStore = options?.store ?? (await loadHashStore());
  const fileHashes = await defaultHashIdentity.hashesFor(norm.normalized, {
    path: norm.absolutePath,
    persist: options?.noPersist !== true,
    snapshotIO: snapshotIOFor(hashStore),
    // WHY: this is the read-path materialization of the file's committed bytes (spec §3.1.3 / §3.1.3.3):
    // WHY: it is the single authoritative source of line survival, so it is the only hashing call in
    // WHY: the load path allowed to retire leases. In-memory working-buffer hashing stays non-authoritative.
    retireLeases: true,
  });
  return { ...norm, fileHashes };
}

/**
 * The served read's anchor plan: the walk assigns each line's anchor while the preview keeps the page.
 *
 * WHY: `readNormFile` finishes the whole anchor array before the caller knows which lines to show, so
 * WHY: the read path takes the assignment instead and runs it inside its own walk. `readNormFile` stays
 * WHY: for the callers that need the finished array (the edit pipeline) and pays a split for it.
 */
export async function anchorWalkFor(
  normalized: string,
  absolutePath: string,
  options?: ReadNormOptions,
): Promise<AnchorWalk> {
  const hashStore = options?.store ?? (await loadHashStore());
  return defaultHashIdentity.anchorsForWalk(normalized, {
    path: absolutePath,
    persist: options?.noPersist !== true,
    snapshotIO: snapshotIOFor(hashStore),
    // WHY: this is the read-path materialization of the file's committed bytes (spec §3.1.3 / §3.1.3.3):
    // WHY: it is the single authoritative source of line survival, so it is the only hashing call in
    // WHY: the load path allowed to retire leases. In-memory working-buffer hashing stays non-authoritative.
    retireLeases: true,
  });
}
