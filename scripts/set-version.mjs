// Sets the application version in package.json and the Cargo workspace.
// Usage: node scripts/set-version.mjs 1.2.3
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <semver>");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = version;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

const cargo = readFileSync("Cargo.toml", "utf8");
const updated = cargo.replace(/(\[workspace\.package\][^[]*?version\s*=\s*")[^"]+(")/, `$1${version}$2`);
if (updated === cargo && !cargo.includes(`version = "${version}"`)) {
  console.error("could not update Cargo.toml workspace version");
  process.exit(1);
}
writeFileSync("Cargo.toml", updated);
console.log(`version set to ${version}; run cargo check to refresh Cargo.lock, commit, then: git tag v${version}`);
