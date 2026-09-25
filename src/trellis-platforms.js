"use strict";

// Trellis platform registry mirror.
//
// A project's configured Trellis platforms are recorded by the CLI itself in
// `<project>/.trellis/.template-hashes.json`, under `hashes`. Every key is a
// repo-relative path, so the first segment names the platform's config
// directory. This module turns that prefix set into platform ids.
//
// Why not shell out to `trellis platforms`: it spawns a process, and scanning
// must stay read-only with zero child processes (the whole scan path is also
// reused by the pure-computation preview). The CLI prints the same data from
// the same file, so there is no extra information to gain.
//
// The table is a copy of the CLI's `AI_TOOLS[].configDir`, reduced to its first
// path segment — several tools use multi-level dirs (`.kiro/skills`,
// `.github/copilot`, `.agent/workflows`, `.devin/workflows`, `.snow/skills`)
// but `hashes` keys only ever expose the first segment. Keeping all 21 entries
// (and asserting them one by one in the test) means a CLI rename fails loudly
// instead of silently mis-reporting.

const path = require("path");
const fs = require("fs");

// Prefixes that are part of every Trellis project and never name a platform.
const IGNORED_PREFIXES = Object.freeze([".trellis", "AGENTS.md", ".agents"]);
const IGNORED_PREFIX_SET = new Set(IGNORED_PREFIXES);

// Display order is this array's order; `parsePlatforms` sorts against it so the
// UI list is stable across runs and machines.
const PLATFORMS = Object.freeze([
  { dirPrefix: ".agent", id: "antigravity", cliFlag: "--antigravity", label: "Antigravity" },
  { dirPrefix: ".claude", id: "claude-code", cliFlag: "--claude", label: "Claude Code" },
  { dirPrefix: ".codebuddy", id: "codebuddy", cliFlag: "--codebuddy", label: "CodeBuddy" },
  { dirPrefix: ".codex", id: "codex", cliFlag: "--codex", label: "Codex" },
  { dirPrefix: ".cursor", id: "cursor", cliFlag: "--cursor", label: "Cursor" },
  { dirPrefix: ".devin", id: "devin", cliFlag: "--devin", label: "Devin" },
  { dirPrefix: ".factory", id: "droid", cliFlag: "--droid", label: "Factory Droid" },
  { dirPrefix: ".gemini", id: "gemini", cliFlag: "--gemini", label: "Gemini CLI" },
  { dirPrefix: ".github", id: "copilot", cliFlag: "--copilot", label: "GitHub Copilot" },
  { dirPrefix: ".grok", id: "grok", cliFlag: "--grok", label: "Grok Build" },
  { dirPrefix: ".kilocode", id: "kilo", cliFlag: "--kilo", label: "Kilo CLI" },
  { dirPrefix: ".kimi-code", id: "kimi", cliFlag: "--kimi", label: "Kimi Code" },
  { dirPrefix: ".kiro", id: "kiro", cliFlag: "--kiro", label: "Kiro Code" },
  { dirPrefix: ".omp", id: "omp", cliFlag: "--omp", label: "Oh My Pi" },
  { dirPrefix: ".opencode", id: "opencode", cliFlag: "--opencode", label: "OpenCode" },
  { dirPrefix: ".pi", id: "pi", cliFlag: "--pi", label: "Pi Agent" },
  { dirPrefix: ".qoder", id: "qoder", cliFlag: "--qoder", label: "Qoder" },
  { dirPrefix: ".reasonix", id: "reasonix", cliFlag: "--reasonix", label: "Reasonix" },
  { dirPrefix: ".snow", id: "snow", cliFlag: "--snow", label: "Snow CLI" },
  { dirPrefix: ".trae", id: "trae", cliFlag: "--trae", label: "Trae" },
  { dirPrefix: ".zcode", id: "zcode", cliFlag: "--zcode", label: "ZCode" },
]);

const BY_PREFIX = new Map(PLATFORMS.map((entry) => [entry.dirPrefix, entry]));
const BY_ID = new Map(PLATFORMS.map((entry) => [entry.id, entry]));
const ORDER = new Map(PLATFORMS.map((entry, index) => [entry.id, index]));

const UNKNOWN_PREFIX = "unknown:";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// A `hashes` key like ".github/copilot/agents/x.md" contributes ".github".
// A key with no separator (e.g. "AGENTS.md") is its own prefix.
function prefixOfKey(key) {
  if (typeof key !== "string" || !key) return null;
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(0, slash);
}

