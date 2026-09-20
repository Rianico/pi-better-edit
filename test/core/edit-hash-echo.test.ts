import { describe, expect, it, beforeAll } from "vitest";
import { _lineHashesPure } from "../../src/hashline/hash";
import { findServedHashEcho, applyEdit, ServedHashEchoError } from "../../src/hashline/apply";
import { initHasher } from "../../src/hashline/hasher";
import { HASH_SEP, canon } from "../../src/hashline/hash-identity";
import type { LeaseIdentityView, LeaseSpanSource, HEdit } from "../../src/hashline/resolve";

beforeAll(async () => {
  await initHasher();
});

function canonsFor(content: string): (string | null)[] {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  if (content === "") return [];
  return lines.map((line) => canon(line));
}

describe("findServedHashEcho — evidence, never shape", () => {
  it("detects a verbatim served row at any position", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const canons = canonsFor(content);
    // hash for line 1 placed at candidate 1 with its served content verbatim
    const hit = findServedHashEcho([`${hashes[0]}${HASH_SEP}one`], served, canons, 1);
    expect(hit).toMatchObject({ k: 1, hash: hashes[0], servedLine: 1 });
  });

  it("detects a multi-row chain copied from another position", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const canons = canonsFor(content);
    // rows for lines 1-2 reproduced verbatim, submitted as a chain
    const hit = findServedHashEcho(
      [`${hashes[0]}${HASH_SEP}one`, `${hashes[1]}${HASH_SEP}two`],
      served,
      canons,
      1,
    );
    expect(hit).toMatchObject({ k: 1, hash: hashes[0], servedLine: 1 });
  });

  it("detects a verbatim row copied from another position", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const canons = canonsFor(content);
    // line-1 row submitted where line-2 content is expected: position-agnostic
    const hit = findServedHashEcho([`${hashes[0]}${HASH_SEP}one`], served, canons, 2);
    expect(hit).toMatchObject({ k: 1, hash: hashes[0], servedLine: 1 });
  });

  it("tolerates one leading diff marker", () => {
    const content = "one\ntwo";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const canons = canonsFor(content);
    for (const marker of ["+", "-", " "]) {
      const hit = findServedHashEcho([`${marker}${hashes[1]}${HASH_SEP}two`], served, canons, 1);
      expect(hit).toMatchObject({ hash: hashes[1], servedLine: 2 });
    }
  });

  it("stays silent for a served prefix with differing content", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const canons = canonsFor(content);
    const hit = findServedHashEcho([`${hashes[1]}${HASH_SEP}CHANGED`], served, canons, 1);
    expect(hit).toBeUndefined();
  });

  it("stays silent without canon data, never falling back to shape", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const hit = findServedHashEcho([`${hashes[1]}${HASH_SEP}two`], served, [], 1);
    expect(hit).toBeUndefined();
    const nullCanons = findServedHashEcho(
      [`${hashes[1]}${HASH_SEP}two`],
      served,
      [null, null, null],
      1,
    );
    expect(nullCanons).toBeUndefined();
  });

  it("stays silent for a never-served shape", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const canons = canonsFor(content);
    expect(hashes).not.toContain("Zz9");
    const hit = findServedHashEcho([`Zz9${HASH_SEP}literal`], served, canons, 1);
    expect(hit).toBeUndefined();
  });

  it("returns undefined for empty candidates", () => {
    const hashes = _lineHashesPure("a\nb\nc");
    const served: (string | null)[] = [...hashes];
    expect(findServedHashEcho([], served, canonsFor("a\nb\nc"), 2)).toBeUndefined();
  });
});

