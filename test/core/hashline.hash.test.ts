import { describe, expect, it } from "vitest";
import {
	applyEdits,
	lineHash,
	lineHashes,
	parseText,
} from "../../src/hashline";

describe("lineHash", () => {
	it("returns a 3-character string from the URL-safe base64 alphabet", () => {
		const hash = lineHash(1, "hello");
		expect(hash).toHaveLength(3);
		expect(hash).toMatch(/^[A-Za-z0-9_\-]{3}$/);
	});

	it("trims trailing whitespace without collapsing internal spaces", () => {
		expect(lineHash(1, "a\t")).toBe(lineHash(1, "a"));
		expect(lineHash(1, "a  b")).not.toBe(lineHash(1, "a b"));
	});

	it("strips trailing CR", () => {
		expect(lineHash(1, "hello\r")).toBe(lineHash(1, "hello"));
	});

	it("same content produces same hash", () => {
		const h1 = lineHash(1, "}");
		const h10 = lineHash(10, "}");
		expect(h1).toMatch(/^[A-Za-z0-9_\-]{3}$/);
		expect(h1).toBe(h10);
	});
});

describe("strict hashline contract", () => {
	it("preserves internal spaces when hashing", () => {
		expect(lineHash(1, "a b")).not.toBe(lineHash(1, "ab"));
	});

	it("trims trailing spaces when hashing", () => {
		expect(lineHash(1, "value  ")).toBe(lineHash(1, "value"));
	});

	it("preserves explicit blank trailing line in array input", () => {
		expect(parseText(["alpha", ""])).toEqual(["alpha", ""]);
	});

	it("rejects stale anchors instead of relocating by hash", () => {
		const content = ["a", "INSERTED", "b", "target", "c"].join("\n");
		const stale = {
      hash_range_incl: [{ hash: "ZZZZ" }, { hash: "ZZZZ" }], content_lines: ["updated"],
    } as any;
		expect(() => applyEdits(content, [stale])).toThrow(/stale anchor/);
	});
});

describe("perfect hashing", () => {
	it("returns one hash per line, indexed 0-based by line number", () => {
		const hashes = lineHashes("alpha\nbeta\ngamma");
		expect(hashes).toHaveLength(3);
		expect(hashes[0]).toMatch(/^[A-Za-z0-9_\-]{3}$/);
		expect(hashes[1]).toMatch(/^[A-Za-z0-9_\-]{3}$/);
		expect(hashes[2]).toMatch(/^[A-Za-z0-9_\-]{3}$/);
	});

	it("assigns different hashes to identical content at different positions", () => {
		const file = [
			"import { foo } from 'bar';",
			"import { baz } from 'qux';",
			"import { foo } from 'bar';",
		].join("\n");
		const hashes = lineHashes(file);
		expect(hashes[0]).not.toBe(hashes[2]);
		expect(hashes[0]).not.toBe(hashes[1]);
		expect(hashes[1]).not.toBe(hashes[2]);
	});

	it("assigns different hashes to symbol-only lines at different positions", () => {
		const file = [
			"function a() {",
			"  return 1;",
			"}",
			"function b() {",
			"  return 2;",
			"}",
		].join("\n");
		const hashes = lineHashes(file);
		expect(hashes[2]).not.toBe(hashes[5]);
	});

	it("lets the edit tool target a specific occurrence when content is duplicated", () => {
		const file = [
			"const x = 1;",
			"const y = 2;",
			"const x = 1;",
		].join("\n");
		const hashes = lineHashes(file);
		const result = applyEdits(file, [
      { hash_range_incl: [{ hash: hashes[2]! }, { hash: hashes[2]! }], content_lines: ["const x = 999;"] },
    ]);
    expect(result.content).toBe("const x = 1;\nconst y = 2;\nconst x = 999;");
	});

	it("stale-anchor error shows the file's current state for context", () => {
		const file = ["const x = 1;", "const y = 2;", "const x = 1;"].join("\n");
		const staleHash = "ZZZZ";
		let caught: Error | undefined;
		try {
			applyEdits(file, [
        { hash_range_incl: [{ hash: staleHash }, { hash: staleHash }], content_lines: ["X"] },
      ]);
    } catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
		expect(caught!.message).toContain("Call read()");
	});

	it("rejects an ambiguous hash with [E_AMBIGUOUS_ANCHOR] (synthetic collision)", () => {
		const file = "alpha\nbeta\ngamma\ndelta";
		const realHashes = lineHashes(file);
		const forgedHashes = [...realHashes];
		forgedHashes[2] = realHashes[0]!;

		const sharedHash = realHashes[0]!;

		let caught: Error | undefined;
		try {
			applyEdits(
				file,
        [
          { hash_range_incl: [{ hash: sharedHash }, { hash: sharedHash }], content_lines: ["X"] },
        ],
        undefined,
        forgedHashes,
      );
    } catch (error) {
			caught = error as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_AMBIGUOUS_ANCHOR/);
		expect(caught!.message).toMatch(/matches lines 1, 3/);
		expect(caught!.message).toContain(`${realHashes[0]!}│alpha`);
		expect(caught!.message).toContain(`${realHashes[0]!}│gamma`);
	});

	it("all hashes are unique for any file shape", () => {
		const files = [
			"",
			"\n",
			"a",
			"a\n",
			"a\nb\nc",
			"a\nb\nc\n",
			"}\n}\n}\n}\n}",
			"import x\nimport y\nimport x",
			"a\n".repeat(1000),
			Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"),
		];
		for (const file of files) {
			const hashes = lineHashes(file);
			const unique = new Set(hashes);
			expect(
				unique.size,
				`Failed for file with ${file.split("\n").length} lines`
			).toBe(hashes.length);
		}
	});

	it("hash array length matches line count for edge cases", () => {
		const cases = ["", "\n", "a", "a\n", "a\nb\nc\n"];
		for (const file of cases) {
			expect(lineHashes(file)).toHaveLength(file.split("\n").length);
		}
	});
});
