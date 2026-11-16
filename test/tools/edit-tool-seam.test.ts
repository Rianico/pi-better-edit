import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

describe("C1 deepening — Edit Tool seam", () => {
  it("exposes deep EditTool module with execute/preview interface", async () => {
    const mod = await import("../../src/edit-tool.js");
    expect(mod).toHaveProperty("createEditTool");
    const tool = mod.createEditTool();
    expect(tool).toHaveProperty("execute");
    expect(tool).toHaveProperty("preview");
    expect(typeof tool.execute).toBe("function");
    expect(typeof tool.preview).toBe("function");
    const editToolSource = readFileSync("src/edit-tool.ts", "utf-8");
    expect(editToolSource).not.toContain("pi-tui");
    expect(editToolSource).not.toContain("Markdown");
    expect(editToolSource).not.toContain("Text");
  });

  it("owns pipeline delegation inside EditTool", async () => {
    const src = readFileSync("src/edit-tool.ts", "utf-8");
    expect(src).toContain("engineExecute");
    expect(src).toContain("sessionKeyFor");
  });

  it("moves TUI rendering into TuiPresenter adapter with isolated casts", async () => {
    const presenter = await import("../../src/tui-presenter.js");
    expect(presenter).toHaveProperty("createTuiPresenter");
    const src = readFileSync("src/tui-presenter.ts", "utf-8");
    expect(src).toContain("makeRenderCall");
    expect(src).toContain("makeRenderResult");
    expect(src).toContain("pi-tui");
  });

  it("edit.ts becomes thin adapter delegating to deep module", async () => {
    const editSrc = readFileSync("src/edit.ts", "utf-8");
    expect(editSrc).toContain("createEditTool");
    expect(editSrc).toContain("createTuiPresenter");
    const definesMakeRenderCall = /^function makeRenderCall/m.test(editSrc);
    const definesMakeRenderResult = /^function makeRenderResult/m.test(editSrc);
    expect(definesMakeRenderCall).toBe(false);
    expect(definesMakeRenderResult).toBe(false);
    expect(editSrc).not.toContain("buildAppliedText");
    expect(editSrc).not.toContain("fmtCall");
  });

  it("preserves tool contract: buildToolDef still returns pi-compatible definition", async () => {
    const { buildToolDef } = await import("../../src/edit.js");
    const def = buildToolDef();
    expect(def.name).toBe("edit");
    expect(def.parameters).toBeDefined();
    expect(def.execute).toBeDefined();
    expect(def.renderCall).toBeDefined();
    expect(def.renderResult).toBeDefined();
    expect(typeof def.execute).toBe("function");
  });
});
