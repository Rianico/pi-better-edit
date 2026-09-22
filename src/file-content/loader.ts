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
import { visLines } from "../utils.js";
import { loadHashStore, type HashStore } from "../hash-store.js";
import { snapshotIOFor } from "../snapshot-store";
import type { NormFile } from "./types.js";

export type { NormFile } from "./types.js";

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

export interface ReadNormOptions {
  signal?: AbortSignal;
  accessMode?: number;
  preloadedFile?: LFile;
  maxLines?: number;
  store?: HashStore;
  noPersist?: boolean;
}

export async function readNormFile(
  path: string,
  cwd: string,
  options?: ReadNormOptions,
): Promise<NormFile> {
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
    const lineCount = visLines(normalized).length;
    if (lineCount > options.maxLines) {
      throw new DomainError("E_LARGE_FILE", {
        path,
        limitKind: "lines",
        lineCount,
        limit: options.maxLines,
      });
    }
  }

  const hashStore = options?.store ?? (await loadHashStore());
  const fileHashes = await defaultHashIdentity.hashesFor(normalized, {
    path: resolvedPath,
    persist: options?.noPersist !== true,
    snapshotIO: snapshotIOFor(hashStore),
    // WHY: this is the read-path materialization of the file's committed bytes (spec §3.1.3 / §3.1.3.3):
    // WHY: it is the single authoritative source of line survival, so it is the only hashing call in
    // WHY: the load path allowed to retire leases. In-memory working-buffer hashing stays non-authoritative.
    retireLeases: true,
  });
  return {
    absolutePath: resolvedPath,
    normalized,
    bom,
    originalEnding,
    fileHashes,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
  };
}
