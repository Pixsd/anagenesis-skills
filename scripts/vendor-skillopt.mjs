// Development only. Copy the complete, unmodified `skillopt_sleep` package from
// a Microsoft SkillOpt checkout at the pinned commit and write MANIFEST.json.
// Usage: node scripts/vendor-skillopt.mjs /path/to/SkillOpt
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

const PIN = "45f65ca04f5f6713bca7b9797b495696ba812751";
const source = process.argv[2];
if (!source) throw new Error("Usage: vendor-skillopt.mjs <SkillOpt checkout>");
const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"])
  .toString()
  .trim();
if (head !== PIN) throw new Error(`Checkout is at ${head}, expected ${PIN}`);
if (execFileSync("git", ["-C", source, "status", "--porcelain"]).length)
  throw new Error("Checkout has local changes");

const root = path.resolve(import.meta.dirname, "..");
const vendor = path.join(root, "vendor", "skillopt");
const target = path.join(vendor, "skillopt_sleep");
const tracked = execFileSync("git", [
  "-C",
  source,
  "ls-files",
  "-z",
  "--",
  "skillopt_sleep",
  "LICENSE",
])
  .toString()
  .split("\0")
  .filter(Boolean)
  .sort();
await fs.rm(target, { recursive: true, force: true });
const files = {};
for (const rel of tracked) {
  const bytes = await fs.readFile(path.join(source, rel));
  await fs.mkdir(path.dirname(path.join(vendor, rel)), { recursive: true });
  await fs.writeFile(path.join(vendor, rel), bytes);
  files[rel] = createHash("sha256").update(bytes).digest("hex");
}
const manifest = {
  repository: "https://github.com/microsoft/SkillOpt",
  commit: PIN,
  license: "MIT",
  files,
};
await fs.writeFile(
  path.join(vendor, "MANIFEST.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`Vendored ${tracked.length} files from ${PIN}`);
