import { readFileSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { configDir, configPath } from "./paths";
import { errCode } from "./validation";

export type ReplaceMode = "bulk" | "flat";
export interface Config {
  replaceMode: ReplaceMode;
  autoRead: boolean;
}

const DEFAULT_CONFIG: Config = {
  replaceMode: "bulk",
  autoRead: false
};

function parseConfig(content: string): Config {
  const parsed = JSON.parse(content) as Partial<Config>;
  return {
    replaceMode: parsed.replaceMode === "flat" ? "flat" : "bulk",
    autoRead: parsed.autoRead === true,
  };
}
export async function readConfig(): Promise<Config> {
  try {
    const content = await readFile(configPath(), "utf-8");
    return parseConfig(content);
  } catch (error: unknown) {
    if (errCode(error) !== "ENOENT") {
      console.error("Config file corrupted, using defaults:", error);
    }
    return { ...DEFAULT_CONFIG };
  }
}
export function readConfigSync(): Config {
  try {
    const content = readFileSync(configPath(), "utf-8");
    return parseConfig(content);
  } catch (error: unknown) {
    if (errCode(error) !== "ENOENT") {
      console.error("Config file corrupted, using defaults:", error);
    }
    return { ...DEFAULT_CONFIG };
  }
}
export async function writeConfig(config: Config): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2), "utf-8");
}


export async function toggleReplaceMode(): Promise<ReplaceMode> {
  const config = await readConfig();
  config.replaceMode = config.replaceMode === "bulk" ? "flat" : "bulk";
  await writeConfig(config);
  return config.replaceMode;
}


export async function toggleAutoRead(): Promise<boolean> {
  const config = await readConfig();
  config.autoRead = !config.autoRead;
  await writeConfig(config);
  return config.autoRead;
}
