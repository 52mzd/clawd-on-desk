"use strict";

// Read-only Trellis project scanner.
//
// Everything here is `fs` reads plus pure logic: no child processes, no writes,
// no network. That is what makes "no clicks ⇒ nothing on disk changes" true by
// construction, and it is also why installation state is decided from
// `.trellis/.version` rather than by probing `trellis update` — running that in
// a non-Trellis directory drops into the CLI's interactive init flow instead of
// failing, so it can never answer "is Trellis installed here?".

const fs = require("fs");
const path = require("path");

const { parsePlatforms, platformsOfUnion, staleIdsOf } = require("./trellis-platforms");

const TRELLIS_DIR = ".trellis";
const VERSION_FILE = ".version";
const HASHES_FILE = ".template-hashes.json";
const SCRIPTS_DIR = "scripts";
const SKIPPED_DIR_NAMES = new Set(["node_modules"]);

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// `<project>/.trellis/.version` contents, or null when unreadable/empty.
function readProjectVersion(projectPath) {
  if (typeof projectPath !== "string" || !projectPath) return null;
  try {
    const raw = fs.readFileSync(path.join(projectPath, TRELLIS_DIR, VERSION_FILE), "utf8");
    const text = String(raw).trim();
    return text || null;
  } catch {
    return null;
  }
}

// The `hashes` object from `<project>/.trellis/.template-hashes.json`, or null.
// A missing/corrupt file is a normal outcome, never an exception.
function readHashes(projectPath) {
  if (typeof projectPath !== "string" || !projectPath) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(projectPath, TRELLIS_DIR, HASHES_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const hashes = parsed.hashes;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) return null;
  return hashes;
}

function readPlatforms(projectPath) {
  // Union evidence (09-25): hashes alone is blind for CLI 0.7.0-beta.4+
  // (platforms no longer recorded there) — config dirs on disk are the
  // complementary proof. Stale semantics unchanged (staleIdsOf still
  // checks hashes-recorded ids against missing dirs).
  return platformsOfUnion(readHashes(projectPath) || {}, projectPath);
}

// Trellis counts as installed only when `.trellis/` is a real directory that
// carries either the version stamp or the managed scripts. A bare `.trellis/`
// (partial clone, leftover folder) stays "not installed" so the UI never
// offers an upgrade against it.
function readInstallState(projectPath) {
  const trellisDir = path.join(projectPath, TRELLIS_DIR);
  if (!isDirectory(trellisDir)) return { installed: false, current: null };
  const current = readProjectVersion(projectPath);
  const installed = current !== null || isDirectory(path.join(trellisDir, SCRIPTS_DIR));
  return { installed, current };
}

function buildProject(projectPath, name) {
  const { installed, current } = readInstallState(projectPath);
  const platforms = installed ? readPlatforms(projectPath) : [];
  // Only the platforms that are actually missing on disk. The boolean is kept
  // for callers that just need "is anything stale", while the id list is what
  // the UI renders so a partially-missing record is not reported as if every
  // platform were gone.
  const staleIds = installed ? staleIdsOf(projectPath, platforms) : [];
  return {
    path: projectPath,
    name,
    installed,
    current,
    platforms,
    staleIds,
    staleRecord: staleIds.length > 0,
  };
}

// Direct children of `root` only. Hidden directories, node_modules and symlinks
// are skipped — symlinks are dropped before the directory check so a link that
// escapes the selected root can never contribute a project.
function scanRoot(root) {
  const result = { root: typeof root === "string" ? root : "", readable: false, projects: [] };
  if (typeof root !== "string" || !root) return result;

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  result.readable = true;

  const projects = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIPPED_DIR_NAMES.has(entry.name)) continue;
    projects.push(buildProject(path.join(root, entry.name), entry.name));
  }
  projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  result.projects = projects;
  return result;
}

function scanRoots(roots) {
  if (!Array.isArray(roots)) return [];
  return roots
    .filter((root) => typeof root === "string" && root.trim())
    .map((root) => scanRoot(root));
}

module.exports = {
  readProjectVersion,
  readHashes,
  readPlatforms,
  readInstallState,
  scanRoot,
  scanRoots,
};
