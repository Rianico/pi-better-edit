import { afterEach, describe, expect, it } from "vitest";

import {
  addMutatedFileObserver,
  clearMutatedFileObserversForTests,
  notifyMutatedFile,
  type MutatedFileNotification,
} from "../../src/mutated-files.js";

function note(overrides: Partial<MutatedFileNotification> = {}): MutatedFileNotification {
  return {
    filePath: "/tmp/mutated-files.test.ts",
    kind: "edit",
    ranges: [{ startLine: 2, lineCount: 1 }],
    sourceTool: "edit",
    ...overrides,
  };
}

afterEach(() => {
  // SAFETY: the observer registry is module-global, so every test must leave it empty for the next
  // SAFETY: file in the same worker — a leaked observer would fire inside unrelated test cases.
  clearMutatedFileObserversForTests();
});

describe("mutated-file observers", () => {
  it("fans out to every registered observer in registration order", () => {
    const seen: string[] = [];
    addMutatedFileObserver((notification) => seen.push(notification.sourceTool));
    addMutatedFileObserver(() => seen.push("second"));
    addMutatedFileObserver(() => seen.push("third"));

    notifyMutatedFile(note());

    expect(seen).toEqual(["edit", "second", "third"]);
  });

  it("delivers a whole-file notification whose range list is empty", () => {
    const received: MutatedFileNotification[] = [];
    addMutatedFileObserver((notification) => received.push(notification));

    notifyMutatedFile(note({ kind: "write", ranges: [], sourceTool: "write" }));

    expect(received).toEqual([
      {
        filePath: "/tmp/mutated-files.test.ts",
        kind: "write",
        ranges: [],
        sourceTool: "write",
      },
    ]);
  });

  it("isolates a throwing observer so the remaining observers still run", () => {
    const seen: string[] = [];
    addMutatedFileObserver(() => seen.push("first"));
    addMutatedFileObserver(() => {
      seen.push("boom");
      throw new Error("observer exploded");
    });
    addMutatedFileObserver(() => seen.push("third"));

    expect(() => notifyMutatedFile(note())).not.toThrow();

    expect(seen).toEqual(["first", "boom", "third"]);
  });

  it("stops delivery after unsubscribe and treats unsubscribe as idempotent", () => {
    const seen: string[] = [];
    const offFirst = addMutatedFileObserver(() => seen.push("a"));
    const offSecond = addMutatedFileObserver(() => seen.push("b"));

    notifyMutatedFile(note());
    offFirst();
    offFirst();
    notifyMutatedFile(note());
    offSecond();

    expect(seen).toEqual(["a", "b", "b"]);
  });

  it("keeps two registrations of the same function independent", () => {
    const seen: string[] = [];
    const handler = (): void => {
      seen.push("handler");
    };
    const offFirst = addMutatedFileObserver(handler);
    const offSecond = addMutatedFileObserver(handler);

    offFirst();
    notifyMutatedFile(note());
    expect(seen).toEqual(["handler"]);

    offSecond();
    notifyMutatedFile(note());
    expect(seen).toEqual(["handler"]);
  });

  it("hands observers the notification value itself", () => {
    const received: MutatedFileNotification[] = [];
    addMutatedFileObserver((notification) => received.push(notification));

    const notification = note({
      filePath: "/tmp/other.ts",
      kind: "edit",
      ranges: [{ startLine: 5, lineCount: 2 }],
      sourceTool: "undo_last_edit",
    });
    notifyMutatedFile(notification);

    expect(received).toEqual([notification]);
  });

  it("clearMutatedFileObserversForTests empties the registry", () => {
    let deliveries = 0;
    addMutatedFileObserver(() => {
      deliveries += 1;
    });
    addMutatedFileObserver(() => {
      deliveries += 1;
    });

    clearMutatedFileObserversForTests();
    notifyMutatedFile(note());

    expect(deliveries).toBe(0);
  });
});
