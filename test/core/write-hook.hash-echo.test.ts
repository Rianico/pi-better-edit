import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	findServedHashEcho,
	servedHashEchoDenial,
	registerWriteHook,
} from "../../src/write-hook";
import { initHasher, lineHashes } from "../../src/hashline";
import { recordServed } from "../../src/served-state";
import { withTempDir } from "../support/fixtures";
import { resolveTarget } from "../../src/fs-write";
import { toCwd } from "../../src/paths";

type ToolCallHandler = (
	event: { toolName: string; input: Record<string, unknown> },
	ctx: { cwd: string; sessionManager: { getSessionId(): string }; signal?: AbortSignal },
) => Promise<{ block?: boolean; reason?: string } | void>;

function localIO() {
	return {
		resolve: async (p: string, cwd: string, signal?: AbortSignal) => {
			if (signal?.aborted) throw new Error("Operation aborted");
			return resolveTarget(toCwd(p, cwd));
		},
	};
}

async function servedPreviewForFile(path: string, cwd: string, sessionKey: string): Promise<string> {
	await initHasher();
	const content = await readFile(path, "utf-8");
	const hashes = await lineHashes(content, path);
	const rows = hashes.map((hash, idx) => ({ position: idx, hash }));
	await recordServed(sessionKey, await resolveTarget(path), rows);
	const { fmtRegion } = await import("../../src/hashline");
	const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	if (lines.length === 1 && lines[0] === "") {
		// empty file handling not needed for this test
		return `${hashes[0]}│`;
	}
	return fmtRegion(hashes, lines);
}

describe("write hash-echo guard", () => {
	it("allows clean content and unrelated literal hash-like text", () => {
		const served: (string | null)[] = ["Ab3", "Cd4", null];
		expect(findServedHashEcho("# Notes\nbody\n", served)).toBeUndefined();
		expect(
			findServedHashEcho("Zz9│literal protocol text\nbody\n", served),
		).toBeUndefined();
		expect(
			findServedHashEcho("prefix Ab3│is ordinary text\nbody\n", served),
		).toBeUndefined();
	});

	it("matches only the exact served anchor at the same line", () => {
		const served: (string | null)[] = ["Ab3", "Cd4"];
		expect(findServedHashEcho("Ab3│# Notes\nbody\n", served)).toEqual({
			line: 1,
			hash: "Ab3",
		});
		expect(
			findServedHashEcho("Cd4│wrong line\nAb3│wrong line\n", served),
		).toBeUndefined();
	});

	it("catches a repeated historical chain when its outer anchor is current", () => {
		expect(
			findServedHashEcho("Ab3│nT2│CCd│UIA│## 1. H1\n", ["Ab3"]),
		).toEqual({ line: 1, hash: "Ab3" });
	});

	it("rejects a copied current preview before the write body can change disk", async () => {
		await withTempDir("write-hash-echo-red-", async (cwd) => {
			await initHasher();
			const path = join(cwd, "notes.md");
			const original = "# Notes\nbody\n";
			await writeFile(path, original, "utf-8");
			const beforeBytes = await readFile(path);

			const io = localIO();
			const sessionKey = "session-a";
			const previewText = await servedPreviewForFile(path, cwd, sessionKey);

			const listeners = new Map<string, ToolCallHandler>();
			const pi = {
				on(event: string, handler: unknown) {
					listeners.set(event, handler as ToolCallHandler);
				},
			} as unknown as Parameters<typeof registerWriteHook>[0];
			registerWriteHook(pi);

			const listener = listeners.get("tool_call");
			expect(listener).toBeDefined();
			if (!listener) return;

			const result = await listener(
				{
					toolName: "write",
					input: { path, content: previewText },
				},
				{
					cwd,
					sessionManager: { getSessionId: () => sessionKey },
					signal: new AbortController().signal,
				},
			);

			expect(result).toMatchObject({ block: true });
			expect((result as { reason?: string }).reason).toContain("[E_WRITE_HASH_ECHO]");
			expect((result as { reason?: string }).reason).toContain("HASH│ anchors are tool output");
			expect(await readFile(path)).toEqual(beforeBytes);

			const cleanResult = await listener(
				{
					toolName: "write",
					input: { path, content: "# Updated\nbody\n" },
				},
				{
					cwd,
					sessionManager: { getSessionId: () => sessionKey },
					signal: new AbortController().signal,
				},
			);
			expect(cleanResult).toBeUndefined();
			expect(await readFile(path)).toEqual(beforeBytes);
		});
	});

	it("does not reuse served state across sessions or canonical paths", async () => {
		await withTempDir("write-hash-echo-scope-", async (cwd) => {
			await initHasher();
			const io = localIO();
			const servedPath = join(cwd, "served.md");
			const otherPath = join(cwd, "other.md");
			await writeFile(servedPath, "served line\n", "utf-8");
			await writeFile(otherPath, "other line\n", "utf-8");
			const previewText = await servedPreviewForFile(servedPath, cwd, "session-a");

			await expect(
				servedHashEchoDenial(
					io,
					servedPath,
					previewText,
					cwd,
					"session-b",
				),
			).resolves.toBeUndefined();
			await expect(
				servedHashEchoDenial(
					io,
					otherPath,
					previewText,
					cwd,
					"session-a",
				),
			).resolves.toBeUndefined();
		});
	});

	it("uses exact served hash at absolute line — not generic 3-char prefix", async () => {
		await withTempDir("write-hash-echo-generic-", async (cwd) => {
			await initHasher();
			const io = localIO();
			const path = join(cwd, "doc.md");
			await writeFile(path, "hello\n", "utf-8");
			// serve Ab3 at line 1
			const abs = await resolveTarget(path);
			await recordServed("s1", abs, [{ position: 0, hash: "Ab3" }]);
			// Zz9 is not served at line 1, should not be blocked even though it looks like hash│
			await expect(
				servedHashEchoDenial(io, path, "Zz9│literal text\n", cwd, "s1"),
			).resolves.toBeUndefined();
			// Ab3 at line 1 should be blocked
			await expect(
				servedHashEchoDenial(io, path, "Ab3│hello\n", cwd, "s1"),
			).resolves.toMatch(/\[E_WRITE_HASH_ECHO\]/);
		});
	});

	it("formats the E_WRITE_HASH_ECHO message exactly per ADR-0009", async () => {
		await withTempDir("write-hash-echo-msg-", async (cwd) => {
			await initHasher();
			const io = localIO();
			const path = join(cwd, "notes.md");
			await writeFile(path, "line\n", "utf-8");
			const abs = await resolveTarget(path);
			await recordServed("sess", abs, [{ position: 0, hash: "Ab3" }]);
			const reason = await servedHashEchoDenial(io, path, "Ab3│line\n", cwd, "sess");
			expect(reason).toBe(
				`[E_WRITE_HASH_ECHO] Refused write to ${path}: line 1 begins with the exact Ab3│ anchor served for this session, path, and line. HASH│ anchors are tool output, not file content. Retry with file content only (remove the entire copied anchor chain). Nothing was written.`,
			);
		});
	});
});
