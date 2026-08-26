import { homedir } from "os";
import { isAbsolute, resolve as resolvePath } from "path";

export {
  hashStorePath,
  hashStoreDir,
  legacyHashStorePath,
  configDir,
} from "./hash-store";

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
  const expanded = expand(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
