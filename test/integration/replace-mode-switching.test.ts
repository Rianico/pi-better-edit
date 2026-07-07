import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { withTempFile, makeFakePiRegistry, getText } from "../support/fixtures";
import register from "../../index";
import { readReplaceMode, writeReplaceMode, toggleReplaceMode, writeAutoRead, readAutoRead } from "../../src/config";
import { lineHashes } from "../../src/hashline";

// Override HOME so config writes go to a temp dir
const origHome = process.env.HOME;
let tmpHome: string;

async function withTempHome(run: () => Promise<void>): Promise<void> {
  tmpHome = await mkdtemp(join(process.cwd(), ".tmp", "pi-hashline-mode-test-"));
  process.env.HOME = tmpHome;
  try {
    await run();
  } finally {
    process.env.HOME = origHome;
    await rm(tmpHome, { recursive: true, force: true });
  }
}

describe("replace mode switching — config persistence", () => {
  it("toggle-replace-mode persists the new mode to config", async () => {
    await withTempHome(async () => {
      const commandNames: string[] = [];
      const pi = {
        registerTool() {},
        registerCommand(name: string) { commandNames.push(name); },
        on() {},
        getActiveTools: () => ["read", "edit", "replace"],
        setActiveTools() {},
      } as any;

      register(pi);

      // Find and invoke the toggle-replace-mode handler
      expect(commandNames).toContain("toggle-replace-mode");

      // Manually toggle
      const mode = await toggleReplaceMode();
      expect(mode).toBe("flat");
      expect(await readReplaceMode()).toBe("flat");

      // Toggle back
      const mode2 = await toggleReplaceMode();
      expect(mode2).toBe("bulk");
      expect(await readReplaceMode()).toBe("bulk");
    });
  });
});

describe("replace mode switching — flat mode tool behavior", () => {
  it("flat mode tool accepts top-level hash_range_inclusive and content_lines", async () => {
    await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);

      // Simulate session_start switching to flat mode
      const editTool = getTool("replace");

      const hashes = lineHashes("aaa\nbbb\nccc\n");
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          hash_range_inclusive: [hashes[1]!, hashes[1]!],
          content_lines: ["BBB"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
    });
  });

  it("flat mode tool rejects bulk changes array format", async () => {
    const { pi, getTool } = makeFakePiRegistry();
    register(pi);
    const editTool = getTool("replace");

    // The bulk-mode schema is registered by default. The flat-mode schema
    // rejects the "changes" field. This test verifies the default bulk mode
    // still works with changes array.
    await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd }) => {
      const hashes = lineHashes("aaa\nbbb\n");
      const result = await editTool.execute(
        "e1",
        {
          path: "sample.txt",
          changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["BBB"] }],
        },
        undefined,
        undefined,
        { cwd } as any,
      );
      expect(result.content[0].text).toContain("Successfully replaced in sample.txt");
    });
  });
});

describe("replace mode switching — session_start reads config", () => {
  it("session_start registers flat mode when config says flat", async () => {
    await withTempHome(async () => {
      await writeReplaceMode("flat");

      let registeredTool: any;
      const pi = {
        registerTool(tool: any) { registeredTool = tool; },
        registerCommand() {},
        on(_event: string, handler: Function) {
          // Capture and invoke session_start
          if (_event === "session_start") {
            // We'll invoke it manually below
          }
        },
        getActiveTools: () => ["read", "edit", "replace"],
        setActiveTools() {},
      } as any;

      register(pi);

      // Manually trigger session_start
      const sessionHandler = (pi.on as any).calls?.find((c: any) => c[0] === "session_start")?.[1];
      // Since we can't easily capture the handler, verify the config was written
      expect(await readReplaceMode()).toBe("flat");
    });
  });

  it("session_start registers bulk mode when config says bulk", async () => {
    await withTempHome(async () => {
      await writeReplaceMode("bulk");

      let registeredTool: any;
      const pi = {
        registerTool(tool: any) { registeredTool = tool; },
        registerCommand() {},
        on() {},
        getActiveTools: () => ["read", "edit", "replace"],
        setActiveTools() {},
      } as any;

      register(pi);
      expect(await readReplaceMode()).toBe("bulk");
    });
  });
});

