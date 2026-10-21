import fs from "node:fs";
import path from "node:path";

const sourceDir = path.resolve(process.argv[2] ?? process.cwd());
const profileDir = path.resolve(process.argv[3] ?? path.join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "web"));
const harnessRoot = process.env.HARNESS_ROOT ? path.resolve(process.env.HARNESS_ROOT) : "";
const sourcePackagePath = path.join(sourceDir, "package.json");
const profilePackagePath = path.join(profileDir, "package.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function backupOnce(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const backup = `${file}.dsh-deploy-${stamp}.bak`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  console.log(`backup=${backup}`);
}
function requireFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
}

requireFile(sourcePackagePath, "source package.json");
requireFile(profilePackagePath, "profile package.json");
requireFile(path.join(sourceDir, "lib", "index.js"), "compiled plugin lib/index.js");
requireFile(path.join(sourceDir, "cordis.patch.yml"), "plugin cordis.patch.yml");

const sourcePackage = readJson(sourcePackagePath);
const profilePackage = readJson(profilePackagePath);

if (sourcePackage.name !== "dsh-purge") {
  throw new Error(`unexpected source package name: ${sourcePackage.name}`);
}
if (profilePackage.name !== "dsh-profile-web") {
  throw new Error(`unexpected profile package name: ${profilePackage.name}`);
}

let hostVersion = "";
if (harnessRoot && fs.existsSync(path.join(harnessRoot, "package.json"))) {
  const rootPackage = readJson(path.join(harnessRoot, "package.json"));
  if (rootPackage.name !== "@deepseek-ai/dsh-root") {
    throw new Error(`HARNESS_ROOT is not a DeepSeek Harness checkout: ${harnessRoot}`);
  }
  hostVersion = String(rootPackage.version ?? "");
}
if (hostVersion) {
  sourcePackage.dshTarget = hostVersion;
  backupOnce(sourcePackagePath);
  writeJson(sourcePackagePath, sourcePackage);
  console.log(`source dshTarget=${hostVersion}`);
}

profilePackage.dependencies ??= {};
profilePackage.dependencies["dsh-purge"] = `link:${sourceDir.replaceAll("\\", "/")}`;
profilePackage.dsh ??= {};
profilePackage.dsh.profile ??= {};
profilePackage.dsh.profile.bundles ??= [];
if (!profilePackage.dsh.profile.bundles.includes("dsh-purge")) {
  profilePackage.dsh.profile.bundles.push("dsh-purge");
}
backupOnce(profilePackagePath);
writeJson(profilePackagePath, profilePackage);
console.log(`profile dependency=${profilePackage.dependencies["dsh-purge"]}`);
console.log(`bundle present=${profilePackage.dsh.profile.bundles.includes("dsh-purge")}`);
