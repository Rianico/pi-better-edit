import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { vi } from "vitest";
import { _lineHashesPure, initHasher } from "../../src/hashline";
import { Compile } from "typebox/compile";
import register from "../../index";
import { regReplace } from "../../src/replace";
import { regReplaceFlat } from "../../src/replace-flat";
export async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}

export async function setupTestHome(): Promise<{
  home: string;
  testPath: string;
  cleanup: () => Promise<void>;
}> {
  await initHasher();
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "testhome-"));
  vi.stubEnv('HOME', tmpHome);
  const testPath = join(tmpHome, "test.txt");
  return {
    home: tmpHome,
    testPath,
    cleanup: async () => {
      vi.unstubAllEnvs();
      await rm(tmpHome, { recursive: true, force: true });
    },
  };
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

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(await getWritableTempRoot(), prefix));
}

export function makeFakePiRegistry() {
  const tools = new Map<string, any>();
  return {
    pi: {
      registerTool(tool: any) {
        const originalExecute = tool.execute;
        const validator = Compile(tool.parameters);
        tool.execute = async function(
          toolCallId: string,
          params: unknown,
          signal: AbortSignal | undefined,
          onUpdate: unknown,
          ctx: unknown,
        ) {
          const prepared = tool.prepareArguments
            ? tool.prepareArguments(params)
            : params;
          if (!validator.Check(prepared)) {
            const errors = [...validator.Errors(prepared)]
              .map((e: any) => `  - ${e.message}`)
              .join("\n");
            const msg = "[E_BAD_SHAPE] Schema validation failed for tool \"" + tool.name + "\" after prepareArguments. The prepareArguments return value does not match the registered schema.\n" + errors;
            throw new Error(msg);
          }
          return originalExecute.call(this, toolCallId, prepared, signal, onUpdate, ctx);
        };
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

export function setupFlatIntegrationTest(cwd: string) {
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  regReplaceFlat(pi);
  const ctx = { cwd, ui: { notify() {} } } as any;
  return { pi, getTool, ctx, readTool: getTool("read"), editTool: getTool("replace") };
}

export function setupEditTest(cwd: string) {
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  return { editTool: getTool("replace"), ctx: { cwd } as any };
}

export function setupReadTest(cwd: string) {
  const { pi, getTool } = makeFakePiRegistry();
  register(pi);
  return { readTool: getTool("read"), ctx: { cwd } as any };
}



export function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

export function extractHash(line: string): string {
  return line.split("│")[0]!
}

export async function makeTag(content: string, line: number, path: string): Promise<{ hash: string }> {
  const { lineHashes } = await import("../../src/hashline");
  const hashes = await lineHashes(content, path);
  return { hash: hashes[line - 1]! };
}