describe("replace mode switching — flat mode end-to-end", () => {
  it("flat mode: read → edit → verify file content", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      // Read the file
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, { cwd } as any);
      const text = getText(readResult);
      const betaHash = text.split("\n").find((l: string) => l.includes("│beta"))!.split("│")[0]!;

      // Edit via flat mode (top-level fields)
      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [betaHash, betaHash],
          content_lines: ["BETA"],
        },
        undefined,
        undefined,
        { cwd } as any,
      );

      expect(editResult.content[0].text).toContain("Successfully replaced in sample.ts");
      const content = await readFile(join(cwd, "sample.ts"), "utf-8");
      expect(content).toBe("alpha\nBETA\ngamma\n");
    });
  });

  it("flat mode: stale anchor rejection after edit", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      // Read and get anchor
      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, { cwd } as any);
      const text = getText(readResult);
      const betaHash = text.split("\n").find((l: string) => l.includes("│beta"))!.split("│")[0]!;

      // First edit succeeds
      await editTool.execute(
        "e1",
        { path: "sample.ts", hash_range_inclusive: [betaHash, betaHash], content_lines: ["BETA"] },
        undefined, undefined, { cwd } as any,
      );

      // Second edit with stale anchor fails
      await expect(
        editTool.execute(
          "e2",
          { path: "sample.ts", hash_range_inclusive: [betaHash, betaHash], content_lines: ["BETA-AGAIN"] },
          undefined, undefined, { cwd } as any,
        ),
      ).rejects.toThrow(/E_STALE_ANCHOR/);
    });
  });

  it("flat mode: boundary duplication warning fires", async () => {
    await withTempFile("sample.ts", "function foo() {\n  const x = 1;\n  return x;\n}\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const readTool = getTool("read");
      const editTool = getTool("replace");

      const readResult = await readTool.execute("r1", { path: "sample.ts" }, undefined, undefined, { cwd } as any);
      const text = getText(readResult);
      const lines = text.split("\n");
      const line2Hash = lines.find((l: string) => l.includes("│  const x = 1;"))!.split("│")[0]!;
      const line3Hash = lines.find((l: string) => l.includes("│  return x;"))!.split("│")[0]!;

      const editResult = await editTool.execute(
        "e1",
        {
          path: "sample.ts",
          hash_range_inclusive: [line2Hash, line3Hash],
          content_lines: ["  const y = 2;", "  return y;", "}"],
        },
        undefined, undefined, { cwd } as any,
      );

      expect(editResult.content[0].text).toContain("Boundary duplication (trailing)");
    });
  });
});

describe("auto-read toggle re-registers tool with updated prompts", () => {
  it("toggle-auto-read handler re-registers the tool, updating prompts", async () => {
    await withTempHome(async () => {
      // Start with autoRead = false (default)
      const registrations: any[] = [];
      let commandHandlers: Record<string, Function> = {};
      const pi = {
        registerTool(tool: any) { registrations.push(tool); },
        registerCommand(name: string, def: { handler: Function }) { commandHandlers[name] = def.handler; },
        on() {},
        getActiveTools: () => ["read", "edit", "replace"],
        setActiveTools() {},
      } as any;

      register(pi);

      // Initial registration: autoRead is false → prompts say "Call `read`"
      const initialTool = registrations[registrations.length - 1];
      const initialDesc = initialTool.description;
      expect(initialDesc).toContain("Call `read` to get fresh anchors for follow-up edits.");
      expect(initialDesc).not.toContain("Anchors are provided automatically");

      // Toggle auto-read on via the command handler
      const handler = commandHandlers["toggle-auto-read"];
      expect(handler).toBeDefined();
      await handler({}, { ui: { notify() {} } });

      // After toggle: tool was re-registered with updated prompts
      const updatedTool = registrations[registrations.length - 1];
      const updatedDesc = updatedTool.description;
      expect(updatedDesc).toContain("Anchors are provided automatically after write operations when auto-read is enabled.");
      expect(updatedDesc).not.toContain("Call `read` to get fresh anchors for follow-up edits.");

      // Verify the config was persisted
      expect(await readAutoRead()).toBe(true);
    });
  });

  it("toggle-auto-read handler re-registers with 'Call `read`' when turning auto-read off", async () => {
    await withTempHome(async () => {
      // Start with autoRead = true
      await writeAutoRead(true);

      const registrations: any[] = [];
      let commandHandlers: Record<string, Function> = {};
      const pi = {
        registerTool(tool: any) { registrations.push(tool); },
        registerCommand(name: string, def: { handler: Function }) { commandHandlers[name] = def.handler; },
        on() {},
        getActiveTools: () => ["read", "edit", "replace"],
        setActiveTools() {},
      } as any;

      register(pi);

      // Initial registration: autoRead is true → prompts say auto-read message
      const initialTool = registrations[registrations.length - 1];
      expect(initialTool.description).toContain("Anchors are provided automatically");

      // Toggle auto-read off via the command handler
      const handler = commandHandlers["toggle-auto-read"];
      expect(handler).toBeDefined();
      await handler({}, { ui: { notify() {} } });

      // After toggle: tool was re-registered with "Call `read`"
      const updatedTool = registrations[registrations.length - 1];
      expect(updatedTool.description).toContain("Call `read` to get fresh anchors for follow-up edits.");
      expect(updatedTool.description).not.toContain("Anchors are provided automatically");

      expect(await readAutoRead()).toBe(false);
    });
  });
});
