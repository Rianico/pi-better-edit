export interface EvalTarget {
  version: string;
  register: (pi: any) => void;
  lineHashes: (content: string, path?: string) => Promise<string[]>;
}

export async function resolveTarget(): Promise<EvalTarget> {
  const target = process.env.EVAL_TARGET ?? "local";
  if (target === "local") {
    const [{ default: register }, { lineHashes }, { version }] =
      await Promise.all([
        import("../../index"),
        import("../../src/hashline"),
        import("../../package.json"),
      ]);
    return { version: `local (${version})`, register, lineHashes };
  }
  if (target === "package") {
    const [{ default: register }, { lineHashes }, { version }] =
      await Promise.all([
        import("pi-hashline-edit-pro"),
        import("pi-hashline-edit-pro/src/hashline"),
        import("pi-hashline-edit-pro/package.json"),
      ]);
    return { version: `pi-hashline-edit-pro@${version}`, register, lineHashes };
  }
  throw new Error(`Unknown EVAL_TARGET "${target}" (expected "local" or "package")`);
}
