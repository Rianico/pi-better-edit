const fs = require("fs");
const path = require("path");

const parentNodeModules = path.resolve(__dirname, "..", "node_modules");
if (!fs.existsSync(parentNodeModules)) process.exit(0);

const entries = fs.readdirSync(parentNodeModules, { withFileTypes: true });
for (const entry of entries) {
  if (entry.name.startsWith(".better-sqlite3-")) {
    const full = path.join(parentNodeModules, entry.name);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      console.error("Cleaned up stale better-sqlite3 build artifact:", entry.name);
    } catch {
    }
  }
}
