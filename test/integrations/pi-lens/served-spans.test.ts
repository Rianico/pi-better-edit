import { afterEach, describe, expect, it } from "vitest";

import {
  addServedSpanObserver,
  clearServedSpanObserversForTests,
  notifyServedSpans,
  servedRowsToSpans,
  type ServedSpan,
  type ServedSpanNotification,
} from "../../../src/served-spans.js";

const row = (position: number): { position: number; hash: string } => ({ position, hash: "abc" });

function note(
  spans: ServedSpan[],
  source: ServedSpanNotification["source"] = "read",
): ServedSpanNotification {
  return { filePath: "/tmp/served-spans.test.ts", spans, source };
}

afterEach(() => {
  // SAFETY: the observer registry is module-global, so every test must leave it empty for the next
  // SAFETY: file in the same worker — a leaked observer would fire inside unrelated test cases.
  clearServedSpanObserversForTests();
});

describe("servedRowsToSpans", () => {
  it("encodes a contiguous run as a single 1-indexed span", () => {
    expect(servedRowsToSpans([row(0), row(1), row(2)])).toEqual([{ startLine: 1, lineCount: 3 }]);
  });

  it("splits a gapped run into one span per contiguous run", () => {
    expect(servedRowsToSpans([row(0), row(1), row(3)])).toEqual([
      { startLine: 1, lineCount: 2 },
      { startLine: 4, lineCount: 1 },
    ]);
  });

  it("normalizes unsorted input with duplicates", () => {
    expect(servedRowsToSpans([row(5), row(0), row(5), row(1), row(0)])).toEqual([
      { startLine: 1, lineCount: 2 },
      { startLine: 6, lineCount: 1 },
    ]);
  });

  it("drops negative, fractional and non-finite positions", () => {
    expect(
      servedRowsToSpans([
        row(-1),
        row(1.5),
        row(Number.NaN),
        row(Number.POSITIVE_INFINITY),
        row(Number.NEGATIVE_INFINITY),
        row(3),
      ]),
    ).toEqual([{ startLine: 4, lineCount: 1 }]);
  });

  it("maps 0-based positions onto 1-indexed lines", () => {
    expect(servedRowsToSpans([row(0)])).toEqual([{ startLine: 1, lineCount: 1 }]);
    expect(servedRowsToSpans([row(9)])).toEqual([{ startLine: 10, lineCount: 1 }]);
  });

  it("returns an empty list for empty input", () => {
    expect(servedRowsToSpans([])).toEqual([]);
  });

  it("leaves the caller's rows untouched", () => {
    const rows = [row(3), row(1), row(1)];
    const snapshot = rows.map((entry) => ({ ...entry }));
    servedRowsToSpans(rows);
    expect(rows).toEqual(snapshot);
  });
});

describe("served span observers", () => {
  it("fans out to every registered observer in registration order", () => {
    const seen: string[] = [];
    addServedSpanObserver(() => seen.push("first"));
    addServedSpanObserver(() => seen.push("second"));
    addServedSpanObserver(() => seen.push("third"));

    notifyServedSpans(note([{ startLine: 2, lineCount: 2 }]));

    expect(seen).toEqual(["first", "second", "third"]);
  });

  it("isolates a throwing observer so the remaining observers still run", () => {
    const seen: string[] = [];
    addServedSpanObserver(() => seen.push("first"));
    addServedSpanObserver(() => {
      seen.push("boom");
      throw new Error("observer exploded");
    });
    addServedSpanObserver(() => seen.push("third"));

    expect(() => notifyServedSpans(note([{ startLine: 1, lineCount: 1 }]))).not.toThrow();

    expect(seen).toEqual(["first", "boom", "third"]);
  });

  it("stops delivery after unsubscribe and treats unsubscribe as idempotent", () => {
    const seen: string[] = [];
    const offFirst = addServedSpanObserver(() => seen.push("a"));
    const offSecond = addServedSpanObserver(() => seen.push("b"));

    notifyServedSpans(note([{ startLine: 1, lineCount: 1 }]));
    offFirst();
    offFirst();
    notifyServedSpans(note([{ startLine: 1, lineCount: 1 }]));
    offSecond();

    expect(seen).toEqual(["a", "b", "b"]);
  });

  it("keeps two registrations of the same function independent", () => {
    const seen: string[] = [];
    const handler = (): void => {
      seen.push("handler");
    };
    const offFirst = addServedSpanObserver(handler);
    const offSecond = addServedSpanObserver(handler);

    offFirst();
    notifyServedSpans(note([{ startLine: 1, lineCount: 1 }]));
    expect(seen).toEqual(["handler"]);

    offSecond();
    notifyServedSpans(note([{ startLine: 1, lineCount: 1 }]));
    expect(seen).toEqual(["handler"]);
  });

  it("skips the fan-out entirely when the span list is empty", () => {
    let deliveries = 0;
    addServedSpanObserver(() => {
      deliveries += 1;
    });

    notifyServedSpans(note([]));

    expect(deliveries).toBe(0);
  });

  it("hands observers the notification value itself, source included", () => {
    const received: ServedSpanNotification[] = [];
    addServedSpanObserver((notification) => received.push(notification));

    notifyServedSpans(note([{ startLine: 5, lineCount: 2 }], "diff"));

    expect(received).toEqual([
      {
        filePath: "/tmp/served-spans.test.ts",
        spans: [{ startLine: 5, lineCount: 2 }],
        source: "diff",
      },
    ]);
  });

  it("clearServedSpanObserversForTests empties the registry", () => {
    let deliveries = 0;
    addServedSpanObserver(() => {
      deliveries += 1;
    });
    addServedSpanObserver(() => {
      deliveries += 1;
    });

    clearServedSpanObserversForTests();
    notifyServedSpans(note([{ startLine: 1, lineCount: 1 }]));

    expect(deliveries).toBe(0);
  });
});
