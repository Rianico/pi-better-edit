import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { lineHashes } from "../../src/hashline";

import register from "../../index";

async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

export async function withTempFile(
  name: string,
  content: string,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const tempRoot = await getWritableTempRoot();
  const cwd = await mkdtemp(join(tempRoot, "pi-hashline-test-"));
  const path = join(cwd, name);
  try {
    await writeFile(path, content, "utf-8");
    await run({ cwd, path });
  } finally {
    await rm(cwd, { recursive: true, force: true });
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

/**
 * Build a hash-only anchor for line `line` in the given `content`. Uses the
 * same `lineHashes` path the runtime uses, so the hash is exactly
 * what validation will compare against.
 */
export function makeTag(content: string, line: number): { hash: string } {
  return { hash: lineHashes(content)[line - 1]! };
}
