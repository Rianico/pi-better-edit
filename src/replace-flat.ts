import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  buildToolDef,
  flatEditToolSchema,
} from "./replace";

export { flatEditToolSchema };

export function buildToolDefFlat() {
  return buildToolDef({ flat: true });
}

export function regReplaceFlat(pi: ExtensionAPI): void {
  pi.registerTool(buildToolDef({ flat: true }));
}
