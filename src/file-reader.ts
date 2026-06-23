import { constants } from "fs";
import { lineHashes } from "./hashline";
import { loadFileKindAndText, type LoadedFile } from "./file-kind";
import { toCwd } from "./path-utils";
import { detectEnding, toLF, stripBOM } from "./replace-diff";
import { abortIf } from "./runtime";
import { assertText, valAccess } from "./validation";

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
	preloadedFile?: LoadedFile,
): Promise<NormFile> {
	const absolutePath = toCwd(path, cwd);

	abortIf(signal);
	await valAccess(absolutePath, path, accessMode);

	abortIf(signal);
	const file = preloadedFile ?? (await loadFileKindAndText(absolutePath));
	assertText(file, path);

	abortIf(signal);
	const { bom, text: rawContent } = stripBOM(file.text);
	const originalEnding = detectEnding(rawContent);
	const normalized = toLF(rawContent);
	const fileHashes = lineHashes(normalized);

	return {
		absolutePath,
		normalized,
		bom,
		originalEnding,
		fileHashes,
		hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
	};
}
