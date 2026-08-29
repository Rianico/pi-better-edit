import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { MAX_BYTES, SNIFF_BYTES } from "../constants.js";

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

export type LFile =
	| { kind: "directory" }
	| { kind: "image"; mimeType: string }
	| { kind: "text"; text: string; hadUtf8DecodeErrors?: true }
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
			return { kind: "text", text: "" };
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
		let hadUtf8DecodeErrors = false;
		let newlineCount = 0;
		const parts: string[] = [];
		function noteUtf8(decoded: string): void {
			if (!hadUtf8DecodeErrors && decoded.includes("\uFFFD"))
				hadUtf8DecodeErrors = true;
		}
		function trackNewlines(decoded: string): void {
			if (options?.maxLines === undefined) return;
			for (let i = 0; i < decoded.length; i++)
				if (decoded.charCodeAt(i) === 10) newlineCount++;
			if (newlineCount > options.maxLines) {
				throw new Error(
					`[E_FILE_TOO_LARGE] ${options.displayPath ?? filePath} has more than ${options.maxLines} lines, exceeding the ${options.maxLines}-line edit limit. Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.`,
				);
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
			parts.push(decodeChunk(chunk, true));
			position += chunkBytesRead;
		}
		parts.push(decodeChunk(new Uint8Array(0), false));

		return {
			kind: "text",
			text: parts.join(""),
			...(hadUtf8DecodeErrors ? { hadUtf8DecodeErrors: true as const } : {}),
		};
	} finally {
		await fileHandle.close();
	}
}
