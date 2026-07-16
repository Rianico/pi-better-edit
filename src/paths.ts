import { homedir } from "os";
import { isAbsolute, resolve as resolvePath, join, dirname } from "path";


export function configDir(): string {
  return join(homedir(), ".config", "pi-hashline-edit-pro");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function hashStorePath(): string {
  return join(configDir(), "hash-store.json");
}

export function hashStoreDir(): string {
  return dirname(hashStorePath());
}

function expand(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return homedir() + filePath.slice(1);
  return filePath;
}

export function toCwd(filePath: string, cwd: string): string {
  const expanded = expand(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
