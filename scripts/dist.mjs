// Builds the Windows installer locally and copies it to dist-installer/ProjectControlCenter-Setup.exe.
// Usage: npm run dist
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

// Updater artifacts need the signing key; include them only when it is available.
const signing = !!process.env.TAURI_SIGNING_PRIVATE_KEY;
run(`npx tauri build${signing ? " --config src-tauri/tauri.release.conf.json" : ""}`);

const bundleDir = join("target", "release", "bundle", "nsis");
if (!existsSync(bundleDir)) {
  console.error(`no installer found in ${bundleDir}`);
  process.exit(1);
}
const setup = readdirSync(bundleDir).find((f) => f.endsWith("-setup.exe"));
if (!setup) {
  console.error("installer not found");
  process.exit(1);
}
mkdirSync("dist-installer", { recursive: true });
const out = join("dist-installer", "ProjectControlCenter-Setup.exe");
copyFileSync(join(bundleDir, setup), out);
console.log(`\nInstaller ready: ${out}`);
