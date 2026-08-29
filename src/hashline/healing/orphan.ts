import type { OrphanContext, HealResult } from "./types.js";
import { healSingleCanon } from "./single-canon.js";
import { healBoundaryCanon } from "./boundary.js";

export const OrphanHeal = {
	name: "orphan" as const,
	tryHeal(ctx: OrphanContext): HealResult {
		const single = healSingleCanon({
			served: ctx.served,
			currentLen: ctx.currentLen,
			fileLines: ctx.fileLines,
			startPositions: ctx.startPositions,
			endPositions: ctx.endPositions,
			store: ctx.store,
		});
		if (single) return single;
		return healBoundaryCanon({
			served: ctx.served,
			startHash: ctx.startHash,
			endHash: ctx.endHash,
			currentLen: ctx.currentLen,
			fileLines: ctx.fileLines,
			fileHashes: ctx.fileHashes,
			store: ctx.store,
		});
	},
};

export function healOrphanedSpan(ctx: OrphanContext): HealResult {
	return OrphanHeal.tryHeal(ctx);
}
