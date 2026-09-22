// Builds the release files of Eagle Library: release/eagle-library-v13.zip and release/module.json.
// Run it with `npm run package`. It publishes nothing and does not touch git: a tag, a push and a GitHub release are
// separate steps that the project lead orders.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const releaseDir = join(root, "release");
const stageDir = join(releaseDir, "stage");
const MODULE_ID = "eagle-library";
const ZIP_NAME = `${MODULE_ID}-v13.zip`;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PLAIN_PATH = /^[\w.-]+(\/[\w.-]+)*$/;
// The fields that point Foundry at places on the web. A manifest names all of them or none: without a repository there is
// no address to give, and none to invent.
const ADDRESS_FIELDS = ["url", "bugs", "manifest", "download"];

class PackageError extends Error {}

function fail(message) {
  throw new PackageError(message);
}

// Runs a command; a failure ends the script with `what` instead of a stack trace.
function run(command, args, options, what) {
  try {
    return execFileSync(command, args, options);
  } catch (error) {
    return fail(`${what}${error.stderr ? `: ${String(error.stderr).trim()}` : ""}`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(`cannot read ${path}: ${error.message}`);
  }
}

// The files of the release as the manifest names them, relative to the module folder. Each one has its source in v13/.
function shippedFiles(manifest) {
  const languages = Array.isArray(manifest.languages) ? manifest.languages.map((language) => language?.path) : [];
  const scripts = Array.isArray(manifest.esmodules) ? manifest.esmodules : [];
  const styles = Array.isArray(manifest.styles) ? manifest.styles : [];
  return ["module.json", ...scripts, ...languages, ...styles];
}

// The rules a release depends on; core/manifest.test.ts holds the same rules for the repository.
function manifestProblems(manifest, pack) {
  const problems = [];
  if (manifest.id !== MODULE_ID) problems.push(`id is "${manifest.id}", expected "${MODULE_ID}"`);
  if (!SEMVER.test(String(manifest.version))) problems.push(`version "${manifest.version}" is not x.y.z`);
  if (pack.version !== manifest.version) {
    problems.push(`package.json has version "${pack.version}" but module.json has "${manifest.version}"`);
  }
  const named = ADDRESS_FIELDS.filter((field) => manifest[field] !== undefined);
  if (named.length > 0 && named.length < ADDRESS_FIELDS.length) {
    const missing = ADDRESS_FIELDS.filter((field) => manifest[field] === undefined);
    problems.push(`the manifest names ${named.join(", ")} but not ${missing.join(", ")}: name all of ${ADDRESS_FIELDS.join(", ")} or none`);
  } else if (named.length === ADDRESS_FIELDS.length) {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(String(manifest.url))) {
      problems.push(`url "${manifest.url}" is not the address of a GitHub repository`);
    } else {
      const expectedManifest = `${manifest.url}/releases/latest/download/module.json`;
      const expectedDownload = `${manifest.url}/releases/download/v13-v${manifest.version}/${ZIP_NAME}`;
      if (manifest.manifest !== expectedManifest) problems.push(`manifest is "${manifest.manifest}", expected "${expectedManifest}"`);
      if (manifest.download !== expectedDownload) problems.push(`download is "${manifest.download}", expected "${expectedDownload}"`);
    }
  }
  if (!Array.isArray(manifest.esmodules) || manifest.esmodules.length === 0) problems.push("esmodules is not a list with an entry");
  if (manifest.languages !== undefined && (!Array.isArray(manifest.languages) || manifest.languages.length === 0)) {
    problems.push("languages is not a list with an entry");
  }
  if (manifest.styles !== undefined && (!Array.isArray(manifest.styles) || manifest.styles.length === 0)) {
    problems.push("styles is not a list with an entry");
  }
  for (const path of shippedFiles(manifest)) {
    if (typeof path !== "string" || !PLAIN_PATH.test(path) || path.split("/").includes("..")) {
      problems.push(`the manifest names the file "${path}", which is not a plain relative path`);
    }
  }
  return problems;
}

function checkZipTool() {
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
  } catch {
    fail("the `zip` tool is not installed or not on the PATH; install it and run this again");
  }
}

// The names of the entries of an archive, sorted, as `zip -sf` prints them.
function archiveEntries(zipPath) {
  const listing = String(run("zip", ["-sf", zipPath], { encoding: "utf8" }, "cannot list the archive"));
  return listing
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .map((line) => line.trim())
    .sort();
}

function describeFile(path) {
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return `${basename(path)}  ${(statSync(path).size / 1024).toFixed(1)} kB  sha256 ${sha256}`;
}

function main() {
  if (basename(here) !== "v13") fail(`this script belongs in the v13 folder, not in ${here}`);

  const manifest = readJson(join(here, "module.json"));
  const pack = readJson(join(root, "package.json"));
  const problems = manifestProblems(manifest, pack);
  const files = shippedFiles(manifest);
  const scripts = Array.isArray(manifest.esmodules) ? manifest.esmodules : [];
  for (const path of files) {
    // The bundle is built below; every other file has to exist already.
    if (typeof path === "string" && PLAIN_PATH.test(path) && !scripts.includes(path) && !existsSync(join(here, path))) {
      problems.push(`the file "${path}" is named in the manifest but does not exist in v13/`);
    }
  }
  if (problems.length > 0) fail(`the manifest is not ready for a release:\n  - ${problems.join("\n  - ")}`);
  checkZipTool();

  console.log(`package: building version ${manifest.version}`);
  run("npm", ["run", "build"], { cwd: root, stdio: "inherit" }, "the build failed (see the messages above)");
  for (const path of manifest.esmodules) {
    if (!existsSync(join(here, path)) || statSync(join(here, path)).size === 0) fail(`the build did not produce "${path}"`);
  }

  // Only what the manifest names goes into the release.
  rmSync(releaseDir, { recursive: true, force: true });
  for (const path of files) {
    mkdirSync(dirname(join(stageDir, path)), { recursive: true });
    copyFileSync(join(here, path), join(stageDir, path));
  }
  const zipPath = join(releaseDir, ZIP_NAME);
  const topLevel = [...new Set(files.map((path) => path.split("/")[0]))];
  run("zip", ["-q", "-r", "-D", zipPath, ...topLevel], { cwd: stageDir }, "zip failed");

  const expected = [...files].sort();
  const actual = archiveEntries(zipPath);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`the archive holds [${actual.join(", ")}] but the manifest names [${expected.join(", ")}]`);
  }
  copyFileSync(join(here, "module.json"), join(releaseDir, "module.json"));
  rmSync(stageDir, { recursive: true, force: true });

  console.log(`package: release files for version ${manifest.version} (nothing was published)`);
  console.log(`  ${describeFile(join(releaseDir, "module.json"))}`);
  console.log(`  ${describeFile(zipPath)}`);
  console.log(`  the archive holds: ${actual.join(", ")}`);
}

try {
  main();
} catch (error) {
  if (!(error instanceof PackageError)) throw error;
  console.error(`package: ${error.message}`);
  process.exit(1);
}
