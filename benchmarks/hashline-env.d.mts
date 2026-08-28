declare module "@oh-my-pi/hashline" {
	export class MismatchError extends Error {
		readonly path: string | undefined;
		readonly expectedFileHash: string;
		readonly actualFileHash: string;
	}

	export interface Filesystem {
		writeText(path: string, text: string): Promise<unknown>;
		readText(path: string): Promise<string>;
		canonicalPath(path: string): string;
		preflightWrite(path: string, opts: unknown): Promise<unknown>;
		allowTagPathRecovery(authored: string, resolved: string): boolean;
	}

	export class InMemoryFilesystem implements Filesystem {
		writeText(path: string, text: string): Promise<void>;
		readText(path: string): Promise<string>;
		canonicalPath(path: string): string;
		preflightWrite(path: string, opts: unknown): Promise<void>;
		allowTagPathRecovery(authored: string, resolved: string): boolean;
	}

	export type SnapshotLookupResult = string | undefined;

	export abstract class SnapshotStore {
		abstract record(
			path: string,
			fullText: string,
			seenLines?: Iterable<number>,
		): string;
		abstract byHash(path: string, hash: string): SnapshotLookupResult;
		abstract byContent(path: string, text: string): SnapshotLookupResult;
	}

	export class InMemorySnapshotStore extends SnapshotStore {
		record(path: string, fullText: string, seenLines?: Iterable<number>): string;
		byHash(path: string, hash: string): SnapshotLookupResult;
		byContent(path: string, text: string): SnapshotLookupResult;
	}

	export interface SectionResult {
		path: string;
		op: string;
		before: string;
		after: string;
		fileHash: string;
		header: string;
		warnings?: string[];
	}

	export interface Patch {
		sections: unknown[];
	}

	export interface PatcherOptions {
		fs: Filesystem;
		snapshots: SnapshotStore;
	}

	export class Patcher {
		constructor(options: PatcherOptions);
		apply(patch: Patch): Promise<{ sections: SectionResult[] }>;
	}

	export const Patch: {
		parse(input: string): Patch;
	};
}
