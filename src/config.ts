import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";

export type ReplaceMode = "bulk" | "flat";

export interface Config {
  replaceMode: ReplaceMode;
  autoRead: boolean;
}

const DEFAULT_CONFIG: Config = {
  replaceMode: "bulk",
  autoRead: false,
};

/** Compute config path lazily so tests can override HOME before calling. */
function configPath(): string {
  return join(homedir(), ".config", "pi-hashline-edit-pro", "config.json");
}

function configDir(): string {
  return join(homedir(), ".config", "pi-hashline-edit-pro");
}

export async function readConfig(): Promise<Config> {
  try {
    const content = await readFile(configPath(), "utf-8");
    const parsed = JSON.parse(content) as Partial<Config>;
    return {
      replaceMode: parsed.replaceMode === "flat" ? "flat" : "bulk",
      autoRead: parsed.autoRead === true,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

export async function readReplaceMode(): Promise<ReplaceMode> {
  const config = await readConfig();
  return config.replaceMode;
}

export async function writeReplaceMode(mode: ReplaceMode): Promise<void> {
  const config = await readConfig();
  config.replaceMode = mode;
  await writeConfig(config);
}

export async function toggleReplaceMode(): Promise<ReplaceMode> {
  const config = await readConfig();
  config.replaceMode = config.replaceMode === "bulk" ? "flat" : "bulk";
  await writeConfig(config);
  return config.replaceMode;
}

export async function readAutoRead(): Promise<boolean> {
  const config = await readConfig();
  return config.autoRead;
}

export async function writeAutoRead(value: boolean): Promise<void> {
  const config = await readConfig();
  config.autoRead = value;
  await writeConfig(config);
}

export async function toggleAutoRead(): Promise<boolean> {
  const config = await readConfig();
  config.autoRead = !config.autoRead;
  await writeConfig(config);
  return config.autoRead;
}
