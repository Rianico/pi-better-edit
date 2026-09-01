import { NOOP_LOOP_THRESHOLD } from "./constants.js";
import {
	buildRangeEcho,
	fmtServedRows,
	type ResolvedRange,
	type ServedRow,
} from "./hashline/served.js";
import { createSessionHandle } from "./served-session/session.js";

type NoopLoopEntry = {
	payload: string;
	count: number;
};

const noopLoopTracker = new Map<string, NoopLoopEntry>();

function noopPayloadKey(
	absolutePath: string,
	removeFrom: string,
	removeTo: string,
	replacementText: string,
): string {
	return JSON.stringify([absolutePath, removeFrom, removeTo, replacementText]);
}

function trackNoopPayload(
	absolutePath: string,
	payload: string,
): number {
	const existing = noopLoopTracker.get(absolutePath);
	const count =
		existing && existing.payload === payload ? existing.count + 1 : 1;
	noopLoopTracker.set(absolutePath, { payload, count });
	return count;
}

export function clearNoopLoop(absolutePath: string): void {
	noopLoopTracker.delete(absolutePath);
}

// NOOP_LOOP_THRESHOLD re-export removed

export interface NoopPolicyInput {
	absolutePath: string;
	removeFrom: string;
	removeTo: string;
	replacementText: string;
	ref: string;
	batch: boolean;
	range: ResolvedRange;
	hashes: string[];
	lines: string[];
	sessionKey: string;
}

export type NoopPolicyOutcome =
	| { action: "proceed"; count: number }
	| { action: "warn"; count: number; notice: string }
	| { action: "reject"; count: number; message: string; echoRows: ServedRow[] };

export async function runNoopPolicy(
	input: NoopPolicyInput,
): Promise<NoopPolicyOutcome> {
	const payload = noopPayloadKey(
		input.absolutePath,
		input.removeFrom,
		input.removeTo,
		input.replacementText,
	);
	const count = trackNoopPayload(input.absolutePath, payload);

	if (count >= NOOP_LOOP_THRESHOLD) {
		const echoRows = buildRangeEcho(
			input.range.startLine,
			input.range.endLine,
			input.hashes,
		);
		const echo = fmtServedRows(echoRows, input.lines);
		await createSessionHandle(input.sessionKey, input.absolutePath).recordEcho(echoRows, "live", input.hashes.length);
		const message = input.batch
			? `[E_NOOP_LOOP] ${input.ref}: identical edit (${input.removeFrom} → ${input.removeTo}) submitted ${count}×, no changes each time. Range already contains this text; resend will reject the batch. Current range:\n${echo}`
			: `[E_NOOP_LOOP] identical edit (${input.removeFrom} → ${input.removeTo} ${input.ref}) submitted ${count}×, no changes each time. Range already contains this text; resend will reject. Current range:\n${echo}`;
		return { action: "reject", count, message, echoRows };
	}

	if (count === 2) {
		const notice = input.batch
			? `[E_NOOP_LOOP] Notice: ${input.ref} — identical edit no-op'd twice; range already has this text. Resend will reject the batch.`
			: `[E_NOOP_LOOP] Notice: identical edit (${input.removeFrom} → ${input.removeTo} ${input.ref}) no-op'd twice; range already has this text. Resend will reject.`;
		return { action: "warn", count, notice };
	}

	return { action: "proceed", count };
}
