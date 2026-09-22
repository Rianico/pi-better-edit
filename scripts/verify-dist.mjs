/**
 * Verifies the built extension entry point, rather than trusting that the bundler
 * exited 0. pi imports `pi.extensions` through jiti, so a bundle that resolves in
 * the build can still throw at extension load and take every tool down with it.
 *
 * Regression guard for the #157 failure class: a bundler rewriting `node:` specifiers
 * to bare ones (`node:sqlite` -> `sqlite`), which no package.json lint catches.
 *
 * Run after `pnpm run build`; wired into `prepack` so a broken artifact cannot be
 * packed or published.
 */
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const root = new URL("..", import.meta.url);
const distUrl = new URL("dist/index.js", root);

let pkg;
try {
  pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
} catch (cause) {
  console.error(`verify-dist: cannot read package.json: ${cause.message}`);
  process.exit(1);
}

let code;
try {
  code = readFileSync(distUrl, "utf8");
} catch {
  console.error("verify-dist: dist/index.js not found; run `pnpm run build` first");
  process.exit(1);
}

const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);
// `builtinModules` lists `fs` bare but `node:sqlite` prefixed, so normalise both
// before comparing: a bare specifier naming a builtin means the prefix was stripped.
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

const offenders = new Set();
for (const line of code.split("\n")) {
  const specifier = line.match(/^(?:import|export)\b[^"']*["']([^"']+)["']/)?.[1];
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("node:")) continue;
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (builtins.has(name) || !declared.has(name)) offenders.add(specifier);
}
if (offenders.size > 0) {
  console.error(
    `dist/index.js has unresolvable bare specifiers: ${[...offenders].sort().join(", ")}`,
  );
  process.exit(1);
}

// The entry point must actually evaluate, and default-export the extension factory.
const mod = await import(distUrl.href);
if (typeof mod.default !== "function") {
  console.error("dist/index.js does not default-export the extension factory");
  process.exit(1);
}

// Prompts load as `new URL(relativePath, import.meta.url)` with callers passing
// "../prompts/*.md", which only resolves because dist/ sits exactly one level below
// the package root. Resolve each reference against the built entry the same way the
// bundle does, so a nested output path fails here instead of at extension load.
const promptRefs = new Set(
  [...code.matchAll(/["'](\.\.?\/prompts\/[A-Za-z0-9._-]+\.md)["']/g)].map(([, ref]) => ref),
);
if (promptRefs.size === 0) {
  console.error("no prompt asset references found in dist/index.js; extraction pattern is stale");
  process.exit(1);
}
for (const ref of promptRefs) {
  readFileSync(new URL(ref, distUrl));
}

console.log(
  `verify-dist: dist/index.js loads, specifiers resolve, ${promptRefs.size} prompt assets found`,
);
