"use strict";

// Persisted Trellis project roots for the Dashboard's independent Trellis
// view: `~/.clawd/trellis-roots.json`, a minimal JSON array of absolute
// project-root path strings. Deliberately NOT prefs — this is a tiny
// standalone data file (same spot as roam-area.json), so the settings
// schema and its controller stay untouched.
//
// Writes happen only when the set actually changes (add/remove); each write
// is atomic on the same volume (tmp file + rename). A corrupt or
// non-array file is treated as "no roots" (warn once, keep the file) —
// manual fix or re-add is always possible through the view's picker.

const path = require("path");
const os = require("os");

const MAX_ROOTS = 64;

// Canonical form for persisted roots: normalized separators WITHOUT a
// trailing separator (path.normalize alone keeps one, so "/proj/a/" and
// "/proj/a" would coexist as duplicates).
function normalizeRootPath(p) {
  const normalized = path.normalize(p);
  if (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function defaultFilePath() {
  return path.join(os.homedir(), ".clawd", "trellis-roots.json");
}

function createTrellisRootsStore(options = {}) {
  const fs = options.fs || require("fs");
  const filePath = options.filePath || defaultFilePath();
  const warn = typeof options.warn === "function" ? options.warn : (() => {});
  let roots = [];

  // Normalize each entry (separator form only — no case folding) and drop
  // duplicates so the persisted set stays canonical and minimal.
  function sanitizeList(list) {
    const seen = new Set();
    const out = [];
    for (const entry of list) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      const normalized = normalizeRootPath(entry);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  function parseRaw(raw) {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(value)) return null;
    return sanitizeList(value);
  }

  // Atomic same-volume write: tmp file in the same directory, then rename.
  function persist() {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(roots, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, filePath);
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      roots = [];
      return roots;
    }
    const parsed = parseRaw(raw);
    if (parsed === null) {
      warn(`[trellis-roots] unreadable roots file ignored: ${filePath}`);
      roots = [];
      return roots;
    }
    roots = parsed;
    return roots.slice();
  }

  function list() {
    return roots.slice();
  }

  function add(root) {
    if (typeof root !== "string" || !root.trim()) return { status: "invalid" };
    const normalized = normalizeRootPath(root);
    if (roots.includes(normalized)) return { status: "duplicate", roots: roots.slice() };
    if (roots.length >= MAX_ROOTS) return { status: "limit", roots: roots.slice() };
    roots = [...roots, normalized];
    persist();
    return { status: "ok", roots: roots.slice() };
  }

  function remove(root) {
    if (typeof root !== "string" || !root.trim()) return { status: "invalid" };
    const normalized = normalizeRootPath(root);
    const index = roots.indexOf(normalized);
    if (index === -1) return { status: "not-found", roots: roots.slice() };
    roots = roots.filter((entry) => entry !== normalized);
    persist();
    return { status: "ok", roots: roots.slice() };
  }

  return { load, list, add, remove };
}

module.exports = { createTrellisRootsStore, normalizeRootPath, TRELLIS_ROOTS_MAX: MAX_ROOTS };
