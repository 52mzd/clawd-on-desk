"use strict";

// Shared archive traversal for `.trellis/tasks/archive/`: one implementation
// behind both the recap daily counts (src/recap-trellis.js, which reads a
// single queried month) and the Dashboard's archived-task list
// (src/trellis-activity.js readArchiveList, which reads every month). Pure
// read-only helper with an injected synchronous fs (readdirSync with
// withFileTypes / readFileSync / statSync) — the same surface recap-trellis
// already injects, so both consumers stay testable off the real disk.
//
// Entry shape (frozen, IPC/JSON-safe):
//   { name, month, dir, title, parent, hasChildren, priority, createdAt,
//     completedAt, completedAtMs }
//     name/completedAt semantics mirror task.py: createdAt/completedAt are
//     YYYY-MM-DD local-date strings, and a missing/invalid completedAt falls
//     back to the task directory's mtime (exposed as completedAtMs only, so
//     each consumer projects it into its own time zone — recap freezes it,
//     the dashboard renders a local date). parent is the task.json `parent`
//     task NAME (string) or null — the dashboard's archive tree resolves it
//     by name across months; the recap scan ignores it. priority is the
//     normalized "p0"|"p1"|"p2" badge key (null when unset/invalid). A
//     task.json that cannot be read or parsed is skipped, exactly like the
//     recap scan always did.

const path = require("path");

const MONTH_DIR_PATTERN = /^\d{4}-\d{2}$/;
const PRIORITY_PATTERN = /^p?([0-2])$/;

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// task.py stores priority as "P0".."P2"; older hand-written task.json files
// may carry a bare digit. Anything else is unset — the renderer must not
// invent a badge for values it cannot rank.
function normalizePriority(value) {
  if (typeof value !== "string") return null;
  const match = PRIORITY_PATTERN.exec(value.trim().toLowerCase());
  return match ? `p${match[1]}` : null;
}

function listDirectories(fsApi, dirPath) {
  try {
    return fsApi.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
}

function readTaskJsonQuiet(fsApi, filePath) {
  try {
    const value = JSON.parse(fsApi.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// fsApi: synchronous fs surface (real fs or a fake). archiveBase is the
// tasks/archive directory itself. options.month ("YYYY-MM") restricts the
// scan to that one folder (recap semantics — no extra readdir of the
// archive root); without it every YYYY-MM folder is read.
function listArchivedTasks(fsApi, archiveBase, options) {
  const opts = options || {};
  let months;
  if (typeof opts.month === "string" && opts.month) {
    months = [opts.month];
  } else {
    const names = listDirectories(fsApi, archiveBase) || [];
    months = names.filter((name) => MONTH_DIR_PATTERN.test(name)).sort();
  }

  const entries = [];
  for (const month of months) {
    const names = listDirectories(fsApi, path.join(archiveBase, month));
    if (!names) continue;
    for (const name of names) {
      const dir = path.join(archiveBase, month, name);
      const taskJson = readTaskJsonQuiet(fsApi, path.join(dir, "task.json"));
      if (!taskJson) continue;

      const completedAt = isValidDateString(taskJson.completedAt) ? taskJson.completedAt : null;
      let completedAtMs = completedAt !== null ? Date.parse(completedAt) : null;
      if (completedAtMs !== null && !Number.isFinite(completedAtMs)) completedAtMs = null;
      if (completedAtMs === null) {
        // Same fallback order as the recap scan: only stat when the stored
        // completedAt is unusable, so valid task.py archival never pays for
        // the extra stat and a stat failure simply leaves the ms null.
        try {
          const stat = fsApi.statSync(dir);
          if (stat && Number.isFinite(stat.mtimeMs)) completedAtMs = stat.mtimeMs;
        } catch {}
      }

      const title = typeof taskJson.title === "string" && taskJson.title.trim()
        ? taskJson.title.trim()
        : null;
      const parent = typeof taskJson.parent === "string" && taskJson.parent.trim()
        ? taskJson.parent.trim()
        : null;
      const hasChildren = Array.isArray(taskJson.children) && taskJson.children.length > 0;
      entries.push(Object.freeze({
        name,
        month,
        dir,
        title,
        parent,
        hasChildren,
        priority: normalizePriority(taskJson.priority),
        createdAt: isValidDateString(taskJson.createdAt) ? taskJson.createdAt : null,
        completedAt,
        completedAtMs,
      }));
    }
  }
  return entries;
}

module.exports = { listArchivedTasks, listDirectories, MONTH_DIR_PATTERN, normalizePriority };
