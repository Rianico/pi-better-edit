import { stat } from "fs/promises";
import { resolveTarget } from "./fs-write";

export type SnapInfo = {
  snapshotId: string;
  mtimeMs: number;
  size: number;
};

function fmtSnapId(canonicalPath: string, info: { mtimeMs: number; size: number }): string {
  return `v1|${canonicalPath}|${info.mtimeMs}|${info.size}`;
}

export async function fileSnap(absolutePath: string): Promise<SnapInfo> {
  const canonicalPath = await resolveTarget(absolutePath);
  const stats = await stat(canonicalPath);
  return {
    snapshotId: fmtSnapId(canonicalPath, stats),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}
