import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { LFile } from "./file-kind.js";
import { DomainError } from "./domain-errors.js";
import { errCode } from "./utils.js";

export async function valAccess(
  absolutePath: string,
  path: string,
  accessMode: number = constants.R_OK,
): Promise<void> {
  try {
    await fsAccess(absolutePath, accessMode);
  } catch (error: unknown) {
    const code = errCode(error);
    if (code === "ENOENT") {
      throw new DomainError("E_NOT_FOUND", { path });
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new DomainError("E_ACCESS", {
        path,
        kind: "denied",
        access: accessMode & constants.W_OK ? "write" : "read",
      });
    }
    if (code === "ELOOP") {
      throw new DomainError("E_ACCESS", { path, kind: "symlink-loop" });
    }
    throw new DomainError("E_ACCESS", { path, kind: "unreachable" });
  }
}

export function valKind(
  file: LFile,
  path: string,
): asserts file is { kind: "text"; text: string; hadUtf8DecodeErrors?: true } {
  if (file.kind === "directory") {
    throw new DomainError("E_UNSUPPORTED_FILE", { path, kind: "directory" });
  }
  if (file.kind === "binary") {
    throw new DomainError("E_UNSUPPORTED_FILE", {
      path,
      kind: "binary",
      description: file.description,
    });
  }
  if (file.kind === "image") {
    throw new DomainError("E_UNSUPPORTED_FILE", { path, kind: "image" });
  }
}
