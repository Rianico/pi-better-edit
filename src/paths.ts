import { homedir } from "os";
import { join, dirname } from "path";


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
