import { readFile, writeFile, mkdir } from "fs/promises";
import { stat } from "fs/promises";
import { hashStorePath, hashStoreDir } from "./paths";

export interface FileSnapshot {
  content: string;
  hashes: string[];
}

export interface HashStore {
  version: 1;
  snapshots: Record<string, FileSnapshot>;
}

export async function loadHashStore(): Promise<HashStore> {
  try {
    const content = await readFile(hashStorePath(), "utf-8");
    const parsed = JSON.parse(content) as Partial<HashStore>;
    return {
      version: 1,
      snapshots: parsed.snapshots ?? {},
    };
  } catch {
    await mkdir(hashStoreDir(), { recursive: true });
    const defaultStore: HashStore = {
      version: 1,
      snapshots: {},
    };
    await writeFile(hashStorePath(), JSON.stringify(defaultStore), "utf-8");
    return defaultStore;
  }
}

export async function saveHashStore(store: HashStore): Promise<void> {
  await mkdir(hashStoreDir(), { recursive: true });
  await writeFile(hashStorePath(), JSON.stringify(store, null, 2), "utf-8");
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
