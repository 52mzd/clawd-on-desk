"use strict";

// Trellis daily counts for the recap (Footprints) page. This module is a
// stateless read-only projector: it enumerates task.json files under the
// .trellis roots Clawd has observed this process and counts lifecycle
// boundaries on one civil date. Nothing is persisted and nothing but the
// two counts and a project count is returned, so the recap-v1 storage
// schema and its privacy invariants stay untouched.
//
// Metric definitions (companion doc: docs/guides/recap.md):
//   tasksCreated   — tasks whose task.json "createdAt" (a YYYY-MM-DD string
//                    written by task.py with the creating machine's local
//                    date) equals the queried local date, across both the
//                    active tasks/ tree and the current month's archive.
//   tasksCompleted — archived tasks whose task.json "completedAt" equals the
//                    queried local date. When completedAt is missing or not
//                    a date string (non task.py archival), the fallback is
//                    the task directory's mtime projected into the queried
//                    time zone; that fallback only applies inside standard
//                    month folders.
//
// Archive scan bound: task.py writes completedAt and moves the directory in
// one commit, so both carry the same civil date. A task completed on the
// queried date therefore always lives in the queried month's archive
// folder, and a task created on the queried date that is already archived
// satisfies created == completed == queried date. Only the queried month's
// archive/<month>/ is scanned; other months cannot contribute to either
// count.

const fs = require("fs");
const path = require("path");
const { freezeLocalTime } = require("./recap-time");
const { listArchivedTasks, listDirectories } = require("./trellis-archive");

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function readTaskJsonQuiet(fsApi, filePath) {
  try {
    const value = JSON.parse(fsApi.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// roots: absolute .trellis roots observed this process (from
// trellis-activity's root cache). Returns a frozen
// { projects, tasksCreated, tasksCompleted } snapshot, or null when there
// is no readable root (the recap page hides the section for null).
function computeTrellisDailyCounts(options) {
  const opts = options || {};
  const fsApi = opts.fs || fs;
  const localDate = opts.localDate;
  if (!isValidDateString(localDate)) return null;
  const roots = [...new Set(
    (Array.isArray(opts.roots) ? opts.roots : [])
      .filter((root) => typeof root === "string" && root.trim())
      .map((root) => path.resolve(root))
  )];
  if (roots.length === 0) return null;

  const month = localDate.slice(0, 7);
  let projects = 0;
  let tasksCreated = 0;
  let tasksCompleted = 0;
  for (const root of roots) {
    const tasksDir = path.join(root, "tasks");
    const active = listDirectories(fsApi, tasksDir);
    if (!active) continue;
    projects += 1;
    for (const name of active) {
      if (name === "archive") continue;
      const taskJson = readTaskJsonQuiet(fsApi, path.join(tasksDir, name, "task.json"));
      if (taskJson && taskJson.createdAt === localDate) tasksCreated += 1;
    }
    // Archive scan shared with the Dashboard's archived-task list
    // (src/trellis-archive.js): one traversal, recap keeps its single-month
    // bound and its mtime-fallback projection into the queried time zone.
    for (const entry of listArchivedTasks(fsApi, path.join(tasksDir, "archive"), { month })) {
      if (entry.createdAt === localDate) tasksCreated += 1;
      if (entry.completedAt !== null) {
        if (entry.completedAt === localDate) tasksCompleted += 1;
        continue;
      }
      if (
        entry.completedAtMs !== null
        && freezeLocalTime(entry.completedAtMs, opts.timeZoneId).localDate === localDate
      ) tasksCompleted += 1;
    }
  }
  if (projects === 0) return null;
  return Object.freeze({ projects, tasksCreated, tasksCompleted });
}

module.exports = { computeTrellisDailyCounts };
