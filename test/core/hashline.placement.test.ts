import { describe, expect, it, beforeAll } from "vitest";
import { contentOnlyHashes } from "../../src/hashline/hash-identity.js";
import { initHasher } from "../../src/hashline/hasher";
import { applyEdit, ServedHashEchoError } from "../../src/hashline/apply";
import { HASH_SEP, canonDigest } from "../../src/hashline/hash-identity";
import { parseText } from "../../src/hashline/parse.js";
import type { HEdit } from "../../src/hashline/resolve";
import { restoreEndings } from "../../src/edit-diff";

beforeAll(async () => {
  await initHasher();
});

function editFor(
  content: string,
  line: number,
  lines: string[],
  placement?: HEdit["placement"],
): HEdit {
  const hashes = contentOnlyHashes(content);
  const edit: HEdit = {
    hash_bounds: [{ hash: hashes[line - 1]! }, { hash: hashes[line - 1]! }],
    content_lines: lines,
  };
  if (placement !== undefined) edit.placement = placement;
  return edit;
}
function editForText(
  content: string,
  line: number,
  text: string,
  placement?: HEdit["placement"],
): HEdit {
  const hashes = contentOnlyHashes(content);
  const edit: HEdit = {
    hash_bounds: [{ hash: hashes[line - 1]! }, { hash: hashes[line - 1]! }],
    content_lines: parseText(text),
  };
  if (placement !== undefined) edit.placement = placement;
  return edit;
}
function canonDigestsFor(content: string): (string | null)[] {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  if (content === "") return [];
  return lines.map((line) => canonDigest(line));
}

