#!/usr/bin/env node
/**
 * Prints the tool prompts exactly as the model receives them, grouped by tool and surface.
 *
 * WHY the loaders: the served text is not the file. `edit` is constant-is-source
 * (`src/payload-contract.ts`, with `prompts/edit*.md` as generated mirrors), while `read` and
 * `undo_last_edit` are file-is-source. Reading `prompts/` directly would show the mirrors for
 * one tool and the truth for the others; calling `loadP`/`loadGuide` is the only view that is
 * true for all three, and it is the same seam the extension registers. This tool therefore
 * *executes* the prompt path instead of parsing it.
 *
 * WHY the resolve hook: `src/prompts.ts` imports `./payload-contract.js` (the ESM build
 * spelling), which Node's type stripping does not rewrite to `.ts`. The hook maps a failed
 * `.js` specifier to its `.ts` sibling so the real module graph loads without a bundler or tsx.
 *
 * Report, not gate: the header states the `edit` description budget (the < 800 cap lives in
 * `test/core/gemma-tool-calling.test.ts`), mirror parity, and the ADR-0021 prohibition on
 * prose that names the literal flag. Those facts are printed so a prompt change can be read
 * and judged; the pass/fail authority stays with the tests.
 *
 * Usage:
 *   node scripts/served-prompts.mjs                       # all tools, human report
 *   node scripts/served-prompts.mjs read edit             # only these tools
 *   node scripts/served-prompts.mjs --surface guidelines  # one surface per tool
 *   node scripts/served-prompts.mjs --format json         # machine-readable
 *   node scripts/served-prompts.mjs --format markdown     # paste-ready
 *   node scripts/served-prompts.mjs --no-text             # headings and counts only
 */
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS_DIR = join(ROOT, "prompts");
const EDIT_DESCRIPTION_CAP = 800; // `expect(EDIT_DESCRIPTION.length).toBeLessThan(800)`

// WHY: the report is meant to be piped (`| head`, `| jq`). A consumer that closes early raises EPIPE
// WHY: on stdout; treat that as the reader's stop, not a tool failure.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

/** Node's type stripping keeps `.js` specifiers, so map a missing `.js` to its `.ts` sibling. */
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.endsWith(".js")) throw error;
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});

const { loadGuide, loadP } = await import(join(ROOT, "src/prompts.ts"));
const { EDIT_DESCRIPTION, EDIT_SNIPPET, EDIT_GUIDELINES } = await import(
  join(ROOT, "src/payload-contract.ts")
);

/** One tool's five faces: provenance, then the three model-facing surfaces. */
const TOOLS = [
  {
    id: "read",
    kind: "file-is-source",
    files: ["prompts/read.md", "prompts/read-snippet.md", "prompts/read-guidelines.md"],
    load: () => ({
      description: loadP("../prompts/read.md"),
      snippet: loadP("../prompts/read-snippet.md"),
      guidelines: loadGuide("../prompts/read-guidelines.md"),
    }),
  },
  {
    id: "edit",
    kind: "constant-is-source",
    files: ["src/payload-contract.ts", "prompts/edit.md"],
    mirrors: ["prompts/edit.md", "prompts/edit-snippet.md", "prompts/edit-guidelines.md"],
    load: () => ({
      description: loadP("../prompts/edit.md"),
      snippet: loadP("../prompts/edit-snippet.md"),
      guidelines: loadGuide("../prompts/edit-guidelines.md"),
    }),
  },
  {
    id: "undo_last_edit",
    kind: "file-is-source",
    files: [
      "prompts/undo-last-edit.md",
      "prompts/undo-last-edit-snippet.md",
      "prompts/undo-last-edit-guidelines.md",
    ],
    load: () => ({
      description: loadP("../prompts/undo-last-edit.md"),
      snippet: loadP("../prompts/undo-last-edit-snippet.md"),
      guidelines: loadGuide("../prompts/undo-last-edit-guidelines.md"),
    }),
  },
];

const SURFACES = ["description", "snippet", "guidelines"];

function parseArgs(argv) {
  const options = { format: "text", surfaces: SURFACES, tools: [], text: true, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-text") options.text = false;
    else if (arg === "--format") options.format = argv[++index] ?? "";
    else if (arg.startsWith("--format=")) options.format = arg.slice("--format=".length);
    else if (arg === "--surface") options.surfaces = [argv[++index] ?? ""];
    else if (arg.startsWith("--surface=")) options.surfaces = [arg.slice("--surface=".length)];
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else options.tools.push(arg);
  }
  if (!["text", "markdown", "json"].includes(options.format)) {
    throw new Error(`unknown format "${options.format}" (text, markdown, json)`);
  }
  for (const surface of options.surfaces) {
    if (!SURFACES.includes(surface)) {
      throw new Error(`unknown surface "${surface}" (${SURFACES.join(", ")})`);
    }
  }
  const known = TOOLS.map((tool) => tool.id);
  for (const tool of options.tools) {
    if (!known.includes(tool)) throw new Error(`unknown tool "${tool}" (${known.join(", ")})`);
  }
  return options;
}

const chars = (text) => [...text].length;

