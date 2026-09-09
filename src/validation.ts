import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { LFile } from "./file-kind.js";
import { errCode } from "./utils.js";

export async function valAccess(
	absolutePath: string,
	path: string,
	accessMode: number = constants.R_OK,
): Promise<void> {
	try {
		await fsAccess(absolutePath, accessMode);
	} catch (error: unknown) {
		const code = errCode(error);
		if (code === "ENOENT") {
			throw new Error(`[MODEL] [E_NOT_FOUND] File not found: ${path}. Check the "file" value (a text file, never a directory); use ls on the parent directory and retry with the corrected file.`);
		}
		if (code === "EACCES" || code === "EPERM") {
			const accessLabel = accessMode & constants.W_OK ? "not writable" : "not readable";
			throw new Error(`[MODEL] [E_ACCESS] File is ${accessLabel}: ${path}. Fix permissions or choose a writable file and retry.`);
		}
		if (code === "ELOOP") {
			throw new Error(`[MODEL] [E_ACCESS] Too many symbolic links while resolving: ${path}. Retry with the real file location.`);
		}
		throw new Error(`[MODEL] [E_ACCESS] Cannot access file: ${path}. Verify the "file" value exists and is reachable, then retry.`);
	}
}

export function valKind(file: LFile, path: string): asserts file is { kind: "text"; text: string; hadUtf8DecodeErrors?: true } {
	if (file.kind === "directory") {
		throw new Error(`[MODEL] [E_UNSUPPORTED_FILE] Path is a directory: ${path}. Pass the text file inside it (a file, never a directory) in "file" and retry.`);
	}
	if (file.kind === "binary") {
		throw new Error(`[MODEL] [E_UNSUPPORTED_FILE] Path is a binary file: ${path} (${file.description}). Hashline edit only supports text files; choose a text file and retry.`);
	}
	if (file.kind === "image") {
		throw new Error(`[MODEL] [E_UNSUPPORTED_FILE] Path is an image file: ${path}. Hashline edit only supports text files; choose a text file and retry.`);
	}
}

