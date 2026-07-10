import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { buildToolDef as buildBulkToolDef } from "../../src/replace";
import { buildToolDefFlat } from "../../src/replace-flat";
import { writeConfig } from "../../src/config";

let tmpHome: string;

async function withTempHome(run: () => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "pi-hashline-auto-read-test-"));
  vi.stubEnv('HOME', tmpHome);
  try {
    await run();
  } finally {
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

function checkDescription(toolDef: { description: string }, expectAutoMsg: boolean): void {
  const hasAutoMsg = toolDef.description.includes("Anchors are provided automatically after write and replace operations");
  const hasReadCall = toolDef.description.includes("Call `read` to get fresh anchors for follow-up edits.");
  if (expectAutoMsg) {
    expect(hasAutoMsg).toBe(true);
    expect(hasReadCall).toBe(false);
  } else {
    expect(hasAutoMsg).toBe(false);
    expect(hasReadCall).toBe(true);
  }
}

function checkGuidelines(guidelines: string[], expectAutoMsg: boolean): void {
  const hasAutoMsg = guidelines.some((g) =>
    g.includes("Anchors are provided automatically after write and replace operations")
  );
  const hasReadCall = guidelines.some((g) =>
    g.includes("Call `read` to get fresh anchors for follow-up edits.")
  );
  if (expectAutoMsg) {
    expect(hasAutoMsg).toBe(true);
    expect(hasReadCall).toBe(false);
  } else {
    expect(hasAutoMsg).toBe(false);
    expect(hasReadCall).toBe(true);
  }
}

describe("auto-read guidance in bulk mode tool definition", () => {
  it("shows auto-read message in description and guidelines when autoRead is true", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "bulk", autoRead: true });
      const toolDef = buildBulkToolDef({ flat: false });
      checkDescription(toolDef, true);
      checkGuidelines(toolDef.promptGuidelines ?? [], true);
    });
  });

  it("shows 'Call `read`' message in description and guidelines when autoRead is false", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "bulk", autoRead: false });
      const toolDef = buildBulkToolDef({ flat: false });
      checkDescription(toolDef, false);
      checkGuidelines(toolDef.promptGuidelines ?? [], false);
    });
  });

  it("defaults to 'Call `read`' when no config file exists", async () => {
    await withTempHome(async () => {
      const toolDef = buildBulkToolDef({ flat: false });
      checkDescription(toolDef, false);
      checkGuidelines(toolDef.promptGuidelines ?? [], false);
    });
  });
});

describe("auto-read guidance in flat mode tool definition", () => {
  it("shows auto-read message in description and guidelines when autoRead is true", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "flat", autoRead: true });
      const toolDef = buildToolDefFlat();
      checkDescription(toolDef, true);
      checkGuidelines(toolDef.promptGuidelines ?? [], true);
    });
  });

  it("shows 'Call `read`' message in description and guidelines when autoRead is false", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "flat", autoRead: false });
      const toolDef = buildToolDefFlat();
      checkDescription(toolDef, false);
      checkGuidelines(toolDef.promptGuidelines ?? [], false);
    });
  });

  it("defaults to 'Call `read`' when no config file exists", async () => {
    await withTempHome(async () => {
      const toolDef = buildToolDefFlat();
      checkDescription(toolDef, false);
      checkGuidelines(toolDef.promptGuidelines ?? [], false);
    });
  });
});
