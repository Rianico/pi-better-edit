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
import { AUTO_READ_MAX, SERVED_MAX_LINES } from "../constants.js";
import { resolveTarget } from "../fs-write.js";
import { toCwd } from "../paths.js";
import { valAccess } from "../validation.js";
import { abortIf } from "../utils.js";
import { visLines } from "../utils.js";
import {
  loadFileKindAndText,
  scanControlChars,
  type ControlCharReport,
  type FileStats,
  type LFile,
} from "./detection.js";
import { anchorWalkFor, decodeNormText, fileSnap } from "./loader.js";
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
  /**
   * The counts the read's count-only walk produced, in both line stacks: `visLines(normalized).length`
   * for the read's own line count, and `splitLines(normalized).length` for the snapshot's. WHY: a caller
   * that split the text again for them would rebuild the line array this path exists to avoid.
   */
  lineTotals: { visible: number; split: number };
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
  // WHY: the served admission budget (`SERVED_MAX_LINES`) is an edit-domain limit independent of the
  // WHY: anchor-space ceiling (`MAX_HASH_LINES`), so verbatim ignores a caller-supplied cap: a file too
  // WHY: large to anchor is still a file worth reading. Only the 100MB `MAX_BYTES` guard in
  // WHY: `loadFileKindAndText` bounds both modes, and it bounds BYTES READ: both modes page a file by
  // WHY: walking its lines, but served additionally retains one anchor per hashed line even for an
  // WHY: unshown window (see `src/constants.ts`), so verbatim takes no cap and served takes the budget.
  // WHY: The served default stays `SERVED_MAX_LINES`, not the anchor-space ceiling.
  const maxLines = verbatim ? undefined : (options?.maxLines ?? SERVED_MAX_LINES);
  const file =
    options?.preloadedFile ??
    (await loadFileKindAndText(absolutePath, {
      ...(maxLines === undefined ? {} : { maxLines }),
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
        lineTotals: { visible: 0, split: 0 },
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
        lineTotals: { visible: 0, split: 0 },
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
      lineTotals: { visible: 0, split: 0 },
      hadUtf8DecodeErrors: false,
      preview: "",
      served: [],
    };
  }

  // WHY: the ONE seam where verbatim diverges from served. Both modes decode/normalize through
  // WHY: `decodeNormText`; only served then reaches the anchor store, because anchors and the
  // WHY: anchor-space line cap are edit-domain concerns.
  const norm = await decodeNormText(path, cwd, {
    ...(signal !== undefined ? { signal } : {}),
    ...(options?.accessMode !== undefined ? { accessMode: options.accessMode } : {}),
    ...(maxLines === undefined ? {} : { maxLines }),
    preloadedFile: file,
  });
  // WHY: served hands the preview a walk plan instead of a finished anchor array: the anchors are
  // WHY: assigned inside the same walk that keeps the page, so the page costs one pass and the anchors
  // WHY: ride along in it. Verbatim passes none at all — no store, no snapshot, no hash of a line.
  const anchors = verbatim
    ? []
    : await anchorWalkFor(norm.normalized, norm.absolutePath, {
        ...(options?.store !== undefined ? { store: options.store } : {}),
        ...(options?.noPersist !== undefined ? { noPersist: options.noPersist } : {}),
      });

  const preview = await fmtReadPreview(
    norm.normalized,
    {
      ...(options?.offset !== undefined ? { offset: options.offset } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.windows !== undefined ? { windows: options.windows } : {}),
      ...(options?.render !== undefined ? { render: options.render } : {}),
      // WHY: the caller's own path, not `absolutePath`: the header/footer name the file the caller
      // WHY: named, while anchors stay scoped to the absolute path the walk seeded them with.
      displayPath: path,
    },
    anchors,
    norm.absolutePath,
    options?.maxLineBytes,
    options?.maxTruncLines ?? AUTO_READ_MAX,
  );

  // WHY: (04b-rem P3-4 ruling) the old tail promised "editing rewrites the file as UTF-8" — the
  // WHY: admission round-trip guard (E_LOSSY_TEXT) refuses such an edit instead, so the read
  // WHY: disclosure now states what the tool actually does with these bytes.
  // WHY: I2 (spec §6) — the bytes stay verbatim; the notices only name what the rows carry. A
  // WHY: non-printable control character is disclosed, never escaped into a `\xNN` form.
  const notices = [
    ...(norm.hadUtf8DecodeErrors
      ? [
          "[Non-UTF-8 bytes shown as U+FFFD; edit refuses this file — its bytes do not round-trip UTF-8.]",
        ]
      : []),
    ...controlCharNotices(scanControlChars(preview.text)),
  ];
  const previewText = [preview.text, ...notices].join("\n\n");

  return {
    kind: "text",
    normalized: norm.normalized,
    absolutePath: norm.absolutePath,
    bom: norm.bom,
    fileHashes: preview.hashes,
    lineTotals: preview.lineTotals,
    ...(file.stats ? { stats: file.stats } : {}),
    hadUtf8DecodeErrors: norm.hadUtf8DecodeErrors,
    preview: previewText,
    served: preview.served,
    ...(preview.truncation ? { truncation: preview.truncation } : {}),
    ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
  };
}

/**
 * The I2 byte-view notice for invisible control characters (spec §6). None when the emitted rows are
 * clean — the common case — so the verbatim contract stays byte-identical for ordinary text.
 */
function controlCharNotices(report: ControlCharReport): string[] {
  if (report.count === 0) return [];
  const named = report.codes.slice(0, 3).join(", ") + (report.codes.length > 3 ? ", …" : "");
  const noun = report.count === 1 ? "character" : "characters";
  return [
    `[${report.count} non-printable control ${noun} present: ${named}; shown verbatim — escaped byte forms are not emitted by default.]`,
  ];
}

export async function snapIdFor(absolutePath: string): Promise<string | undefined> {
  try {
    return (await fileSnap(absolutePath)).snapshotId;
  } catch {
    return undefined;
  }
}

export { visLines };
