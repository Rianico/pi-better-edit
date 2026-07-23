const { execSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

try {
  require(path.join(root, "node_modules", "better-sqlite3"));
  process.exit(0);
} catch (e) {
  const msg = e && typeof e.message === "string" ? e.message : String(e);
  if (/GLIBC|Cannot find module|dlopen|not found/i.test(msg)) {
    console.error("better-sqlite3 prebuilt incompatible, rebuilding from source...");
    try {
      execSync("npm rebuild better-sqlite3 --build-from-source", {
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
