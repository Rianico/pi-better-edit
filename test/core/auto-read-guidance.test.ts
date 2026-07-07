import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { buildToolDef as buildBulkToolDef } from "../../src/replace";
import { buildToolDef as buildFlatToolDef } from "../../src/replace-flat";
import { writeConfig } from "../../src/config";

const origHome = process.env.HOME;
let tmpHome: string;

async function withTempHome(run: () => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "pi-hashline-auto-read-test-"));
  process.env.HOME = tmpHome;
  try {
    await run();
  } finally {
    process.env.HOME = origHome;
    await rm(tmpHome, { recursive: true, force: true });
  }
}

describe("auto-read guidance in bulk mode tool definition", () => {
  it("includes auto-read message when autoRead is true", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "bulk", autoRead: true });
      const toolDef = buildBulkToolDef();
      const guidelines = toolDef.promptGuidelines ?? [];
      const hasAutoMsg = guidelines.some((g) =>
        g.includes("Anchors are provided automatically after write operations")
      );
      expect(hasAutoMsg).toBe(true);
      const hasReadCall = guidelines.some((g) =>
        g.includes("Call `read` to get fresh anchors")
      );
      expect(hasReadCall).toBe(false);
    });
  });

  it("includes 'Call `read`' message when autoRead is false", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "bulk", autoRead: false });
      const toolDef = buildBulkToolDef();
      const guidelines = toolDef.promptGuidelines ?? [];
      const hasReadCall = guidelines.some((g) =>
        g.includes("Call `read` to get fresh anchors")
      );
      expect(hasReadCall).toBe(true);
      const hasAutoMsg = guidelines.some((g) =>
        g.includes("Anchors are provided automatically")
      );
      expect(hasAutoMsg).toBe(false);
    });
  });

  it("defaults to 'Call `read`' when no config file exists", async () => {
    await withTempHome(async () => {
      // No config file written — defaults to autoRead: false
      const toolDef = buildBulkToolDef();
      const guidelines = toolDef.promptGuidelines ?? [];
      const hasReadCall = guidelines.some((g) =>
        g.includes("Call `read` to get fresh anchors")
      );
      expect(hasReadCall).toBe(true);
    });
  });
});

describe("auto-read guidance in flat mode tool definition", () => {
  it("includes auto-read message when autoRead is true", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "flat", autoRead: true });
      const toolDef = buildFlatToolDef();
      const guidelines = toolDef.promptGuidelines ?? [];
      const hasAutoMsg = guidelines.some((g) =>
        g.includes("Anchors are provided automatically after write operations")
      );
      expect(hasAutoMsg).toBe(true);
      const hasReadCall = guidelines.some((g) =>
        g.includes("Call `read` to get fresh anchors")
      );
      expect(hasReadCall).toBe(false);
    });
  });

  it("includes 'Call `read`' message when autoRead is false", async () => {
    await withTempHome(async () => {
      await writeConfig({ replaceMode: "flat", autoRead: false });
      const toolDef = buildFlatToolDef();
      const guidelines = toolDef.promptGuidelines ?? [];
      const hasReadCall = guidelines.some((g) =>
        g.includes("Call `read` to get fresh anchors")
      );
      expect(hasReadCall).toBe(true);
      const hasAutoMsg = guidelines.some((g) =>
        g.includes("Anchors are provided automatically")
      );
      expect(hasAutoMsg).toBe(false);
    });
  });

  it("defaults to 'Call `read`' when no config file exists", async () => {
    await withTempHome(async () => {
      const toolDef = buildFlatToolDef();
      const guidelines = toolDef.promptGuidelines ?? [];
      const hasReadCall = guidelines.some((g) =>
        g.includes("Call `read` to get fresh anchors")
      );
      expect(hasReadCall).toBe(true);
    });
  });
});
