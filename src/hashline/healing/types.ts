import type { CanonStore } from "../hash.js";

export interface HealingContext {
	served: (string | null)[];
	fileLines: string[];
	fileHashes: string[];
	startHash: string;
	endHash: string;
	currentLen: number;
	startLine: number;
	startPositions: number[];
	endPositions: number[];
	store: CanonStore;
}

export interface SingleCanonContext {
	served: (string | null)[];
	currentLen: number;
	fileLines: string[];
	startPositions: number[];
	endPositions: number[];
	store: CanonStore;
}

export interface BoundaryCanonContext {
	served: (string | null)[];
	startHash: string;
	endHash: string;
	currentLen: number;
	fileLines: string[];
	fileHashes: string[];
	store: CanonStore;
}

export type OrphanContext = HealingContext;

export type HealResult = { from: number; to: number } | undefined;

export interface HealingStrategy {
	readonly name: string;
	tryHeal(ctx: HealingContext): HealResult;
}
