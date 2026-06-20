import { constants } from "fs";
import { access as fsAccess } from "fs/promises";
import type { LoadedFile } from "./file-kind";

export async function validateFileAccess(
	absolutePath: string,
	path: string,
	accessMode: number = constants.R_OK,
): Promise<void> {
	try {
		await fsAccess(absolutePath, accessMode);
	} catch (error: unknown) {
		const code = getErrorCode(error);
		if (code === "ENOENT") {
			throw new Error(`File not found: ${path}`);
		}
		if (code === "EACCES" || code === "EPERM") {
			const accessLabel = accessMode & constants.W_OK ? "not writable" : "not readable";
			throw new Error(`File is ${accessLabel}: ${path}`);
		}
		throw new Error(`Cannot access file: ${path}`);
	}
}

export function validateFileKind(file: LoadedFile, path: string): void {
	if (file.kind === "directory") {
		throw new Error(`Path is a directory: ${path}. Use ls to inspect directories.`);
	}
	if (file.kind === "binary") {
		throw new Error(`Path is a binary file: ${path} (${file.description}). Hashline edit only supports text files.`);
	}
	if (file.kind === "image") {
		throw new Error(`Path is an image file: ${path}. Hashline edit only supports text files.`);
	}
}

export function isTextFile(file: LoadedFile): file is { kind: "text"; text: string; hadUtf8DecodeErrors?: true } {
	return file.kind === "text";
}

export function getErrorCode(error: unknown): string | undefined {
	if (error instanceof Error) {
		return (error as NodeJS.ErrnoException).code;
	}
	return undefined;
}