describe("applyEdit — E_SUSPICIOUS_TEXT gate", () => {
  it("refuses a verbatim served row", () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    };
    expect(() =>
      applyEdit(content, edit, undefined, hashes, { filePath: "a.txt", served, servedCanons }),
    ).toThrow(ServedHashEchoError);
    expect(() =>
      applyEdit(content, edit, undefined, hashes, { filePath: "a.txt", served, servedCanons }),
    ).toThrow(/\[E_SUSPICIOUS_TEXT\]/);
  });

  it("accepts a clean retry", () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const editDenied = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    };
    expect(() =>
      applyEdit(content, editDenied, undefined, hashes, {
        filePath: "a.txt",
        served,
        servedCanons,
      }),
    ).toThrow(/E_SUSPICIOUS_TEXT/);
    const editClean = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: ["NEW-beta"],
    };
    const result = applyEdit(content, editClean, undefined, hashes, {
      filePath: "a.txt",
      served,
      servedCanons,
    });
    expect(result.content).toBe("alpha\nNEW-beta\ngamma\ndelta");
  });

  it("accepts a served prefix with differing content", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}CHANGED-beta`],
    };
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      servedCanons,
    });
    expect(result.content).toBe(`alpha\n${hashes[1]}${HASH_SEP}CHANGED-beta\ngamma`);
  });

  it("denied edit leaves file byte-identical (pure)", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}two`],
    };
    const original = content;
    try {
      applyEdit(content, edit, undefined, hashes, { filePath: "a.txt", served, servedCanons });
    } catch (e) {
      expect((e as Error).message).toMatch(/E_SUSPICIOUS_TEXT/);
    }
    expect(content).toBe(original);
  });

  it("names the offending line, the anchor, and the served line", () => {
    const content = "one\ntwo\nthree";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[2]! }] as any,
      content_lines: ["ok", `${hashes[2]}${HASH_SEP}three`],
    };
    try {
      applyEdit(content, edit, undefined, hashes, { filePath: "a.txt", served, servedCanons });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/\[MODEL\] \[E_SUSPICIOUS_TEXT\]/);
      expect(msg).toContain("replacement line 2");
      expect(msg).toContain(hashes[2]!);
      expect(msg).toContain("line 3");
      expect(msg).toContain("tool output, not file content");
      expect(msg).toContain("Nothing was written");
      expect(msg).toContain('mode: "literal"');
      expect(msg).toContain("Re-read");
      expect(msg).not.toContain(`${hashes[2]}${HASH_SEP}three`);
    }
  });

  it("raw served row before stripping is still refused", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    };
    expect(() =>
      applyEdit(content, edit, undefined, hashes, { filePath: "a.txt", served, servedCanons }),
    ).toThrow(/E_SUSPICIOUS_TEXT/);
  });

  it("no served means no refusal, bytes reach disk unchanged", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    };
    const result = applyEdit(content, edit, undefined, hashes, { filePath: "a.txt" });
    expect(result.content).toBe(`alpha\n${hashes[1]}${HASH_SEP}beta\ngamma`);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("honours a literal declaration byte-exact with a human line", () => {
    const content = "alpha\nbeta\ngamma";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[1]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    };
    const result = applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served,
      servedCanons,
      mode: "literal",
    });
    expect(result.content).toBe(`alpha\n${hashes[1]}${HASH_SEP}beta\ngamma`);
    expect(result.literalBypass).toBe(true);
    expect(result.warnings?.join("\n")).toContain("[USER]");
  });

  it("refuses a served hash echo submitted with reversed anchors ([E_SUSPICIOUS_TEXT] healed path)", () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const hashes = _lineHashesPure(content);
    const served: (string | null)[] = [...hashes];
    const servedCanons = canonsFor(content);
    const edit = {
      hash_bounds: [{ hash: hashes[2]! }, { hash: hashes[1]! }] as any,
      content_lines: [`${hashes[1]}${HASH_SEP}beta`],
    };
    expect(() =>
      applyEdit(content, edit, undefined, hashes, { filePath: "a.txt", served, servedCanons }),
    ).toThrow(/\[E_SUSPICIOUS_TEXT\]/);
  });
});

describe("applyEdit — rebased served check stays evidence-only", () => {
  const content = "z\nq\nw";
  const hashes = _lineHashesPure(content);
  const served: (string | null)[] = ["AAA", "BBB", null];
  const leases: Record<string, LeaseIdentityView> = {
    AAA: {
      lineId: 1,
      canonHash: "z",
      servedSnapshotHash: "S",
      servedLineNumber: 1,
      retiredAt: null,
    },
    BBB: {
      lineId: 2,
      canonHash: "q",
      servedSnapshotHash: "S",
      servedLineNumber: 2,
      retiredAt: null,
    },
  };
  const rebasedSource: LeaseSpanSource = {
    currentSnapshotHash: "C",
    leaseFor: (anchor) => leases[anchor],
    rebasedLineOf: (lineId) => ({ 1: 2, 2: 3 })[lineId],
  };
  const rebasedEdit = (replaceWith: string): HEdit => ({
    hash_bounds: [{ hash: "AAA" }, { hash: "BBB" }],
    content_lines: replaceWith.split("\n"),
  });
  const applyRebased = (
    edit: HEdit,
    mirror: (string | null)[] = served,
    canons: (string | null)[] = ["z", "q", null],
  ) =>
    applyEdit(content, edit, undefined, hashes, {
      filePath: "a.txt",
      served: mirror,
      servedCanons: canons,
      identity: rebasedSource,
    });

  it("fixture anchors cannot collide with the file anchors", () => {
    expect(hashes).not.toContain("AAA");
    expect(hashes).not.toContain("BBB");
  });

  it("accepts an anchor-shaped repeat with differing content", () => {
    const result = applyRebased(rebasedEdit("plain\nAAA\u2502BOOM"));
    expect(result.content).toBe("z\nplain\nAAA\u2502BOOM");
  });

  it("still refuses the anchor served for the line it reproduces", () => {
    expect(() => applyRebased(rebasedEdit("AAA\u2502z\nplain"))).toThrow(/\[E_SUSPICIOUS_TEXT\]/);
  });
});
