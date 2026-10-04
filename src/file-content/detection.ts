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

// WHY: narrowing `fs.Stats` to the fields this codebase reasons about keeps `node:fs` out of the
// WHY: domain types, so callers — tests included — can hand over a plain object, not a `Stats` fixture.
/** Snapshot identity and size: the only `fs.Stats` fields this codebase reads. */
export interface FileStats {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface LFileText {
  kind: "text";
  text: string;
  // WHY: the load path already stat'd this path; handing the result to the caller keeps the read
  // WHY: path at one `stat` syscall per file instead of re-stat'ing for the snapshot id.
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
    // WHY: (04b-rem P2-3) an invalid UTF-8 sequence ALWAYS makes a non-fatal decoder emit U+FFFD,
    // WHY: so the absence of U+FFFD proves the round-trip is lossless; its presence proves
    // WHY: nothing — the file may legitimately contain the replacement character. Suspicion
    // WHY: therefore decides what to CHECK, never what to REPORT: the report is the byte
    // WHY: comparison below, which tells a corrupt file and a legal U+FFFD character apart.
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
          // WHY: the counter's value at the trip instant, so the refusal names
          // WHY: the observed count rather than "more than the limit".
          lineCount: newlineCount,
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
    // WHY: the round-trip ORACLE: the decoded text is line-addressable without loss exactly when
    // WHY: re-encoding it equals the file's bytes. Runs only on suspicion; re-reading the file is
    // WHY: cheaper than keeping a parallel raw copy for every clean file.
    // WHY: (04b-rem2 suggestion 1) the byte read goes through the file layer's ONE primitive —
    // WHY: the oracle and every restore/compare site now read bytes the same way, including the
    // WHY: BOM: the WHOLE byte image is compared, nothing is stripped at the oracle site.
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