function readRepoFile(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

/** The `edit` mirrors must be byte-equal to the constants, modulo the generator's framing. */
function mirrorParity() {
  const expected = {
    "prompts/edit.md": `${EDIT_DESCRIPTION}\n`,
    "prompts/edit-snippet.md": `${EDIT_SNIPPET}\n`,
    "prompts/edit-guidelines.md": `${EDIT_GUIDELINES.map((line) => `- ${line}`).join("\n")}\n`,
  };
  const drift = Object.entries(expected)
    .filter(([file, text]) => readRepoFile(file) !== text)
    .map(([file]) => file);
  return { checked: Object.keys(expected), drift };
}

/** ADR-0021 decision 6: the flag is disclosed only by its refusal, never by prose. */
function literalMentions() {
  return readdirSync(PROMPTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => /\bliteral\b/i.test(readFileSync(join(PROMPTS_DIR, name), "utf-8")));
}

function collect(options) {
  const tools = TOOLS.filter(
    (tool) => options.tools.length === 0 || options.tools.includes(tool.id),
  ).map((tool) => {
    const loaded = tool.load();
    const surfaces = {};
    for (const surface of options.surfaces) {
      const value = loaded[surface];
      surfaces[surface] = Array.isArray(value)
        ? { entries: value, chars: chars(value.join("\n")) }
        : { text: value, chars: chars(value) };
    }
    return {
      id: tool.id,
      kind: tool.kind,
      files: tool.files,
      budget:
        tool.id === "edit"
          ? {
              cap: EDIT_DESCRIPTION_CAP,
              chars: chars(loaded.description),
              spare: EDIT_DESCRIPTION_CAP - chars(loaded.description),
            }
          : null,
      surfaces,
    };
  });
  return {
    source: "live loaders (src/prompts.ts over src/payload-contract.ts and prompts/*.md)",
    mirror: mirrorParity(),
    literalMentions: literalMentions(),
    tools,
  };
}

function renderText(report, options) {
  const lines = [];
  const push = (line = "") => lines.push(line);
  push("pi-better-edit · served prompts");
  push(`  source   ${report.source}`);
  push(
    `  mirror   ${report.mirror.drift.length === 0 ? "exact" : `DRIFT: ${report.mirror.drift.join(", ")}`}`,
  );
  push(
    `  literal  ${report.literalMentions.length === 0 ? "none (ADR-0021 decision 6)" : `PRESENT in ${report.literalMentions.join(", ")}`}`,
  );
  if (report.tools.some((tool) => tool.budget)) {
    const edit = report.tools.find((tool) => tool.budget)?.budget;
    if (edit)
      push(`  budget   edit description ${edit.chars}/${edit.cap} chars (${edit.spare} spare)`);
  }
  for (const tool of report.tools) {
    push();
    push(`${"=".repeat(78)}`);
    push(`${tool.id}  ·  ${tool.kind}`);
    for (const file of tool.files) push(`  ${file}`);
    push(`${"=".repeat(78)}`);
    if (tool.budget) push(`  description ${tool.budget.chars}/${tool.budget.cap} chars`);
    for (const surface of options.surfaces) {
      const value = tool.surfaces[surface];
      if (!value) continue;
      push();
      if (surface === "guidelines") {
        push(`-- guidelines · ${value.entries.length} entries · ${value.chars} chars --`);
        if (options.text) {
          value.entries.forEach((entry, index) => {
            push(`  ${String(index + 1).padStart(2)}. ${entry}`);
          });
        }
      } else {
        push(`-- ${surface} · ${value.chars} chars --`);
        if (options.text) for (const line of value.text.split("\n")) push(`  ${line}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown(report, options) {
  const lines = [];
  const push = (line = "") => lines.push(line);
  push("# Served prompts");
  push();
  push(`Generated from ${report.source}.`);
  push();
  push(
    `- Mirrors: ${report.mirror.drift.length === 0 ? "exact" : `DRIFT in ${report.mirror.drift.join(", ")}`}`,
  );
  push(
    `- Literal mentions in prompts: ${report.literalMentions.length === 0 ? "none" : report.literalMentions.join(", ")}`,
  );
  for (const tool of report.tools) {
    push();
    push(`## ${tool.id}`);
    push();
    push(`Source: \`${tool.kind}\` — ${tool.files.map((file) => `\`${file}\``).join(", ")}`);
    if (tool.budget) {
      push();
      push(
        `Description: **${tool.budget.chars}/${tool.budget.cap}** chars (${tool.budget.spare} spare).`,
      );
    }
    for (const surface of options.surfaces) {
      const value = tool.surfaces[surface];
      if (!value) continue;
      push();
      if (surface === "guidelines") {
        push(`### guidelines (${value.entries.length} entries, ${value.chars} chars)`);
        push();
        if (options.text) value.entries.forEach((entry, index) => push(`${index + 1}. ${entry}`));
      } else {
        push(`### ${surface} (${value.chars} chars)`);
        push();
        if (options.text) {
          push("```text");
          push(value.text);
          push("```");
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function usage() {
  return [
    "Usage: node scripts/served-prompts.mjs [tool ...] [--format text|markdown|json]",
    "                                          [--surface description|snippet|guidelines] [--no-text]",
    "",
    "Prints the prompts the model actually receives, per tool and surface, from the live loaders.",
    "Tools: read, edit, undo_last_edit. Surfaces: description, snippet, guidelines.",
  ].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const report = collect(options);
    const renderers = { json: renderJson, markdown: renderMarkdown, text: renderText };
    const rendered =
      options.format === "json"
        ? renderers.json(report)
        : renderers[options.format](report, options);
    process.stdout.write(rendered);
  }
} catch (error) {
  process.stderr.write(`served-prompts: ${error instanceof Error ? error.message : error}\n\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 2;
}
