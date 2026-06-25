import { open as fsOpen, stat as fsStat } from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { SNIFF_BYTES, MAX_BYTES } from "./constants";

const IMG_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const TEXT_TYPES = new Set<string>([
  "application/rtf",
  "application/xml",
  "application/x-ms-regedit",
]);

function isTextType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType);
}

export type FKind =
  | { kind: "directory" }
  | { kind: "image"; mimeType: string }
  | { kind: "text" }
  | { kind: "binary"; description: string };

export type LFile =
  | { kind: "directory" }
  | { kind: "image"; mimeType: string }
  | { kind: "text"; text: string; hadUtf8DecodeErrors?: true }
  | { kind: "binary"; description: string };

function hasNull(buffer: Uint8Array): boolean {
  return buffer.includes(0);
}

export async function loadFileKindAndText(
  filePath: string,
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
      description: `file exceeds ${MAX_BYTES} byte limit`
    };
  }

  const fileHandle = await fsOpen(filePath, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      SNIFF_BYTES,
      0,
    );
    if (bytesRead === 0) {
      return { kind: "text", text: "" };
    }

    const sample = buffer.subarray(0, bytesRead);
    const detectedMimeType = (await fileTypeFromBuffer(sample))?.mime;
    if (
      detectedMimeType !== undefined &&
      !isTextType(detectedMimeType)
    ) {
      if (IMG_TYPES.has(detectedMimeType)) {
        return { kind: "image", mimeType: detectedMimeType };
      }
      return {
        kind: "binary",
        description: detectedMimeType,
      };
    }
    if (hasNull(sample)) {
      return {
        kind: "binary",
        description: "null bytes detected",
      };
    }

    const decoder = new TextDecoder("utf-8");
    const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
    let hadUtf8DecodeErrors = false;
    const noteUtf8Err = (chunk?: Uint8Array): void => {
      if (hadUtf8DecodeErrors) return;
      try {
        fatalDecoder.decode(chunk, { stream: chunk !== undefined });
      } catch (error: unknown) {
        if (error instanceof TypeError) {
          hadUtf8DecodeErrors = true;
          return;
        }
        throw error;
      }
    };

    noteUtf8Err(sample);
    const parts: string[] = [decoder.decode(sample, { stream: true })];

    let position = bytesRead;
    while (true) {
      const { bytesRead: chunkBytesRead } = await fileHandle.read(
        buffer,
        0,
        SNIFF_BYTES,
        position,
      );
      if (chunkBytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, chunkBytesRead);
      if (hasNull(chunk)) {
        return {
          kind: "binary",
          description: "null bytes detected",
        };
      }
      noteUtf8Err(chunk);
      parts.push(decoder.decode(chunk, { stream: true }));
      position += chunkBytesRead;
    }

    noteUtf8Err();
    parts.push(decoder.decode());

    return {
      kind: "text",
      text: parts.join(""),
      ...(hadUtf8DecodeErrors ? { hadUtf8DecodeErrors: true as const } : {}),
    };
  } finally {
    await fileHandle.close();
  }
}

export async function classifyFileKind(filePath: string): Promise<FKind> {
  const loaded = await loadFileKindAndText(filePath);
  switch (loaded.kind) {
    case "directory":
      return loaded;
    case "image":
      return loaded;
    case "binary":
      return loaded;
    case "text":
      return { kind: "text" };
  }
}
