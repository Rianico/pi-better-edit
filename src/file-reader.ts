import { constants } from "fs";
import { stat } from "fs/promises";
import { lineHashes } from "./hashline";
import { loadFileKindAndText, type LFile } from "./file-kind";
import { resolveTarget } from "./fs-write";
import { toCwd } from "./paths";
import { detectEnding, toLF, stripBOM, type LineEnding } from "./replace-diff";
import { abortIf } from "./utils";
import { valKind, valAccess } from "./validation";
import { visLines } from "./utils";
import type { HashStore } from "./hash-store";
export interface NormFile {
  absolutePath: string;
  normalized: string;
  bom: string;
  originalEnding: LineEnding;
  fileHashes: string[];
  hadUtf8DecodeErrors: boolean;
}

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
): string {
  return `v2|${canonicalPath}|${info.ino}|${info.mtimeMs}|${info.ctimeMs}|${info.size}`;
}

export async function fileSnap(absolutePath: string): Promise<SnapInfo> {
  const canonicalPath = await resolveTarget(absolutePath);
  const stats = await stat(canonicalPath);
  return {
    snapshotId: fmtSnapId(canonicalPath, stats),
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
  const file = options?.preloadedFile ?? (await loadFileKindAndText(resolvedPath, { maxLines: options?.maxLines, displayPath: path }));
  valKind(file, path);
  abortIf(signal);
  const { bom, text: rawContent } = stripBOM(file.text);
  const originalEnding = detectEnding(rawContent);
  const normalized = toLF(rawContent);

  if (options?.maxLines !== undefined) {
    const lineCount = visLines(normalized).length;
    if (lineCount > options.maxLines) {
      throw new Error(
        `[E_FILE_TOO_LARGE] ${path} has ${lineCount} lines, exceeding the ${options.maxLines}-line edit limit. Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.`,
      );
    }
  }

  const fileHashes = await lineHashes(normalized, resolvedPath, undefined, options?.store);
  return {
    absolutePath: resolvedPath,
    normalized,
    bom,
    originalEnding,
    fileHashes,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
  };
}
