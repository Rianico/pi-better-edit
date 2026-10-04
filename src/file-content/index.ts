/**
 * SAFETY: FileContent — deep module owning "prepare file content" seam.
 *
 * One concept scattered across file-kind + file-reader + read preview:
 * kind detection (magic+ext, BOM/UTF-32/16), decode (UTF-8, hadUtf8DecodeErrors,
 * newline counting, maxLines), normalization (BOM strip, CRLF→LF, ending),
 * hashing (snapshot cache, stable hashes), preview (offset/limit, oversize,
 * truncation). Callers cross one seam: prepare().
 */

import { constants } from "node:fs";
import { AUTO_READ_MAX } from "../constants.js";
import { MAX_HASH_LINES } from "../hashline/index.js";
import { resolveTarget } from "../fs-write.js";
import { toCwd } from "../paths.js";
import { valAccess } from "../validation.js";
import { abortIf } from "../utils.js";
import { visLines } from "../utils.js";
import { loadFileKindAndText, type FileStats, type LFile } from "./detection.js";
import { readNormFile, decodeNormText, fileSnap, type NormFile } from "./loader.js";
import { fmtReadPreview, type ReadWindow } from "./preview.js";
import type { ServedRow } from "../hashline/served.js";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export type { FileStats, LFile, LoadFileOptions } from "./detection.js";
export { loadFileKindAndText } from "./detection.js";
export {
  readNormFile,
  decodeNormText,
  fileSnap,
  type NormText,
  type NormFile,
  type SnapInfo,
  type ReadNormOptions,
} from "./loader.js";
export { fmtReadPreview } from "./preview.js";
export type { ReadWindow } from "./preview.js";

export interface PrepareResult {
  kind: LFile["kind"];
  normalized: string;
  absolutePath: string;
  bom: string;
  fileHashes: string[];
  hadUtf8DecodeErrors: boolean;
  preview: string;
  served: ServedRow[];
  truncation?: TruncationResult;
  nextOffset?: number;
  description?: string;
  mimeType?: string;
  // WHY: the loader already stat'd this path; the read path hands that `Stats` to `fileSnap`, so a
  // WHY: read costs one `stat` per file instead of one per seam.
  stats?: FileStats;
}

export interface PrepareOptions {
  signal?: AbortSignal;
  offset?: number;
  limit?: number;
  windows?: ReadWindow[];
  /** The anchor-space line cap for served reads; ignored when `render` is `"verbatim"`. */
  maxLines?: number;
  accessMode?: number;
  maxLineBytes?: number;
  maxTruncLines?: number;
  render?: "served" | "verbatim";
  store?: import("../hash-store.js").HashStore;
  noPersist?: boolean;
  preloadedFile?: LFile;
}

export async function prepareFile(
  path: string,
  cwd: string,
  options?: PrepareOptions,
): Promise<PrepareResult> {
  const absolutePath = toCwd(path, cwd);
  const signal = options?.signal;
  abortIf(signal);
  await valAccess(absolutePath, path, options?.accessMode ?? constants.R_OK);
  abortIf(signal);
  const verbatim = options?.render === "verbatim";
  // WHY: the anchor-space line cap is an edit-domain limit (`MAX_HASH_LINES` is the served cap), so
  // WHY: verbatim ignores a caller-supplied cap: a file too large to anchor is still a file worth
  // WHY: reading. Only the 100MB `MAX_BYTES` guard in `loadFileKindAndText` bounds both modes, and it
  // WHY: bounds BYTES READ: verbatim pages the file by walking its lines and never holds a line
  // WHY: array, while served still materializes one (`visLines`) before slicing a page, so no cap
  // WHY: returns here.
  const maxLines = verbatim ? undefined : (options?.maxLines ?? MAX_HASH_LINES);
  const file =
    options?.preloadedFile ??
    (await loadFileKindAndText(absolutePath, {
      maxLines,
      displayPath: path,
    }));
  if (file.kind !== "text") {
    const resolved = await resolveTarget(absolutePath).catch(() => absolutePath);
    if (file.kind === "binary") {
      return {
        kind: "binary",
        normalized: "",
        absolutePath: resolved,
        bom: "",
        fileHashes: [],
        hadUtf8DecodeErrors: false,
        preview: "",
        served: [],
        description: file.description,
      };
    }
    if (file.kind === "image") {
      return {
        kind: "image",
        normalized: "",
        absolutePath: resolved,
        bom: "",
        fileHashes: [],
        hadUtf8DecodeErrors: false,
        preview: "",
        served: [],
        mimeType: file.mimeType,
      };
    }
    return {
      kind: "directory",
      normalized: "",
      absolutePath: resolved,
      bom: "",
      fileHashes: [],
      hadUtf8DecodeErrors: false,
      preview: "",
      served: [],
    };
  }

  // WHY: the ONE seam where verbatim diverges from served. Both modes decode/normalize through
  // WHY: `decodeNormText`; only served then hashes, because anchors and the anchor-space line cap are
  // WHY: edit-domain concerns. The `fileHashes: []` is load-bearing: the preview reads a
  // WHY: present-but-empty array as "hashes already known" and skips its own lazy `lineHashes` call.
  const norm: NormFile = verbatim
    ? {
        ...(await decodeNormText(path, cwd, {
          signal,
          accessMode: options?.accessMode,
          preloadedFile: file,
        })),
        fileHashes: [],
      }
    : await readNormFile(path, cwd, {
        signal,
        accessMode: options?.accessMode,
        maxLines,
        store: options?.store,
        noPersist: options?.noPersist,
        preloadedFile: file,
      });

  const preview = await fmtReadPreview(
    norm.normalized,
    {
      offset: options?.offset,
      limit: options?.limit,
      windows: options?.windows,
      render: options?.render,
    },
    norm.fileHashes,
    norm.absolutePath,
    options?.maxLineBytes,
    options?.maxTruncLines ?? AUTO_READ_MAX,
  );

  // WHY: (04b-rem P3-4 ruling) the old tail promised "editing rewrites the file as UTF-8" — the
  // WHY: admission round-trip guard (E_LOSSY_TEXT) refuses such an edit instead, so the read
  // WHY: disclosure now states what the tool actually does with these bytes.
  const previewText = norm.hadUtf8DecodeErrors
    ? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; edit refuses this file — its bytes do not round-trip UTF-8.]`
    : preview.text;

  return {
    kind: "text",
    normalized: norm.normalized,
    absolutePath: norm.absolutePath,
    bom: norm.bom,
    fileHashes: norm.fileHashes,
    ...(file.stats ? { stats: file.stats } : {}),
    hadUtf8DecodeErrors: norm.hadUtf8DecodeErrors,
    preview: previewText,
    served: preview.served,
    ...(preview.truncation ? { truncation: preview.truncation } : {}),
    ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
  };
}

export async function snapIdFor(absolutePath: string): Promise<string | undefined> {
  try {
    return (await fileSnap(absolutePath)).snapshotId;
  } catch {
    return undefined;
  }
}

export { visLines };