// hashes -> sorted platform ids. Unknown prefixes are preserved verbatim as
// `unknown:<prefix>` so a platform Trellis adds later shows up in the UI
// instead of vanishing.
function parsePlatforms(hashes) {
  if (!isPlainObject(hashes)) return [];
  const known = new Set();
  const unknown = new Set();
  for (const key of Object.keys(hashes)) {
    const prefix = prefixOfKey(key);
    if (!prefix || IGNORED_PREFIX_SET.has(prefix)) continue;
    const entry = BY_PREFIX.get(prefix);
    if (entry) known.add(entry.id);
    else unknown.add(prefix);
  }
  const ordered = Array.from(known).sort((a, b) => ORDER.get(a) - ORDER.get(b));
  const extras = Array.from(unknown).sort().map((prefix) => `${UNKNOWN_PREFIX}${prefix}`);
  return ordered.concat(extras);
}

function isKnownPlatformId(id) {
  return typeof id === "string" && BY_ID.has(id);
}

// ids -> CLI flags, or null when the caller must fail closed. Renderer input is
// never concatenated into argv: anything not in the table (including an
// `unknown:` id, a flag-shaped string, or a non-string) rejects the whole call.
function flagsFor(ids) {
  if (!Array.isArray(ids)) return null;
  const flags = [];
  const seen = new Set();
  for (const id of ids) {
    const entry = typeof id === "string" ? BY_ID.get(id) : null;
    if (!entry) return null;
    if (seen.has(entry.cliFlag)) continue;
    seen.add(entry.cliFlag);
    flags.push(entry.cliFlag);
  }
  return flags;
}

function platformById(id) {
  return typeof id === "string" ? BY_ID.get(id) || null : null;
}

function platformLabel(id) {
  const entry = platformById(id);
  if (entry) return entry.label;
  if (typeof id === "string" && id.startsWith(UNKNOWN_PREFIX)) return id.slice(UNKNOWN_PREFIX.length);
  return typeof id === "string" ? id : "";
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// Platform ids whose recorded config directory is missing on disk. Unknown ids
// cannot be checked and are skipped. Read-only; never writes the record file.
// Platform ids evidenced by CONFIG DIRECTORIES on disk (09-25): CLI
// 0.7.0-beta.4 stopped recording platform files in .template-hashes.json,
// so parsePlatforms(hashes) alone reports ZERO platforms for beta.4
// projects. The directory set is the complementary evidence — the caller
// unions both (hashes-recorded ∨ dir-present = installed), while stale
// stays hashes-recorded ∧ dir-missing (staleIdsOf).
function platformsFromDirs(projectPath) {
  if (typeof projectPath !== "string" || !projectPath) return [];
  const found = [];
  for (const entry of PLATFORMS) {
    if (isDirectory(path.join(projectPath, entry.dirPrefix))) found.push(entry.id);
  }
  return found.sort((a, b) => ORDER.get(a) - ORDER.get(b));
}

// Union of hashes-evidenced and dir-evidenced platform ids (catalog order,
// unknown-prefix pass-through last). This is the single read path the
// scanner uses; it must never be parsePlatforms alone (beta.4 blindness).
function platformsOfUnion(hashes, projectPath) {
  const fromHashes = parsePlatforms(hashes);
  const fromDirs = platformsFromDirs(projectPath);
  if (fromDirs.length === 0) return fromHashes;
  const seen = new Set();
  const ordered = [];
  for (const id of fromHashes.concat(fromDirs)) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  ordered.sort((a, b) => {
    const ai = ORDER.get(a);
    const bi = ORDER.get(b);
    if (ai === undefined && bi === undefined) return a < b ? -1 : a > b ? 1 : 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
  return ordered;
}

function staleIdsOf(projectPath, ids) {
  if (typeof projectPath !== "string" || !projectPath || !Array.isArray(ids)) return [];
  const stale = [];
  for (const id of ids) {
    const entry = platformById(id);
    if (!entry) continue;
    if (!isDirectory(path.join(projectPath, entry.dirPrefix))) stale.push(id);
  }
  return stale;
}

function staleOf(projectPath, ids) {
  return staleIdsOf(projectPath, ids).length > 0;
}

module.exports = {
  IGNORED_PREFIXES,
  PLATFORMS,
  UNKNOWN_PREFIX,
  parsePlatforms,
  platformsFromDirs,
  platformsOfUnion,
  flagsFor,
  isKnownPlatformId,
  platformById,
  platformLabel,
  staleIdsOf,
  staleOf,
};
