import { readFile } from "fs/promises";
import { configPath } from "./paths";
import { errCode } from "./utils";
import { writeAtomic } from "./fs-write";

export interface Config {
  autoRead: boolean;
}

const DEFAULT_CONFIG: Config = {
  autoRead: true
};

function parseConfig(content: string): Config {
  const parsed = JSON.parse(content) as Partial<Config>;
  return {
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
export async function writeConfig(config: Config): Promise<void> {
  await writeAtomic(configPath(), JSON.stringify(config, null, 2));
}


export async function toggleAutoRead(): Promise<boolean> {
  const config = await readConfig();
  config.autoRead = !config.autoRead;
  await writeConfig(config);
  return config.autoRead;
}
