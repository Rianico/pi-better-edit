export interface EvalTarget {
  version: string;
  register: (pi: any) => void;
  lineHashes: (content: string, path?: string) => Promise<string[]>;
  toolNames: { read: string; edit: string; undo: string };
  adaptEditParams?: (name: string, params: any) => any;
  adaptReadParams?: (name: string, params: any) => any;
}

// WHY: the registered read still speaks the legacy wire (`path`); the battery's new-wire read
// WHY: items are translated for comparison only, the way adaptEditParams translates edit items.
export function adaptReadParamsForLegacy(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  const record = params as Record<string, unknown>;
  if (!("file" in record)) return params;
  const { file, ...rest } = record;
  return { ...rest, path: file };
}

export async function resolveTarget(): Promise<EvalTarget> {
  const target = process.env.EVAL_TARGET ?? "local";
  if (target === "local") {
    const [{ default: register }, { lineHashes }, { version }] = await Promise.all([
      import("../../index"),
      import("../../src/hashline"),
      import("../../package.json"),
    ]);
    // WHY: (ticket-04 §3) the battery speaks the wire directly — the local target IS the current
    // WHY: contract, so the legacy folding adapter is gone: no adaptEditParams.
    return {
      version: `local (${version})`,
      register,
      lineHashes,
      toolNames: { read: "read", edit: "edit", undo: "undo_last_edit" },
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
      // WHY: the published comparator tool still speaks its own legacy wire; the battery's
      // WHY: new-wire items are TRANSLATED (not folded) into that shape for comparison only.
      adaptEditParams: (name: string, params: any) => {
        if (name !== "replace" || !params || typeof params !== "object") return params;
        const file = params.file;
        if (!Array.isArray(params.edits)) return params;
        if (params.edits.length === 1) {
          const item = params.edits[0];
          return {
            path: file,
            remove_from: item.anchor_from,
            remove_to: item.anchor_to,
            replacement_text: item.text,
          };
        }
        return {
          path: file,
          edits: params.edits.map((item: any) => ({
            remove_from: item.anchor_from,
            remove_to: item.anchor_to,
            replacement_text: item.text,
          })),
        };
      },

      adaptReadParams: (name: string, params: any) =>
        name === "read" ? adaptReadParamsForLegacy(params) : params,
    };
  }
  throw new Error(`Unknown EVAL_TARGET "${target}" (expected "local" or "package")`);
}
