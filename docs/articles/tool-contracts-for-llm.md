# How to write good contracts and guidelines of a tool for LLM (Pi principles + best practices)

Good LLM tool contracts share one shape across all primary sources: a precise name, a 3+ sentence description covering what/when/when-not/parameters/caveats, a strict flat JSON schema with examples, fail-loud actionable errors, and token-efficient outputs. Pi adds its own explicit mechanics: `description` + `promptSnippet` + `promptGuidelines` (each guideline must name its tool), TypeBox `parameters` with `StringEnum`, thrown errors (never returned) for `isError`, and mandatory output truncation at 50KB/2000 lines. This repo's hash-anchored edit tool is a strict-contract case study: content-derived anchors, fail-closed rejection, and reject-and-serve errors.

## TL;DR checklist

- **Name**: verb-led, unique, namespaced (`service_resource_verb`); Pi `snake_case`; MCP ≤64 chars.
- **Description**: ≥3–4 sentences — what / when / when-NOT / params / returns / limits / truncation.
- **Pi extras**: `promptSnippet` (one-liner) + `promptGuidelines` (each names its tool explicitly).
- **Schema**: strict, flat, required-first; `additionalProperties: false`; enums over bools; `StringEnum` on Pi; examples (`input_examples` / description) for complex inputs.
- **Errors**: fail loud — throw (Pi) / `isError: true` (MCP); message states what failed, why, and the exact retry; serve fresh state for retry (reject-and-serve).
- **Output**: high-signal only, truncate (Pi 50KB/2000 lines; Claude Code 25k tokens), say where the rest lives; `concise`/`detailed` switch for ID-heavy flows.
- **Safety**: validate at admission; destructive ops need confirm gates; serialize parallel file mutation (`withFileMutationQueue`); never silently rewrite intent.
- **Surface**: few distinct tools, `action`-param consolidation, ≤20 up front, defer the rest; compat via `prepareArguments`, never by widening the schema.
- **Testing**: prototype → realistic eval tasks + held-out set → transcript analysis with an agent → iterate descriptions/schemas.

## Pi principles

Pi tool contract shape — `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters, execute, ... })`; description is "shown to LLM". Source: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, "Tool Definition" section.

