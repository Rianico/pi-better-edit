export interface EvalTarget {
  version: string;
  register: (pi: any) => void;
  lineHashes: (content: string, path?: string) => Promise<string[]>;
  toolNames: { read: string; edit: string; undo: string };
  adaptEditParams?: (name: string, params: any) => any;
}

export async function resolveTarget(): Promise<EvalTarget> {
  const target = process.env.EVAL_TARGET ?? "local";
  if (target === "local") {
    const [{ default: register }, { lineHashes }, { version }] = await Promise.all([
      import("../../index"),
      import("../../src/hashline"),
      import("../../package.json"),
    ]);
    return {
      version: `local (${version})`,
      register,
      lineHashes,
      toolNames: { read: "read", edit: "edit", undo: "undo_last_edit" },
      adaptEditParams: (name: string, params: any) => {
        if (name !== "edit" || !params || typeof params !== "object") return params;
        if (Array.isArray(params.edits)) {
          return {
            file: params.file ?? params.path,
            edits: params.edits,
            ...(params.mode ? { mode: params.mode } : {}),
          };
        }
        const file = params.file ?? params.path;
        const anchor_from = params.anchor_from ?? params.remove_from;
        const anchor_to = params.anchor_to ?? params.remove_to;
        const replace_with = params.replace_with ?? params.replacement_text;
        return {
          file,
          edits: [{ anchor_from, anchor_to, replace_with }],
          ...(params.mode ? { mode: params.mode } : {}),
        };
      },
    };
  }
  if (target === "package") {
    const [{ default: register }, { lineHashes }, { version }] = await Promise.all([
      import("pi-hashline-edit-pro"),
      import("pi-hashline-edit-pro/src/hashline"),
      import("pi-hashline-edit-pro/package.json"),
    ]);
    return {
      version: `pi-hashline-edit-pro@${version}`,
      register,
      lineHashes,
      toolNames: { read: "read", edit: "replace", undo: "undo_last_replace" },
      adaptEditParams: (name: string, params: any) => {
        if (name !== "replace" || !params || typeof params !== "object") return params;
        const file = params.path ?? params.file;
        let from = params.remove_from ?? params.anchor_from;
        let to = params.remove_to ?? params.anchor_to;
        let text = params.replacement_text ?? params.replace_with;
        if (Array.isArray(params.edits) && params.edits.length === 1) {
          const item = params.edits[0];
          from = item.remove_from ?? item.anchor_from;
          to = item.remove_to ?? item.anchor_to;
          text = item.replacement_text ?? item.replace_with;
        }
        return {
          path: file,
          remove_from: from,
          remove_to: to,
          replacement_text: text,
        };
      },
    };
  }
  throw new Error(`Unknown EVAL_TARGET "${target}" (expected "local" or "package")`);
}
