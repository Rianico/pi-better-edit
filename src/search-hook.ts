/**
 * SAFETY: Pre-execution bash rewrite for intercepted search commands (spec §3.1/§3.3, I1a).
 *
 * WHY a `tool_call` hook and not `tool_result`: native `grep`/`rg` only print `LINE:content`
 * rows when asked for line numbers, and patching the command before dispatch is the only seam
 * that makes the real binary emit them — no shell re-run, no duplicated regex engine (JS
 * `RegExp` and BRE/ERE/Rust regex diverge, so the system binary must execute natively).
 *
 * WHY no shared state with the `tool_result` side: the rewrite is a pure function of the
 * command text, and `handleBash` re-parses the mutated `event.input.command` on its own. A
 * session- or call-keyed map would leak across concurrent bash calls and could pin a lease to
 * a command some other call rewrote.
 *
 * The hook fails open by construction: it returns without touching `input` unless the pure
 * rewrite actually changed the command, and every throw is swallowed so interception can never
 * break a bash call.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withSearchLineNumbers } from "./bash-classifier.js";

export function registerSearchHook(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    try {
      if (event.toolName !== "bash") return;
      const input = event.input as Record<string, unknown> | undefined;
      if (input === undefined) return;
      const command = input.command;
      if (typeof command !== "string" || command.trim() === "") return;
      const rewritten = withSearchLineNumbers(command);
      // WHY: a denied or non-search command must reach bash byte-identical, so the only
      // WHY: mutation this hook can ever make is the documented `-n` injection.
      if (rewritten === command) return;
      input.command = rewritten;
    } catch {
      // SAFETY: interception is an optimisation, never a gate — a classifier fault leaves the
      // SAFETY: original command and the original raw bash output untouched.
    }
  });
}
