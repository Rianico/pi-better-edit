import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { MAX_BYTES, SNIFF_BYTES } from "../constants.js";
import { DomainError } from "../domain-errors.js";
import { readBytes } from "../fs-write.js";

const IMG_TYPES = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const TEXT_TYPES = new Set<string>([
  "application/rtf",
  "application/xml",
  "application/x-ms-regedit",
]);

function isUtf32LE(sample: Uint8Array): boolean {
  return (
    sample.length >= 4 &&
    sample[0] === 0xff &&
    sample[1] === 0xfe &&
    sample[2] === 0x00 &&
    sample[3] === 0x00
  );
}
function isUtf32BE(sample: Uint8Array): boolean {
  return (
    sample.length >= 4 &&
    sample[0] === 0x00 &&
    sample[1] === 0x00 &&
    sample[2] === 0xfe &&
    sample[3] === 0xff
  );
}
function isUtf16LE(sample: Uint8Array): boolean {
  return sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe;
}
function isUtf16BE(sample: Uint8Array): boolean {
  return sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff;
}
function detectTextBom(sample: Uint8Array): string | undefined {
  if (isUtf32LE(sample)) return "UTF-32LE";
  if (isUtf32BE(sample)) return "UTF-32BE";
  if (isUtf16LE(sample)) return "UTF-16LE";
  if (isUtf16BE(sample)) return "UTF-16BE";
  return undefined;
}

function isTextType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType);
}
function mimeToLFile(mime: string | undefined): LFile | undefined {
  if (mime === undefined || isTextType(mime)) return undefined;
  if (IMG_TYPES.has(mime)) return { kind: "image", mimeType: mime };
  return { kind: "binary", description: mime };
}

/** Snapshot identity and size: the only `fs.Stats` fields this codebase reads. */
export interface FileStats {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface LFileText {
  kind: "text";
  text: string;
  stats?: FileStats;
  hadUtf8DecodeErrors?: true;
}

export type LFile =
  | { kind: "directory" }
  | { kind: "image"; mimeType: string }
  | LFileText
  | { kind: "binary"; description: string };

export interface LoadFileOptions {
  maxLines?: number;
  displayPath?: string;
}

export async function loadFileKindAndText(
  filePath: string,
  options?: LoadFileOptions,
): Promise<LFile> {
  const pathStat = await fsStat(filePath);
  if (pathStat.isDirectory()) {
    return { kind: "directory" };
  }
  if (!pathStat.isFile()) {
    return {
      kind: "binary",
      description: "unsupported file type",
    };
  }
  if (pathStat.size > MAX_BYTES) {
    return {
      kind: "binary",
      description: `file exceeds ${MAX_BYTES} byte limit`,
    };
  }

  const fileHandle = await fsOpen(filePath, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, SNIFF_BYTES, 0);
    if (bytesRead === 0) {
      return { kind: "text", text: "", stats: pathStat };
    }

    const sample = buffer.subarray(0, bytesRead);
    const textBom = detectTextBom(sample);
    if (textBom) {
      return {
        kind: "binary",
        description: `${textBom} encoded text`,
      };
    }
    const detectedMimeType = (await fileTypeFromBuffer(sample))?.mime;
    const mimeFile = mimeToLFile(detectedMimeType);
    if (mimeFile) return mimeFile;
    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
    let utf8Suspect = false;
    let newlineCount = 0;
    const parts: string[] = [];
    function noteUtf8(decoded: string): void {
      if (!utf8Suspect && decoded.includes("\uFFFD")) utf8Suspect = true;
    }
    function trackNewlines(decoded: string): void {
      if (options?.maxLines === undefined) return;
      for (let i = 0; i < decoded.length; i++) if (decoded.charCodeAt(i) === 10) newlineCount++;
      if (newlineCount > options.maxLines) {
        throw new DomainError("E_LARGE_FILE", {
          path: options.displayPath ?? filePath,
          limitKind: "lines",
          limit: options.maxLines,
        });
      }
    }
    function decodeChunk(chunk: Uint8Array, stream: boolean): string {
      const decoded = decoder.decode(chunk, { stream });
      noteUtf8(decoded);
      trackNewlines(decoded);
      return decoded;
    }

    parts.push(decodeChunk(sample, true));

    let position = bytesRead;
    while (true) {
      const { bytesRead: chunkBytesRead } = await fileHandle.read(buffer, 0, SNIFF_BYTES, position);
      if (chunkBytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, chunkBytesRead);
      parts.push(decodeChunk(chunk, true));
      position += chunkBytesRead;
    }
    parts.push(decodeChunk(new Uint8Array(0), false));

    const text = parts.join("");
    let hadUtf8DecodeErrors = false;
    if (utf8Suspect) {
      const rawBytes = await readBytes(filePath);
      hadUtf8DecodeErrors = !Buffer.from(text, "utf-8").equals(rawBytes);
    }

    return {
      kind: "text",
      text,
      stats: pathStat,
      ...(hadUtf8DecodeErrors ? { hadUtf8DecodeErrors: true as const } : {}),
    };
  } finally {
    await fileHandle.close();
  }
}

/**
 * The non-printable control characters of the I2 byte-view notice (spec §6): C0 except the three
 * text whitespaces (\t, \n, \r) that render as layout, plus DEL and the C1 block. These are the
 * code points that reach the model invisibly, so a verbatim read names them instead of escaping
 * them — see docs/spec/search-and-read-evolution.md §6.
 */
// eslint-disable-next-line no-control-regex -- these code points ARE the notice's subject.
const NON_PRINTABLE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export interface ControlCharReport {
  /** Total occurrences, not distinct code points. */
  count: number;
  /** Distinct `U+XXXX` spellings, in first-encounter order. */
  codes: string[];
}

/** Scans emitted text for invisible control characters, reporting what a notice should name. */
export function scanControlChars(text: string): ControlCharReport {
  const codes: string[] = [];
  let count = 0;
  for (const char of text) {
    if (!NON_PRINTABLE_CONTROL_RE.test(char)) continue;
    count++;
    const code = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return { count, codes };
}
