import { describe, expect, it } from "vitest";
import {
  isRec,
  has,
  visLines,
  cntLines,
  rejectUnknownFields,
} from "../../src/utils";

describe("isRec", () => {
  it("returns true for plain objects", () => {
    expect(isRec({})).toBe(true);
    expect(isRec({ a: 1 })).toBe(true);
    expect(isRec({ key: "value" })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isRec(null)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isRec([])).toBe(false);
    expect(isRec([1, 2, 3])).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isRec("string")).toBe(false);
    expect(isRec(42)).toBe(false);
    expect(isRec(true)).toBe(false);
    expect(isRec(undefined)).toBe(false);
  });

  it("returns false for functions", () => {
    expect(isRec(() => {})).toBe(false);
  });

  it("returns true for Date objects (they are objects)", () => {
    expect(isRec(new Date())).toBe(true);
  });
});

describe("has", () => {
  it("returns true when the key exists on the object itself", () => {
    expect(has({ a: 1 }, "a")).toBe(true);
    expect(has({ a: undefined }, "a")).toBe(true);
    expect(has({ "": 0 }, "")).toBe(true);
  });

  it("returns false when the key does not exist", () => {
    expect(has({ a: 1 }, "b")).toBe(false);
    expect(has({}, "toString")).toBe(false);
  });

  it("does not check the prototype chain", () => {
    const obj = Object.create({ inherited: true });
    expect(has(obj, "inherited")).toBe(false);
  });
});

describe("visLines", () => {
  it("returns an empty array for empty string", () => {
    expect(visLines("")).toEqual([]);
  });

  it("splits a multi-line string without trailing newline", () => {
    expect(visLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("strips the trailing empty line when content ends with newline", () => {
    expect(visLines("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("handles a single line without trailing newline", () => {
    expect(visLines("hello")).toEqual(["hello"]);
  });

  it("handles a single line with trailing newline", () => {
    expect(visLines("hello\n")).toEqual(["hello"]);
  });

  it("handles content with only a newline (one blank line)", () => {
    expect(visLines("\n")).toEqual([""]);
  });

  it("handles multiple trailing newlines", () => {
    expect(visLines("a\nb\n\n")).toEqual(["a", "b", ""]);
  });

  it("preserves blank lines in the middle", () => {
    expect(visLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
});

describe("cntLines", () => {
  it("returns 0 for empty string", () => {
    expect(cntLines("")).toBe(0);
  });

  it("counts lines without trailing newline", () => {
    expect(cntLines("a\nb\nc")).toBe(3);
  });

  it("counts lines with trailing newline (trailing blank excluded)", () => {
    expect(cntLines("a\nb\nc\n")).toBe(3);
  });

  it("counts a single line", () => {
    expect(cntLines("hello")).toBe(1);
    expect(cntLines("hello\n")).toBe(1);
  });

  it("counts blank lines correctly", () => {
    expect(cntLines("\n")).toBe(1);
    expect(cntLines("\n\n")).toBe(2);
  });
});

describe("rejectUnknownFields", () => {
  it("does not throw when all fields are allowed", () => {
    const obj = { path: "test.txt", changes: [] };
    const allowed = new Set(["path", "changes"]);
    expect(() => rejectUnknownFields(obj, allowed, "Request")).not.toThrow();
  });

  it("does not throw for an empty object", () => {
    const obj = {};
    const allowed = new Set(["path", "changes"]);
    expect(() => rejectUnknownFields(obj, allowed, "Request")).not.toThrow();
  });

  it("does not throw when only a subset of allowed fields is present", () => {
    const obj = { path: "test.txt" };
    const allowed = new Set(["path", "changes"]);
    expect(() => rejectUnknownFields(obj, allowed, "Request")).not.toThrow();
  });

  it("throws [E_BAD_SHAPE] for a single unknown field", () => {
    const obj = { path: "test.txt", unknown_field: "value" };
    const allowed = new Set(["path"]);
    expect(() => rejectUnknownFields(obj, allowed, "Request")).toThrow(
      /^\[E_BAD_SHAPE\]/,
    );
  });

  it("includes the unknown field name in the error message", () => {
    const obj = { path: "test.txt", extra: "value" };
    const allowed = new Set(["path"]);
    expect(() => rejectUnknownFields(obj, allowed, "Request")).toThrow(
      /extra/,
    );
  });

  it("includes the label in the error message", () => {
    const obj = { path: "test.txt", extra: "value" };
    const allowed = new Set(["path"]);
    expect(() => rejectUnknownFields(obj, allowed, "Edit request")).toThrow(
      /Edit request/,
    );
  });

  it("reports multiple unknown fields", () => {
    const obj = { path: "test.txt", a: 1, b: 2, c: 3 };
    const allowed = new Set(["path"]);
    expect(() => rejectUnknownFields(obj, allowed, "Request")).toThrow(
      /a, b, c/,
    );
  });

  it("appends the hint string when provided", () => {
    const obj = { path: "test.txt", extra: "value" };
    const allowed = new Set(["path"]);
    expect(() =>
      rejectUnknownFields(obj, allowed, "Edit 0", "Each edit takes only { hash_range_inclusive, content_lines }."),
    ).toThrow(/Each edit takes only/);
  });

  it("does not append a trailing period when hint is omitted", () => {
    const obj = { path: "test.txt", extra: "value" };
    const allowed = new Set(["path"]);
    const fn = () => rejectUnknownFields(obj, allowed, "Request");
    expect(fn).toThrow();
    // The error should end with a single period from the template, not a double period
    expect(fn).toThrow(/\.$/);
  });

  it("handles an empty allowed set (all fields rejected)", () => {
    const obj = { a: 1, b: 2 };
    const allowed = new Set<string>();
    expect(() => rejectUnknownFields(obj, allowed, "Request")).toThrow(/a, b/);
  });

  it("treats inherited properties as unknown (does not check prototype)", () => {
    const proto = { inherited: true };
    const obj = Object.create(proto);
    obj.own = "value";
    const allowed = new Set(["own"]);
    // "inherited" is on the prototype, not own — Object.keys won't include it
    expect(() => rejectUnknownFields(obj, allowed, "Request")).not.toThrow();
  });

  it("reports fields in insertion order", () => {
    const obj = { z: 1, a: 2, m: 3 };
    const allowed = new Set(["x"]);
    expect(() => rejectUnknownFields(obj, allowed, "Request")).toThrow(
      /z, a, m/,
    );
  });
});
