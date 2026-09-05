import { describe, expect, it, vi } from "vitest";
import {
	DebouncedPreview,
	PREVIEW_DEBOUNCE_MS,
	type PreviewHost,
} from "../../src/preview-controller";
import type { RPreview, RRState } from "../../src/edit-render";

const sampleArgs = {
	path: "sample.ts",
	edits: [["AAA", "BBB", "x"]],
};
const otherArgs = {
	path: "sample.ts",
	edits: [["AAA", "BBB", "y"]],
};

function makeHost(overrides: Partial<PreviewHost> = {}): {
	host: PreviewHost;
	state: RRState;
	invalidated: Promise<void>;
} {
	const state: RRState = {};
	let notifyInvalidate: (() => void) | undefined;
	const invalidated = new Promise<void>((resolve) => {
		notifyInvalidate = resolve;
	});
	const host: PreviewHost = {
		cwd: "/tmp",
		executionStarted: false,
		argsComplete: true,
		state,
		invalidate: () => notifyInvalidate?.(),
		...overrides,
	};
	return { host, state, invalidated };
}

describe("DebouncedPreview", () => {
	it("debounces and only the last args produce a preview", async () => {
		vi.useFakeTimers();
		try {
			const compute = vi.fn(async () => ({ diff: "D" }));
			const controller = new DebouncedPreview(compute);
			const { host, state, invalidated } = makeHost();
			controller.renderCall(host, sampleArgs);
			controller.renderCall(host, otherArgs);
			expect(compute).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 1);
			expect(compute).not.toHaveBeenCalled();
			const settled = invalidated;
			await vi.advanceTimersByTimeAsync(1);
			await settled;
			expect(compute).toHaveBeenCalledTimes(1);
			expect(compute).toHaveBeenCalledWith(otherArgs, "/tmp");
			expect(state.preview).toEqual({ diff: "D" });
			expect(state.previewTimer).toBeUndefined();
			expect(state.argsKey).toBe(
				JSON.stringify({
					file: "sample.ts",
					edits: [
						{
							anchor_from: "AAA",
							anchor_to: "BBB",
							replace_with: "y",
						},
					],
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects a stale preview that settles after the result cleared", async () => {
		vi.useFakeTimers();
		try {
			let resolveCompute: ((preview: RPreview) => void) | undefined;
			const controller = new DebouncedPreview(
				(_args: unknown, _cwd: string) =>
					new Promise<RPreview>((resolve) => {
						resolveCompute = resolve;
					}),
			);
			const { host, state } = makeHost();
			controller.renderCall(host, sampleArgs);
			await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
			expect(resolveCompute).toBeDefined();
			controller.clearResult(state);
			resolveCompute!({ diff: "STALE" });
			await Promise.resolve();
			await Promise.resolve();
			expect(state.preview).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects a stale preview when the args moved on before settling", async () => {
		vi.useFakeTimers();
		try {
			let resolveCompute: ((preview: RPreview) => void) | undefined;
			const controller = new DebouncedPreview(
				(_args: unknown, _cwd: string) =>
					new Promise<RPreview>((resolve) => {
						resolveCompute = resolve;
					}),
			);
			const { host, state } = makeHost();
			controller.renderCall(host, sampleArgs);
			await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
			controller.renderCall(host, otherArgs);
			resolveCompute!({ diff: "STALE" });
			await Promise.resolve();
			await Promise.resolve();
			expect(state.preview).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears pending preview state once execution has started", () => {
		const controller = new DebouncedPreview(async () => ({ diff: "D" }));
		const { host, state } = makeHost({ executionStarted: true });
		state.argsKey = "stale";
		state.preview = { diff: "stale diff" };
		state.previewGeneration = 7;
		controller.renderCall(host, sampleArgs);
		expect(state.argsKey).toBeUndefined();
		expect(state.preview).toBeUndefined();
		expect(state.previewGeneration).toBe(8);
		expect(state.previewTimer).toBeUndefined();
	});

	it("clears pending preview state while args are incomplete", () => {
		const controller = new DebouncedPreview(async () => ({ diff: "D" }));
		const { host, state } = makeHost({ argsComplete: false });
		state.argsKey = "stale";
		state.preview = { diff: "stale diff" };
		state.previewGeneration = 2;
		controller.renderCall(host, sampleArgs);
		expect(state.argsKey).toBeUndefined();
		expect(state.preview).toBeUndefined();
		expect(state.previewGeneration).toBe(3);
		expect(state.previewTimer).toBeUndefined();
	});

	it("does not schedule a preview when args lack the edit shape", () => {
		vi.useFakeTimers();
		try {
			const compute = vi.fn(async () => ({ diff: "D" }));
			const controller = new DebouncedPreview(compute);
			const { host, state } = makeHost();
			controller.renderCall(host, { path: "sample.ts", changes: [] });
			vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
			expect(compute).not.toHaveBeenCalled();
			expect(state.preview).toBeUndefined();
			expect(state.previewTimer).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not recompute for identical args once a preview exists", async () => {
		vi.useFakeTimers();
		try {
			const compute = vi.fn(async () => ({ diff: "D" }));
			const controller = new DebouncedPreview(compute);
			const { host, state, invalidated } = makeHost();
			controller.renderCall(host, sampleArgs);
			await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
			await invalidated;
			expect(state.preview).toEqual({ diff: "D" });
			controller.renderCall(host, sampleArgs);
			await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
			expect(compute).toHaveBeenCalledTimes(1);
			expect(state.preview).toEqual({ diff: "D" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("surfaces a compute error as the preview", async () => {
		vi.useFakeTimers();
		try {
			const controller = new DebouncedPreview(async () => {
				throw new Error("boom");
			});
			const { host, state, invalidated } = makeHost();
			controller.renderCall(host, sampleArgs);
			const settled = invalidated;
			await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
			await settled;
			expect(state.preview).toEqual({ error: "boom" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("surfaces a non-Error rejection as a string preview", async () => {
		vi.useFakeTimers();
		try {
			const controller = new DebouncedPreview(async () => {
				throw "boom";
			});
			const { host, state, invalidated } = makeHost();
			controller.renderCall(host, sampleArgs);
			const settled = invalidated;
			await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
			await settled;
			expect(state.preview).toEqual({ error: "boom" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("clearResult clears the timer and preview but keeps argsKey", async () => {
		vi.useFakeTimers();
		try {
			const controller = new DebouncedPreview(async () => ({ diff: "D" }));
			const { host, state } = makeHost();
			controller.renderCall(host, sampleArgs);
			expect(state.argsKey).toBeDefined();
			expect(state.previewTimer).toBeDefined();
			const argsKey = state.argsKey;
			const generation = state.previewGeneration;
			controller.clearResult(state);
			expect(state.previewTimer).toBeUndefined();
			expect(state.preview).toBeUndefined();
			expect(state.argsKey).toBe(argsKey);
			expect(state.previewGeneration).toBe((generation ?? 0) + 1);
			await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
			expect(state.preview).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
