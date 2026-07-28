const fs = require("fs");
const path = require("path");

function cleanNodeModules(nm) {
  if (!fs.existsSync(nm)) return;
  const entries = fs.readdirSync(nm, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".better-sqlite3-")) {
      const full = path.join(nm, entry.name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        console.error("Cleaned up stale better-sqlite3 build artifact:", entry.name);
      } catch {
      }
    }
  }
}

const pkgDir = path.resolve(__dirname, "..");
cleanNodeModules(path.resolve(pkgDir, "node_modules"));
cleanNodeModules(path.resolve(pkgDir, ".."));
