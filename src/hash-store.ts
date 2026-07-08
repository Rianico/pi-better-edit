import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { stat } from "fs/promises";

export interface FileSnapshot {
  content: string;
  hashes: string[];
}

export interface HashStore {
  version: 1;
  snapshots: Record<string, FileSnapshot>;
}

function storePath(): string {
  return join(homedir(), ".config", "pi-hashline-edit-pro", "hash-store.json");
}

function storeDir(): string {
  return dirname(storePath());
}

export async function loadHashStore(): Promise<HashStore> {
  try {
    const content = await readFile(storePath(), "utf-8");
    const parsed = JSON.parse(content) as Partial<HashStore>;
    return {
      version: 1,
      snapshots: parsed.snapshots ?? {},
    };
  } catch {
    await mkdir(storeDir(), { recursive: true });
    const defaultStore: HashStore = {
      version: 1,
      snapshots: {},
    };
    await writeFile(storePath(), JSON.stringify(defaultStore), "utf-8");
    return defaultStore;
  }
}

export async function saveHashStore(store: HashStore): Promise<void> {
  await mkdir(storeDir(), { recursive: true });
  await writeFile(storePath(), JSON.stringify(store, null, 2), "utf-8");
}

export async function pruneHashStore(store: HashStore): Promise<void> {
  let changed = false;
  for (const filePath of Object.keys(store.snapshots)) {
    try {
      await stat(filePath);
    } catch {
      delete store.snapshots[filePath];
      changed = true;
    }
  }
  if (changed) {
    await saveHashStore(store);
  }
}
