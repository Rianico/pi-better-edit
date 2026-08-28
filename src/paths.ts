import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

export {
  hashStorePath,
  hashStoreDir,
  legacyHashStorePath,
  configDir,
} from "./hash-store.js";

function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function expand(filePath: string): string {
  const home = homeBase();
  if (filePath === "~") return home;
  if (filePath.startsWith("~/")) return home + filePath.slice(1);
  return filePath;
}

export function toCwd(filePath: string, cwd: string): string {
  if (filePath.includes("\0"))
    throw new Error("[E_BAD_SHAPE] Path contains null byte");
  const expanded = expand(filePath);
  if (expanded.includes("\0"))
    throw new Error("[E_BAD_SHAPE] Path contains null byte");
  // SAFETY: cwd is trusted (ctx.cwd), expand resolves "~" via homedir/XDG and resolvePath normalizes ".."; editing scope intentionally allows any absolute path — OS permissions enforced by valAccess downstream; guard ensures null-byte free and absolute result.
  const resolved = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
  if (!isAbsolute(resolved))
    throw new Error("[E_BAD_SHAPE] Resolved path must be absolute");
  return resolved;
}
