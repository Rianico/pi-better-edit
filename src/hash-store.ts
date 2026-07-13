import { readFile, mkdir } from "fs/promises";
import { stat } from "fs/promises";
import { hashStorePath, hashStoreDir } from "./paths";
import { errCode } from "./validation";
import { writeAtomic } from "./fs-write";
function isValidSnapshot(value: unknown): value is FileSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.content !== "string") return false;
  if (!Array.isArray(v.hashes)) return false;
  for (const h of v.hashes) {
    if (typeof h !== "string") return false;
  }
  return true;
}
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
    const raw = parsed.snapshots;
    const snapshots: Record<string, FileSnapshot> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (isValidSnapshot(value)) {
          snapshots[key] = value;
        }
      }
    }
    return { version: 1, snapshots };
  } catch (error: unknown) {
    if (errCode(error) !== "ENOENT") {
      console.error("Hash store corrupted, creating fresh store:", error);
    }
    await mkdir(hashStoreDir(), { recursive: true });
    const defaultStore: HashStore = {
      version: 1,
      snapshots: {},
    };
    await writeAtomic(hashStorePath(), JSON.stringify(defaultStore));
    return defaultStore;
  }
}

export async function saveHashStore(store: HashStore): Promise<void> {
  await mkdir(hashStoreDir(), { recursive: true });
  await writeAtomic(hashStorePath(), JSON.stringify(store, null, 2));
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