describe("applyEdit — placement insertions (internal seam, zero-width splice)", () => {
  it("before on the first line gains the lines ahead of line 1", () => {
    const content = "aaa\nbbb\nccc\n";
    const result = applyEdit(
      content,
      editFor(content, 1, ["X", "Y"], "before"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(result.content).toBe("X\nY\naaa\nbbb\nccc\n");
    expect(result.firstChangedLine).toBe(1);
  });

  it("before on a middle line with a multi-line insertion (>=3 lines, one empty)", () => {
    const content = "a\nb\nc\nd\ne";
    const result = applyEdit(
      content,
      editFor(content, 3, ["P", "", "Q"], "before"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(result.content).toBe("a\nb\nP\n\nQ\nc\nd\ne");
  });

  it("after on a middle line with a multi-line insertion", () => {
    const content = "a\nb\nc\nd\ne";
    const result = applyEdit(
      content,
      editFor(content, 2, ["P", "Q"], "after"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(result.content).toBe("a\nb\nP\nQ\nc\nd\ne");
  });

  it("after on the last line of a file that ends with a newline", () => {
    const content = "a\nb\n";
    const result = applyEdit(
      content,
      editFor(content, 2, ["P", "Q"], "after"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(result.content).toBe("a\nb\nP\nQ\n");
  });

  it("after on the last line of a file without a trailing newline", () => {
    const content = "a\nb";
    const result = applyEdit(
      content,
      editFor(content, 2, ["P", "Q"], "after"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(result.content).toBe("a\nb\nP\nQ");
  });

  it("EOF contract: bare text after the final anchor preserves POSIX fidelity", () => {
    const terminated = "a\nb\n";
    const terminatedResult = applyEdit(
      terminated,
      editForText(terminated, 2, "P", "after"),
      undefined,
      contentOnlyHashes(terminated),
    );
    expect(terminatedResult.content).toBe("a\nb\nP\n");
    const unterminated = "a\nb";
    const unterminatedResult = applyEdit(
      unterminated,
      editForText(unterminated, 2, "P", "after"),
      undefined,
      contentOnlyHashes(unterminated),
    );
    expect(unterminatedResult.content).toBe("a\nb\nP");
    expect(unterminatedResult.content.endsWith("\n")).toBe(false);
  });

  it("EOF contract: one trailing newline terminates an unterminated file", () => {
    const content = "a\nb";
    const result = applyEdit(
      content,
      editForText(content, 2, "P\n", "after"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(result.content).toBe("a\nb\nP\n");
  });

  it("EOF contract: one trailing newline on a terminated file appends a blank line", () => {
    const content = "a\nb\n";
    const result = applyEdit(
      content,
      editForText(content, 2, "P\n", "after"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(result.content).toBe("a\nb\nP\n\n");
  });

  it("EOF contract: two trailing newlines append one blank line past the insert", () => {
    const terminated = "a\nb\n";
    const terminatedResult = applyEdit(
      terminated,
      editForText(terminated, 2, "P\n\n", "after"),
      undefined,
      contentOnlyHashes(terminated),
    );
    expect(terminatedResult.content).toBe("a\nb\nP\n\n\n");
    const unterminated = "a\nb";
    const unterminatedResult = applyEdit(
      unterminated,
      editForText(unterminated, 2, "P\n\n", "after"),
      undefined,
      contentOnlyHashes(unterminated),
    );
    expect(unterminatedResult.content).toBe("a\nb\nP\n\n");
  });

  it("before on the first line of a file without a trailing newline", () => {
    const content = "a\nb";
    const result = applyEdit(
      content,
      editFor(content, 1, ["P"], "before"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(result.content).toBe("P\na\nb");
  });

  it("insertions carry the empty-range form so line identities survive", () => {
    const content = "a\nb\nc";
    const before = applyEdit(
      content,
      editFor(content, 2, ["P"], "before"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(before.range).toEqual({
      startLine: 2,
      endLine: 1,
      startHash: before.range.startHash,
      endHash: before.range.endHash,
      delta: 1,
    });
    expect(before.range.startLine).toBeGreaterThan(before.range.endLine);
    const after = applyEdit(
      content,
      editFor(content, 2, ["P", "Q"], "after"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(after.range.startLine).toBe(3);
    expect(after.range.endLine).toBe(2);
    expect(after.range.delta).toBe(2);
  });

  it("an insertion is never a noop even when it repeats the target line's text", () => {
    const content = "a\nb\nc";
    const result = applyEdit(
      content,
      editFor(content, 2, ["b"], "after"),
      undefined,
      contentOnlyHashes(content),
    );
    expect(result.content).toBe("a\nb\nb\nc");
    expect(result.noopEdit).toBeUndefined();
  });

  it("CRLF files (normalized LF at the seam) restore to pure CRLF, no mix", () => {
    const normalized = "a\nb\nc\n";
    const result = applyEdit(
      normalized,
      editFor(normalized, 2, ["P", "Q"], "after"),
      undefined,
      contentOnlyHashes(normalized),
    );
    expect(result.content).toBe("a\nb\nP\nQ\nc\n");
    const restored = restoreEndings(result.content, "\r\n");
    expect(restored).toBe("a\r\nb\r\nP\r\nQ\r\nc\r\n");
    const loneLF = restored.replace(/\r\n/g, "");
    expect(loneLF).not.toContain("\n");
  });

  it("insertion lines reproducing a served row are refused (E_SUSPICIOUS_TEXT)", () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const hashes = contentOnlyHashes(content);
    const served: (string | null)[] = [...hashes];
    const edit = editFor(content, 2, ["NEW", `${hashes[2]}${HASH_SEP}gamma`], "after");
    expect(() =>
      applyEdit(content, edit, undefined, hashes, {
        filePath: "a.txt",
        served,
        canonDigests: canonDigestsFor(content),
      }),
    ).toThrow(ServedHashEchoError);
    try {
      applyEdit(content, edit, undefined, hashes, {
        filePath: "a.txt",
        served,
        canonDigests: canonDigestsFor(content),
      });
      expect.unreachable("expected E_SUSPICIOUS_TEXT");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("E_SUSPICIOUS_TEXT");
      expect(String((error as Error).message)).toContain("[E_SUSPICIOUS_TEXT]");
    }
  });
});
