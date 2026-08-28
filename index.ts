import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { regEdit } from "./src/edit.js";
import { regEditUndo } from "./src/edit-undo.js";
import { regRead } from "./src/read.js";
import { regReadSkill } from "./src/read-skill.js";
import { registerWriteHook } from "./src/write-hook.js";
import { createLifecycleHooks } from "./src/lifecycle-hooks/index.js";

export { createLifecycleHooks, registerLifecycleHooks } from "./src/lifecycle-hooks/index.js";

export default function (pi: ExtensionAPI): void {
  regRead(pi);
  regReadSkill(pi);

  regEdit(pi);
  regEditUndo(pi);
  registerWriteHook(pi);

  const hooks = createLifecycleHooks();

  (pi as unknown as { on: (e: string, h: unknown) => void }).on(
    "session_start",
    hooks.onSessionStart as unknown as never,
  );
  (pi as unknown as { on: (e: string, h: unknown) => void }).on(
    "tool_result",
    hooks.onToolResult as unknown as never,
  );
}
