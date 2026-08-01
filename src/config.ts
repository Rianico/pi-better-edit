import { readFile } from "fs/promises";
import { configPath } from "./paths";
import { errCode } from "./utils";
import { writeAtomic } from "./fs-write";

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

function envDefaultConfig(): Partial<Config> {
  const autoReadValue = process.env.PI_HASHLINE_AUTO_READ;
  return autoReadValue === "1" || autoReadValue === "true"
    ? { autoRead: true }
    : {};
}

export async function readConfig(): Promise<Config> {
  try {
    const content = await readFile(configPath(), "utf-8");
    return parseConfig(content);
  } catch (error: unknown) {
    if (errCode(error) !== "ENOENT") {
      console.error("Config file corrupted, using defaults:", error);
    }
    return { ...DEFAULT_CONFIG, ...envDefaultConfig() };
  }
}
export async function writeConfig(config: Config): Promise<void> {
  await writeAtomic(configPath(), JSON.stringify(config, null, 2));
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
