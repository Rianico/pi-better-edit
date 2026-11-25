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
import { anchorWalkFor, decodeNormText, fileSnap, snapshotIdFor, statKeyOf } from "./loader.js";
import {
  fmtReadPreview,
  StatIdentityMismatchError,
  type ReadWindow,
  type RenderAnchors,
  type ShownRange,
} from "./preview.js";
import { findStatSnapshotFor } from "../snapshot-store";
import type { ServedRow } from "../served-session/serve-render.js";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import type { LineEndingCounts } from "../edit-diff.js";

export type { FileStats, LFile, LoadFileOptions } from "./detection.js";
export { loadFileKindAndText } from "./detection.js";
export {
  readNormFile,
  decodeNormText,
  fileSnap,
  snapshotIdFor,
  statKeyOf,
  type NormText,
  type NormFile,
  type SnapInfo,
  type StatIdentity,
  type ReadNormOptions,
} from "./loader.js";
export { fmtReadPreview, StatIdentityMismatchError } from "./preview.js";
export type { ReadWindow } from "./preview.js";

export interface PrepareResult {
  kind: LFile["kind"];
  normalized: string;
  absolutePath: string;
  bom: string;
  fileHashes: string[];
  /**
   * The counts the read's count-only walk produced, in both line stacks: `visLines(normalized).length`
   * for the read's own line count, and `splitLines(normalized).length` for the snapshot's.
   */
  lineTotals: { visible: number; split: number };
  hadUtf8DecodeErrors: boolean;
  preview: string;
  served: ServedRow[];
  truncation?: TruncationResult;
  nextOffset?: number;
  /** The lines the preview actually rendered — the page header's range, absent when it showed none. */
  shownRange?: ShownRange;
  description?: string;
  mimeType?: string;
  stats?: FileStats;
  /**
   * The `stat(2)` identity this read observed. Materializations stamp it in the same
   * transaction, so the next read of an unchanged file adopts this snapshot without re-deriving any
   * line identity. Absent for reads that never stat'd a file (verbatim, non-text, pathless previews).
   */
  // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
  statKey?: string;
  /**
   * Present when this page was served from an ALREADY-COMMITTED snapshot that the file's stat identity
   * named: `fileHashes` then holds only the served page's anchors, and `snapshotId` is the
   * epoch string `fileSnap` would have produced — the checksum comes from the snapshot, not a re-hash.
   */
  // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
  statAdoption?: StatAdoption;
  /**
   * Anchors the checksum-miss alignment retired while serving this page (see `AnchorWalk.retired`). The
   * read path persists them as session tombstones, so no later fresh allocation resurrects a deleted line's
   * anchor. Absent when the alignment retired nothing.
   */
  retiredHashes?: string[];
  /**
   * The terminator counts over the WHOLE file's raw bytes, whatever window this page shows. Present
   * for text and absent for the directory, binary and image early returns, which decode no text.
   */
  endingCounts?: LineEndingCounts;
}

/** The already-committed snapshot a stat-identity read served from. */
// Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
export interface StatAdoption {
  snapshotHash: string;
  /** The epoch `fileSnap` would report for these bytes; no content checksum is recomputed. */
  snapshotId: string;
}

export interface PrepareOptions {
  signal?: AbortSignal;
  offset?: number;
  limit?: number;
  windows?: ReadWindow[];
  /** Finished header clauses aligned with `windows`; the note seam owns their text. */
  noteClauses?: readonly (string | undefined)[];
  /** The anchor-space line cap for served reads; ignored when `render` is `"verbatim"`. */
  maxLines?: number;
  accessMode?: number;
  maxLineBytes?: number;
  maxTruncLines?: number;
  render?: "served" | "verbatim";
  /** Server-derived windows (outline declaration rows): the caller-window count cap does not apply. */
  derivedWindows?: boolean;
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

  const norm = await decodeNormText(path, cwd, {
    ...(signal !== undefined ? { signal } : {}),
    ...(options?.accessMode !== undefined ? { accessMode: options.accessMode } : {}),
    ...(maxLines === undefined ? {} : { maxLines }),
    preloadedFile: file,
  });
  const previewOptions = {
    ...(options?.offset !== undefined ? { offset: options.offset } : {}),
    ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    ...(options?.windows !== undefined ? { windows: options.windows } : {}),
    ...(options?.noteClauses !== undefined ? { noteClauses: options.noteClauses } : {}),
    ...(options?.render !== undefined ? { render: options.render } : {}),
    ...(options?.derivedWindows === true ? { derivedWindows: true } : {}),
  };
  const maxLineBytes = options?.maxLineBytes;
  const maxTruncLines = options?.maxTruncLines ?? AUTO_READ_MAX;
  // Ref: docs/.archive_adrs/0043-unchanged-file-adopts-on-stat-identity.md
  const statKey =
    !verbatim && options?.store !== undefined && file.stats !== undefined
      ? statKeyOf(file.stats)
      : undefined;
  let preview: Awaited<ReturnType<typeof fmtReadPreview>> | undefined;
  let statAdoption: StatAdoption | undefined;
  if (statKey !== undefined && file.stats !== undefined) {
    const matched = await findStatSnapshotFor(norm.absolutePath, statKey);
    if (matched !== undefined) {
      abortIf(signal);
      try {
        preview = await fmtReadPreview(
          norm.normalized,
          previewOptions,
          {
            anchorCount: matched.lineCount,
            range: async (start, end) => matched.anchorsInRange(start, end),
          },
          norm.absolutePath,
          maxLineBytes,
          maxTruncLines,
        );
        statAdoption = {
          snapshotHash: matched.snapshotHash,
          snapshotId: snapshotIdFor(norm.absolutePath, file.stats, matched.checksum),
        };
      } catch (error) {
        if (!(error instanceof StatIdentityMismatchError)) throw error;
      }
    }
  }
  let retiredHashes: string[] | undefined;
  if (preview === undefined) {
    let anchors: RenderAnchors = [];
    if (!verbatim) {
      const plan = await anchorWalkFor(norm.normalized, norm.absolutePath, {
        ...(options?.store !== undefined ? { store: options.store } : {}),
        ...(options?.noPersist !== undefined ? { noPersist: options.noPersist } : {}),
      });
      anchors = plan;
      retiredHashes = plan.retired;
    }
    preview = await fmtReadPreview(
      norm.normalized,
      previewOptions,
      anchors,
      norm.absolutePath,
      maxLineBytes,
      maxTruncLines,
    );
  }

  // Ref: docs/spec/search-and-read-evolution.md
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
    ...(preview.shownRange !== undefined ? { shownRange: preview.shownRange } : {}),
    ...(statKey !== undefined ? { statKey } : {}),
    ...(statAdoption !== undefined ? { statAdoption } : {}),
    ...(retiredHashes !== undefined ? { retiredHashes } : {}),
    endingCounts: norm.endingCounts,
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
