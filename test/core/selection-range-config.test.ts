import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFilePath } from "../../src/json-config";
import { resolveSelectionRangeModeWithSource } from "../../src/selection-range-config";
import { withTempFile } from "../support/fixtures";

const ENV = "PI_BETTER_EDIT_READ_SELECTION_RANGE";
const OLD_ENV = "PI_BETTER_EDIT_READ_EXPANSION";

function writeRead(scope: "project" | "global", cwd: string, read: unknown): void {
  const path = configFilePath(scope, cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ read }), "utf-8");
}

beforeEach(() => {
  delete process.env[ENV];
  delete process.env[OLD_ENV];
});

afterEach(() => {
  delete process.env[ENV];
  delete process.env[OLD_ENV];
});

describe("read.selectionRange ladder", () => {
  it("defaults to on", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeRead("global", cwd, {});
      writeRead("project", cwd, {});
      expect(resolveSelectionRangeModeWithSource(cwd)).toEqual({ value: "on", source: "default" });
    });
  });

  it("reads the project file, then the global file", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeRead("global", cwd, {});
      writeRead("project", cwd, {});
      writeRead("global", cwd, { selectionRange: "off" });
      expect(resolveSelectionRangeModeWithSource(cwd)).toEqual({ value: "off", source: "global" });
      writeRead("project", cwd, { selectionRange: "on" });
      expect(resolveSelectionRangeModeWithSource(cwd)).toEqual({ value: "on", source: "project" });
    });
  });

  it("lets the environment override both files", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeRead("global", cwd, {});
      writeRead("project", cwd, {});
      writeRead("project", cwd, { selectionRange: "on" });
      process.env[ENV] = "off";
      expect(resolveSelectionRangeModeWithSource(cwd)).toEqual({ value: "off", source: "env" });
    });
  });

  it("ignores a value outside on and off", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeRead("global", cwd, {});
      writeRead("project", cwd, {});
      writeRead("project", cwd, { selectionRange: "maybe" });
      expect(resolveSelectionRangeModeWithSource(cwd)).toEqual({ value: "on", source: "default" });
    });
  });

  it("ignores the retired key and the retired environment variable", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeRead("global", cwd, {});
      writeRead("project", cwd, {});
      writeRead("project", cwd, { expansion: "off" });
      process.env[OLD_ENV] = "off";
      expect(resolveSelectionRangeModeWithSource(cwd)).toEqual({ value: "on", source: "default" });
    });
  });
});

describe("schema", () => {
  it("validates read.selectionRange and carries no read.expansion key", () => {
    const schema = JSON.parse(
      // SAFETY: the repository's own schema file is a trusted local asset.
      readFileSync(join("schemas", "pi-better-edit.json"), "utf-8"),
    ) as {
      properties: { read: { properties: Record<string, { enum?: string[]; default?: string }> } };
    };
    const read = schema.properties.read.properties;
    expect(read["selectionRange"]).toEqual({ type: "string", enum: ["on", "off"], default: "on" });
    expect(read["expansion"]).toBeUndefined();
  });
});

describe("selection-range config: seam behaviours", () => {
  it("warns once and never throws for a malformed project file", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      const path = configFilePath("project", cwd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{ not json", "utf-8");
      const warnings: string[] = [];
      const resolved = resolveSelectionRangeModeWithSource(cwd, (reason) => warnings.push(reason));
      expect(resolved).toEqual({ value: "on", source: "default" });
      expect(warnings.length).toBeLessThanOrEqual(1);
    });
  });

  it("falls through an invalid env value to the project rung", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      writeRead("project", cwd, { selectionRange: "off" });
      process.env[ENV] = "maybe";
      expect(resolveSelectionRangeModeWithSource(cwd)).toEqual({ value: "off", source: "project" });
    });
  });

  it("reads read.selectionRange and leaves unknown keys untouched", async () => {
    await withTempFile("note.txt", "x\n", async ({ cwd }) => {
      const path = configFilePath("project", cwd);
      mkdirSync(dirname(path), { recursive: true });
      const body = JSON.stringify({
        read: { selectionRange: "off", extra: 1 },
        custom: { keep: true },
      });
      writeFileSync(path, body, "utf-8");
      expect(resolveSelectionRangeModeWithSource(cwd)).toEqual({ value: "off", source: "project" });
      expect(readFileSync(path, "utf-8")).toBe(body);
    });
  });
});
