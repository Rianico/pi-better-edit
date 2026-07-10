import { constants } from "fs";
import { lineHashes } from "./hashline";
import { loadFileKindAndText, type LFile } from "./file-kind";
import { resolveTarget } from "./fs-write";
import { toCwd } from "./path-utils";
import { detectEnding, toLF, stripBOM } from "./replace-diff";
import { abortIf } from "./runtime";
import { assertText, valAccess } from "./validation";
import { visLines } from "./utils";
export interface NormFile {
  absolutePath: string;
  normalized: string;
  bom: string;
  originalEnding: "\r\n" | "\n";
  fileHashes: string[];
  hadUtf8DecodeErrors: boolean;
}

export async function readNormFile(
  path: string,
  cwd: string,
  signal: AbortSignal | undefined,
  accessMode: number = constants.R_OK,
  preloadedFile?: LFile,
  maxLines?: number,
): Promise<NormFile> {
  const absolutePath = toCwd(path, cwd);
  const resolvedPath = await resolveTarget(absolutePath);

  abortIf(signal);
  await valAccess(resolvedPath, path, accessMode);

  abortIf(signal);
  const file = preloadedFile ?? (await loadFileKindAndText(resolvedPath));
  assertText(file, path);

  abortIf(signal);
  const { bom, text: rawContent } = stripBOM(file.text);
  const originalEnding = detectEnding(rawContent);
  const normalized = toLF(rawContent);

  if (maxLines !== undefined) {
    const lineCount = visLines(normalized).length;
    if (lineCount > maxLines) {
      throw new Error(
        `[E_FILE_TOO_LARGE] ${path} has ${lineCount} lines, exceeding the ${maxLines}-line edit limit. Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.`,
      );
    }
  }

  const fileHashes = await lineHashes(normalized, resolvedPath);
  return {
    absolutePath: resolvedPath,
    normalized,
    bom,
    originalEnding,
    fileHashes,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
  };
}
