import type { BoundaryCanonContext, HealResult } from "./types.js";
import { findCanonMatches, isUniqueSection } from "./helpers.js";

export const BoundaryHeal = {
	name: "boundary" as const,
	tryHeal(ctx: BoundaryCanonContext): HealResult {
		const { served, startHash, endHash, currentLen, fileLines, fileHashes, store } = ctx;
		if (!served.some((h) => h !== null) || (fileHashes.includes(startHash) && fileHashes.includes(endHash))) return undefined;
		const startCanon = store.get(startHash);
		const endCanon = store.get(endHash);
		if (startCanon === undefined || endCanon === undefined) return undefined;
		const startMatches = findCanonMatches(fileLines, startCanon);
		const endMatches = findCanonMatches(fileLines, endCanon);
		if (startMatches.length !== 1 || endMatches.length !== 1) return undefined;
		const healedFrom = Math.min(startMatches[0]!, endMatches[0]!);
		const healedTo = Math.max(startMatches[0]!, endMatches[0]!);
		if (healedTo - healedFrom + 1 !== currentLen) return undefined;
		if (!isUniqueSection(fileLines, healedFrom, currentLen)) return undefined;
		return { from: healedFrom, to: healedTo };
	},
};

export function healBoundaryCanon(ctx: BoundaryCanonContext): HealResult {
	return BoundaryHeal.tryHeal(ctx);
}