- **`promptGuidelines` must name the tool, never say "this tool"** — bullets are appended flat to the system-prompt `Guidelines` section with no tool-name prefix, so each guideline must say "Use my_tool when…" not "Use this tool when…". Source: `docs/extensions.md`, `pi.registerTool()` + "Custom Tools" sections.
- **`promptSnippet` controls the one-line `Available tools` entry; omit it and the tool is left out of that section** — use it for a short summary; use `promptGuidelines` only for bullets included while the tool is active. Source: `docs/extensions.md`, "Custom Tools".
- **Signal errors by throwing from `execute`, never by returning** — returning a value never sets the error flag; throw `new Error(...)` to get `isError: true` reported to the LLM. Source: `docs/extensions.md`, "Signaling errors".
- **Tools MUST truncate output (50KB / 2000 lines)** — use `truncateHead` (file reads, search) or `truncateTail` (logs, command output), tell the LLM output was truncated and where the full version lives, and document limits in the tool description. Source: `docs/extensions.md`, "Output Truncation".
- **File-mutating custom tools must use `withFileMutationQueue()`** — tool calls run in parallel by default, so two writers can read the same stale file and last-write-wins; queue the whole read-modify-write window on the resolved absolute path. Source: `docs/extensions.md`, "Custom Tools".
- **Keep the public schema strict; use `prepareArguments` as the compat shim** — it runs before validation to fold legacy shapes into the modern schema; never add deprecated fields to `parameters` for old resumed sessions. Source: `docs/extensions.md`, "Argument preparation".
- **Use `StringEnum` from `@earendil-works/pi-ai`, not `Type.Union`/`Type.Literal`** — the latter break Google's API. Source: `docs/extensions.md`, "Tool Definition".
- **Normalize a leading `@` in path args; reconstruct state from `details`** — some models prepend `@` to paths (built-ins strip it); extension state should live in tool-result `details` so it survives branching/reload via `session_start` replay. Source: `docs/extensions.md`, "Custom Tools" + "State Management".
- **Pi philosophy: no MCP / no permission popups in core** — build CLI tools with READMEs (skills) or extensions; permission gates are extension-built (`tool_call` block + `ctx.ui.confirm`). Source: Pi README (<https://pi.dev>) Philosophy section; `docs/extensions.md` `tool_call` event.

## General best practices

**Anthropic:**

- Extremely detailed descriptions are the #1 factor; 3–4+ sentences — cover what the tool does, when to use it (and when not), what each parameter means, and caveats/limitations. Source: [Implement tool use — best practices](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use).
- Consolidate related ops into fewer tools with an `action` param; namespace by service/resource (e.g. `github_list_prs`, `asana_projects_search`) — fewer, distinct tools reduce selection ambiguity; prefix-vs-suffix effects vary by model so evaluate. Source: [Implement tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use); [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents).
- Use `input_examples` for complex/format-sensitive tools; return only high-signal fields — examples must validate against `input_schema`; prefer semantic identifiers over UUIDs/blob URLs; offer a `response_format` (concise/detailed) enum so the agent controls verbosity. Source: [Implement tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use); [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).
- Paginate/filter/truncate with sensible defaults; steer in errors — Claude Code caps tool responses at 25,000 tokens; truncation and validation-error messages should teach the retry (filters, pagination, correct format), not dump codes/tracebacks. Source: [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).
- Evaluate tools with real-world multi-step tasks + held-out test sets, co-optimized with agents — generate realistic prompt/verifier pairs, run simple `while`-loop agents, track accuracy plus call counts/tokens/errors, and have Claude analyze transcripts to refactor descriptions and schemas. Source: [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).
- Client vs server tools and auto/any/tool/none triggering. Source: [Tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview).

**OpenAI:**

- Exact-purpose descriptions + system-prompt usage rules + examples/edge cases; intern test — describe purpose, each parameter and format, output meaning; state when (not) to use each function; add examples for recurring failures; a human with only what the model got must succeed. Source: [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling).
- Make invalid states unrepresentable (enums/objects); offload known args to code; merge chained functions — e.g. never `toggle_light(on, off)`; don't ask the model for IDs you already hold (`submit_refund()` with code-held `order_id`); fold always-sequential calls into one. Source: [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling).
- Always enable `strict: true`; keep ≤ ~20 functions up front; defer the rest with tool search — strict requires `additionalProperties: false` and all properties `required` (optional = add `null` type); function defs cost context tokens, so shorten or defer. Source: [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling).

**MCP:**

- `name` + `description` + `inputSchema` (+ optional `annotations`); two error channels — names are unique case-sensitive IDs (SEP-986 constrains charset/length); protocol errors (unknown tool, invalid args) vs tool-execution errors (`isError: true` in result); servers MUST validate inputs, rate-limit, sanitize outputs. Source: [MCP server/tools spec 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/server/tools).

## Anti-patterns

- Vague one-line descriptions ("Gets data", "Use this tool when…").
- CRUD-per-endpoint sprawl (`list_users`/`list_events`/`create_event` instead of `schedule_event`); overlapping tools with vague boundaries.
- Returning everything (UUIDs, blob URLs, full dumps) with no pagination/truncation.
- Asking the model for values the code already knows; `toggle(on, off)` invalid-state schemas; deep nesting.
- Opaque errors (codes, tracebacks) with no retry instruction; silent auto-fix/dedup/relocate of model intent.
- Schema drift: deprecated fields kept in the public schema; `Type.Union` literals breaking Google; `@`-prefixed paths unhandled.
- Bloating the prompt with rarely used tools instead of deferring/search-loading.

## Application to this repo's edit tool

This repo's edit tool embodies strict-contract design — hash-anchored addressing (`HASH│content`), content-derived stable anchors, fail-closed rejection (never fuzzy-match/relocate), `reject-and-serve` (rejection carries fresh anchors so retry needs no re-read), pure edit (no silent dedup rewrite), `E_SERVED_ECHO` denial (never strip echoed anchors), tombstone/epoch staleness detection, and a controlled glossary (`serve`, `anchor`, `range` vs `served range`). Source: `CONTEXT.md` at repo root.

Already exemplary: hash anchors make addressing verifiable; fail-closed + reject-and-serve turns errors into retries; pure-edit (no dedup rewrite) preserves intent; glossary pins the model–tool boundary. Gaps to close per the sources above:

1. Check every `promptGuidelines` bullet names the tool explicitly (Pi flat-append rule). Done in ADR-0015.
2. Document truncation/drift-notice caps in the tool description itself.
3. ~~Add `input_examples` for the compact-tuple payload~~ — superseded by ADR-0015: tuples replaced with named objects (`{anchor_from, anchor_to, replace_with}`), which are self-describing and accepted by every provider schema.
4. Keep an eval set of stale-anchor/echo/drift scenarios as regression protection (Anthropic eval-driven loop).

## Sources

- Pi `docs/extensions.md` — owns Pi tool-contract mechanics; highest priority.
- Pi `README.md` — philosophy (no MCP, tools via extensions/skills).
- Anthropic "Writing effective tools for AI agents" (<https://www.anthropic.com/engineering/writing-tools-for-agents>) — eval-driven principles, namespacing, token efficiency, description prompt-engineering.
- Anthropic "Implement tool use" (<https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use>) — description/schema/examples/namespacing rules, `input_examples`, name regex.
- Anthropic "Tool use overview" (<https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview>) — client vs server tools, triggering modes.
- OpenAI "Function calling" (<https://developers.openai.com/api/docs/guides/function-calling>) — strict mode, best-practices list, namespaces, tool search, parallel calls.
- MCP Tools spec 2025-03-26 (<https://modelcontextprotocol.io/specification/2025-03-26/server/tools>) — name/description/inputSchema/annotations, error channels, security duties.
- Repo `CONTEXT.md` — hash-anchored edit tool as strict-contract case study.
- Dropped as redundant/non-additive: YouTube/LiteLLM/Bedrock mirrors, StackOverflow-style OpenAI guides, aiquinta/agenticai-flow/ASAPP blogs, MCP naming-convention blog (superseded by SEP-986 + Anthropic guidance).
