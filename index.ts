import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { regEdit } from "./src/edit.js";
import { regEditUndo } from "./src/edit-undo.js";
import { regRead } from "./src/read.js";
import { registerWriteHook } from "./src/write-hook.js";

import { registerSearchHook } from "./src/search-hook.js";
import { createLifecycleHooks } from "./src/lifecycle-hooks/index.js";
import { registerLensCommand } from "./src/integrations/pi-lens/command.js";
import { attachIOBridgeAdapter } from "./src/integrations/pi-lens/io-bridge-adapter.js";
import { registerJanitorHooks } from "./src/store-janitor.js";
import { createTypeScriptSpanProvider } from "./src/read-expansion/typescript-provider.js";

export { createLifecycleHooks, registerLifecycleHooks } from "./src/lifecycle-hooks/index.js";

export default function (pi: ExtensionAPI): void {
  // WHY: expansion is a built-in capability; the provider fetches its pinned grammar on first use
  // WHY: and returns null (today's exact read) whenever the grammar cannot be loaded.
  regRead(pi, { spanProvider: createTypeScriptSpanProvider() });

  regEdit(pi);
  regEditUndo(pi);
  registerWriteHook(pi);

  registerSearchHook(pi);
  registerLensCommand(pi);
  // WHY: the adapter subscribes both seams before any tool can serve or mutate a file, so the first
  // WHY: read, edit or write of the session is already mirrored whenever a bridge is present.
  attachIOBridgeAdapter();

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

  // WHY: the store janitor is wired to the lifecycle events that are OFF the tool-call hot path
  // WHY: (`session_start`, `session_shutdown`) and to no other event: see JANITOR_EVENTS in
  // WHY: src/store-janitor.ts for the never-subscribe list and the reason it is a prohibition.
  registerJanitorHooks(pi);
}
