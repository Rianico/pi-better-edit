import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { regEdit } from "./src/edit.js";
import { regEditUndo } from "./src/edit-undo.js";
import { regRead } from "./src/read.js";
import { regReadSkill } from "./src/read-skill.js";
import { registerWriteHook } from "./src/write-hook.js";
import { createLifecycleHooks } from "./src/lifecycle-hooks/index.js";

export {
  createLifecycleHooks,
  registerLifecycleHooks,
} from "./src/lifecycle-hooks/index.js";

export default function (pi: ExtensionAPI): void {
  regRead(pi);
  regReadSkill(pi);

  regEdit(pi);
  regEditUndo(pi);
  registerWriteHook(pi);

  const hooks = createLifecycleHooks();

  // SAFETY: pi.on is typed for known lifecycle events only — string key widening needed to register lifecycle hooks whose contract is validated by createLifecycleHooks and matches runtime pi.on behavior.
  (pi as unknown as { on: (e: string, h: unknown) => void }).on(
    "session_start",
    // SAFETY: ExtensionAPI session_start handler type is strict tuple overload — cast to lifecycle hook handler proven by onSessionStart signature in src/lifecycle-hooks.
    hooks.onSessionStart as unknown as never,
  );
  // SAFETY: same as above — tool_result string key widening for lifecycle delegation.
  (pi as unknown as { on: (e: string, h: unknown) => void }).on(
    "tool_result",
    // SAFETY: ExtensionAPI tool_result overload is tuple-specific — cast to lifecycle hook handler validated by onToolResult in src/lifecycle-hooks.
    hooks.onToolResult as unknown as never,
  );
}
