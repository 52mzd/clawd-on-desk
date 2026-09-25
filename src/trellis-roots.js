"use strict";

// Persisted Trellis project roots for the Dashboard's independent Trellis
// view: `~/.clawd/trellis-roots.json`. Two shapes are understood:
//   legacy — a plain JSON array of project-root path strings
//   v1     — { version: 1, roots: [...], picks: [{ picked, roots: [...] }] }
// `picks` is the user-pick bookkeeping (one row per folder the user chose
// in the picker; removing a pick unregisters every root it produced), so
// it MUST survive restarts — keeping it process-local regressed the UI to
// per-root removal after every relaunch. Deliberately NOT prefs — this is
// a tiny standalone data file (same spot as roam-area.json), so the
// settings schema and its controller stay untouched.
//
// A corrupt / non-array / non-object file is treated as "no roots" (warn
// once, keep the file) — manual fix or re-add is always possible through
// the view's picker.

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
  let picks = []; // [{ picked, roots: [...] }] — normalized, load-pruned

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
    // Legacy shape: plain string array (pre-picks versions) — no picks
    // recorded, inference below covers every root.
    if (Array.isArray(value)) return finalizePicks(sanitizeList(value), []);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.version !== 1 || !Array.isArray(value.roots)) return null;
    const rootList = sanitizeList(value.roots);
    const rawPicks = Array.isArray(value.picks) ? value.picks : [];
    const pickList = [];
    for (const entry of rawPicks) {
      if (entry === null || typeof entry !== "object") continue;
      if (typeof entry.picked !== "string" || !entry.picked.trim()) continue;
      // Keep only roots that are still registered — stale bookkeeping from
      // hand-edited files must not resurrect removed roots.
      const kept = sanitizeList(Array.isArray(entry.roots) ? entry.roots : []).filter(
        (r) => rootList.includes(r),
      );
      if (kept.length === 0) continue;
      pickList.push({ picked: normalizeRootPath(entry.picked), roots: kept });
    }
    return finalizePicks(rootList, pickList);
  }

  // Legacy / hand-edited files carry no pick bookkeeping for some roots.
  // Infer one pick per distinct parent directory of the uncovered roots,
  // so batch-registered child projects (the picker's multi-root flow)
  // still collapse into a single removable row after the upgrade.
  function finalizePicks(rootList, pickList) {
    const covered = new Set(pickList.flatMap((p) => p.roots));
    for (const root of rootList) {
      if (covered.has(root)) continue;
      const parent = normalizeRootPath(path.dirname(root));
      const existing = pickList.find((p) => p.picked === parent);
      if (existing) existing.roots.push(root);
      else pickList.push({ picked: parent, roots: [root] });
    }
    return { roots: rootList, picks: pickList };
  }

  // Atomic same-volume write: tmp file in the same directory, then rename.
  function persist() {
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ version: 1, roots, picks }, null, 2)}\n`,
      "utf8",
    );
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
      picks = [];
      return roots;
    }
    roots = parsed.roots;
    picks = parsed.picks;
    return roots.slice();
  }

  function list() {
    return roots.slice();
  }

  function listPicks() {
    return picks.map((p) => ({ picked: p.picked, roots: p.roots.slice() }));
  }

  // Record (or merge into) the bookkeeping pick for one user-picked
  // folder. Re-picking the same folder accumulates its roots idempotently.
  function recordPick(picked, registeredRoots) {
    if (typeof picked !== "string" || !picked.trim()) return { status: "invalid" };
    if (!Array.isArray(registeredRoots) || registeredRoots.length === 0) {
      return { status: "invalid" };
    }
    const key = normalizeRootPath(picked);
    const kept = sanitizeList(registeredRoots).filter((r) => roots.includes(r));
    if (kept.length === 0) return { status: "invalid" };
    const existing = picks.find((p) => p.picked === key);
    if (existing) {
      const merged = sanitizeList([...existing.roots, ...kept]);
      picks = picks.map((p) => (p.picked === key ? { picked: key, roots: merged } : p));
    } else {
      picks = [...picks, { picked: key, roots: kept }];
    }
    persist();
    return { status: "ok" };
  }

  // Remove one pick and every still-registered root it produced.
  function removePick(picked) {
    if (typeof picked !== "string" || !picked.trim()) return { status: "invalid" };
    const key = normalizeRootPath(picked);
    const entry = picks.find((p) => p.picked === key);
    if (!entry) return { status: "not-found", roots: roots.slice() };
    picks = picks.filter((p) => p.picked !== key);
    const removed = entry.roots.filter((r) => roots.includes(r));
    if (removed.length > 0) roots = roots.filter((r) => !removed.includes(r));
    if (roots.length === 0 && picks.length === 0) {
      // nothing left — fall through, persist writes the empty-but-valid v1 shape
    }
    persist();
    return { status: "ok", roots: roots.slice(), removed };
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
    // Keep pick bookkeeping consistent: drop the root from every pick that
    // references it; picks whose roots are exhausted stop tracking anything
    // and are dropped with it.
    picks = picks
      .map((p) => ({ picked: p.picked, roots: p.roots.filter((r) => r !== normalized) }))
      .filter((p) => p.roots.length > 0);
    persist();
    return { status: "ok", roots: roots.slice() };
  }

  return { load, list, listPicks, recordPick, removePick, add, remove };
}

module.exports = { createTrellisRootsStore, normalizeRootPath, TRELLIS_ROOTS_MAX: MAX_ROOTS };
