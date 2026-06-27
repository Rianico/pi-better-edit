import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";

import register from "../../index";
import { regReplace } from "../../src/replace";

/**
 * Shared temp-root for the suite (under the repo's `.tmp/`, which is gitignored).
 * Centralized so every helper resolves the same writable root.
 */
export async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

async function freshCwd(): Promise<string> {
  return mkdtemp(join(await getWritableTempRoot(), "pi-hashline-test-"));
}

export async function withTempFile(
  name: string,
  content: string,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const cwd = await freshCwd();
  const path = join(cwd, name);
  try {
    await writeFile(path, content, "utf-8");
    await run({ cwd, path });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Creates a fresh cwd, writes `bytes` to `name`, and cleans up. */
export async function withTempBytes(
  name: string,
  bytes: Uint8Array,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const cwd = await freshCwd();
  const path = join(cwd, name);
  try {
    await writeFile(path, bytes);
    await run({ cwd, path });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Creates a fresh cwd, makes `name` within it, and cleans up. */
export async function withTempSubdir(
  name: string,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const cwd = await freshCwd();
  const path = join(cwd, name);
  try {
    await mkdir(path, { recursive: true });
    await run({ cwd, path });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Creates a fresh mkdtemp dir under `.tmp/` and cleans up. For tests that create
 * multiple files themselves; the callback receives only the dir.
 */
export async function withTempDir(
  prefix: string,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function makeFakePiRegistry() {
  const tools = new Map<string, any>();
  return {
    pi: {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on() {},
    } as any,
    getTool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool;
    },
  };
}

/** Registers only `replace` and returns the tool handle. */
export function makeFakeReplaceRegistry() {
  const tools = new Map<string, any>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on() {},
  } as any;
  regReplace(pi);
  const tool = tools.get("replace");
  if (!tool) throw new Error("Tool not registered: replace");
  return { tool };
}

export function setupIntegrationTest(cwd: string) {
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  const ctx = { cwd, ui: { notify() {} } } as any;
  return { pi, getTool, ctx, readTool: getTool("read"), editTool: getTool("replace") };
}

export function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

export function extractHash(line: string): string {
  return line.split("│")[0]!
}

export function makeTag(content: string, line: number): { hash: string } {
  return { hash: lineHashes(content)[line - 1]! };
}
