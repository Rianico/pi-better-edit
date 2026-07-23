const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

try {
  require(path.join(root, "node_modules", "better-sqlite3"));
  process.exit(0);
} catch (e) {
  const msg = e && typeof e.message === "string" ? e.message : String(e);
  if (/GLIBC|Cannot find module|dlo|not found/i.test(msg)) {
    console.error("better-sqlite3 prebuilt incompatible, rebuilding from source...");
    const prebuildDir = path.join(root, "node_modules", "better-sqlite3", "prebuilds");
    if (fs.existsSync(prebuildDir)) {
      const platform = process.platform + "-" + process.arch;
      const prebuilt = path.join(prebuildDir, platform + ".node");
      if (fs.existsSync(prebuilt)) {
        fs.unlinkSync(prebuilt);
        console.error("Removed incompatible prebuilt:", platform + ".node");
      }
    }
    try {
      execSync("npm rebuild better-sqlite3", {
        cwd: root,
        stdio: "inherit",
        timeout: 120000,
      });
      console.error("better-sqlite3 rebuilt successfully from source.");
    } catch (rebuildErr) {
      console.error("better-sqlite3 rebuild failed:", rebuildErr.message);
      console.error("Will fall back to sql.js at runtime.");
      process.exit(0);
    }
  }
}
