const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const bsqlDir = path.join(root, "node_modules", "better-sqlite3");

function removeStaleArtifacts() {
  for (const dir of [root, bsqlDir]) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".better-sqlite3-")) {
        const full = path.join(dir, entry.name);
        try {
          fs.rmSync(full, { recursive: true, force: true });
          console.error("Removed stale artifact:", entry.name);
        } catch {
        }
      }
    }
  }
  const buildDir = path.join(bsqlDir, "build");
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

try {
  require(bsqlDir);
  process.exit(0);
} catch (e) {
  const msg = e && typeof e.message === "string" ? e.message : String(e);
  if (/GLIBC|Cannot find module|dlo|not found/i.test(msg)) {
    console.error("better-sqlite3 prebuilt incompatible, rebuilding from source...");
    removeStaleArtifacts();
    const prebuildDir = path.join(bsqlDir, "prebuilds");
    if (fs.existsSync(prebuildDir)) {
      const platform = process.platform + "-" + process.arch;
      const prebuilt = path.join(prebuildDir, platform + ".node");
      if (fs.existsSync(prebuilt)) {
        fs.unlinkSync(prebuilt);
        console.error("Removed incompatible prebuilt:", platform + ".node");
      }
    }

    try {
      execSync("npx --yes node-gyp rebuild", {
        cwd: bsqlDir,
        stdio: "inherit",
        timeout: 300000,
      });
      console.error("better-sqlite3 rebuilt successfully from source.");
    } catch (rebuildErr) {
      console.error("better-sqlite3 rebuild failed:", rebuildErr.message);
      console.error("Will fall back to sql.js at runtime.");
      process.exit(0);
    }
  }
}
