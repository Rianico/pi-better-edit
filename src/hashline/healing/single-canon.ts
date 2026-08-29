import { canon } from "../hash.js";
import type { SingleCanonContext, HealResult } from "./types.js";

export const SingleCanonHeal = {
	name: "single-canon" as const,
	tryHeal(ctx: SingleCanonContext): HealResult {
		const { served, currentLen, fileLines, startPositions, endPositions, store } = ctx;
		if (startPositions.length !== 1 || endPositions.length !== 1) return undefined;
		const sPos = startPositions[0]!;
		const ePos = endPositions[0]!;
		const servedFrom = Math.min(sPos, ePos);
		const servedTo = Math.max(sPos, ePos);
		const servedLen = servedTo - servedFrom + 1;
		if (servedLen !== currentLen) return undefined;

		const expectedCanons: string[] = [];
		for (let k = 0; k < servedLen; k++) {
			const h = served[servedFrom + k];
			if (h === null) return undefined;
			const c = store.get(h);
			if (c === undefined) return undefined;
			expectedCanons.push(c);
		}

		const matches: number[] = [];
		for (let i = 0; i <= fileLines.length - servedLen; i++) {
			let ok = true;
			for (let k = 0; k < servedLen; k++) {
				if (canon(fileLines[i + k] ?? "") !== expectedCanons[k]) {
					ok = false;
					break;
				}
			}
			if (ok) matches.push(i);
			if (matches.length > 1) break;
		}
		if (matches.length === 1) {
			return { from: matches[0]!, to: matches[0]! + servedLen - 1 };
		}
		return undefined;
	},
};

export function healSingleCanon(ctx: SingleCanonContext): HealResult {
	return SingleCanonHeal.tryHeal(ctx);
}
