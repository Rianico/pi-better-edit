import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFilePath } from "../../src/json-config";
import {
  isSpanMode,
  readSpanModeConfig,
  resolveSpanMode,
  resolveSpanModeWithSource,
  SPAN_MODE_DEFAULT,
  SPAN_MODE_ENV_VAR,
  type ResolvedSpanMode,
  type SpanMode,
} from "../../src/span-mode-config";
import { withTempFile } from "../support/fixtures";

const ENV = SPAN_MODE_ENV_VAR;

function writeEdit(scope: "project" | "global", cwd: string, edit: unknown): void {
  const path = configFilePath(scope, cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ edit }), "utf-8");
}

beforeEach(() => {
  delete process.env[ENV];
});

afterEach(() => {
  delete process.env[ENV];
});

describe("edit.span_mode ladder", () => {
  it("defaults to hint when neither file carries the key", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeEdit("global", cwd, {});
      writeEdit("project", cwd, {});
      expect(SPAN_MODE_DEFAULT).toBe("hint");
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "hint", source: "default" });
    });
  });

  it("reads the global file, then lets the project file win", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeEdit("global", cwd, { span_mode: "strict" });
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "strict", source: "global" });
      writeEdit("project", cwd, { span_mode: "hint" });
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "hint", source: "project" });
    });
  });

  it("lets the environment override both files", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeEdit("global", cwd, { span_mode: "hint" });
      writeEdit("project", cwd, { span_mode: "hint" });
      const expected: SpanMode = "strict";
      process.env[ENV] = expected;
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "strict", source: "env" });
    });
  });

  it("resolves hint from the default when no rung carries a value", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeEdit("global", cwd, {});
      writeEdit("project", cwd, {});
      const resolved: ResolvedSpanMode = resolveSpanModeWithSource(cwd);
      expect(resolved).toEqual({ value: "hint", source: "default" });
      expect(resolveSpanMode(cwd)).toBe(resolved.value);
    });
  });

  it("labels an explicit hint in the environment as the env rung", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeEdit("global", cwd, { span_mode: "strict" });
      writeEdit("project", cwd, { span_mode: "strict" });
      process.env[ENV] = "hint";
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "hint", source: "env" });
    });
  });

  it("ignores an invalid file value, and falls an invalid env value through to the project rung", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeEdit("global", cwd, { span_mode: "maybe" });
      writeEdit("project", cwd, { span_mode: "maybe" });
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "hint", source: "default" });
      process.env[ENV] = "maybe";
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "hint", source: "default" });
      writeEdit("project", cwd, { span_mode: "strict" });
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "strict", source: "project" });
    });
  });

  it("is case-sensitive in the environment and in the files, and trims the environment value", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeEdit("global", cwd, { span_mode: "Strict" });
      writeEdit("project", cwd, { span_mode: "Strict" });
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "hint", source: "default" });
      process.env[ENV] = "STRICT";
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "hint", source: "default" });
      process.env[ENV] = " strict ";
      expect(resolveSpanModeWithSource(cwd)).toEqual({ value: "strict", source: "env" });
    });
  });

  it("guards the enum without lowercasing", () => {
    expect(isSpanMode("hint")).toBe(true);
    expect(isSpanMode("strict")).toBe(true);
    expect(isSpanMode("STRICT")).toBe(false);
    expect(isSpanMode(" fragile ")).toBe(false);
    expect(isSpanMode(1)).toBe(false);
  });
});

describe("schema", () => {
  it("validates edit.span_mode", () => {
    // SAFETY: the repository's own schema file is a trusted local asset.
    const schema = JSON.parse(readFileSync(join("schemas", "pi-better-edit.json"), "utf-8")) as {
      properties: { edit: { additionalProperties?: boolean; properties: Record<string, unknown> } };
    };
    expect(schema.properties.edit.properties["span_mode"]).toEqual({
      type: "string",
      enum: ["hint", "strict"],
      default: "hint",
    });
    expect(schema.properties.edit.additionalProperties).toBe(true);
  });
});

describe("span-mode config: seam behaviours", () => {
  it("warns once and never throws for a malformed project file", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      const path = configFilePath("project", cwd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{ not json", "utf-8");
      const warnings: string[] = [];
      const resolved = resolveSpanModeWithSource(cwd, (reason) => warnings.push(reason));
      expect(resolved).toEqual({ value: "hint", source: "default" });
      expect(warnings).toHaveLength(1);
    });
  });

  it("reads both scopes independently and leaves an unrelated key untouched", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      const path = configFilePath("project", cwd);
      mkdirSync(dirname(path), { recursive: true });
      const body = JSON.stringify({
        edit: { span_mode: "strict", extra: 1 },
        custom: { keep: true },
      });
      writeFileSync(path, body, "utf-8");
      writeEdit("global", cwd, { span_mode: "hint" });

      expect(readSpanModeConfig(cwd)).toEqual({ project: "strict", global: "hint" });
      expect(readFileSync(path, "utf-8")).toBe(body);
    });
  });

  it("omits a scope that carries no accepted value", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeEdit("global", cwd, { span_mode: "maybe" });
      expect(readSpanModeConfig(cwd)).toEqual({});
    });
  });
});
