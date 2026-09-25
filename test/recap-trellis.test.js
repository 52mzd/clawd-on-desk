"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { computeTrellisDailyCounts } = require("../src/recap-trellis");

const TODAY = "2026-09-20";
const MONTH = "2026-09";

function makeProject(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawd-recap-trellis-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTask(tasksRoot, relativeDir, taskJson) {
  const taskDir = path.join(tasksRoot, relativeDir);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify(taskJson)}\n`, "utf8");
  return taskDir;
}

function taskJson(overrides = {}) {
  return {
    title: "untitled",
    status: "in_progress",
    createdAt: "2026-09-01",
    completedAt: null,
    ...overrides,
  };
}

test("counts tasks created today across active and current-month archive", (t) => {
  const root = makeProject(t, "created");
  const tasks = path.join(root, "tasks");
  writeTask(tasks, "old-active", taskJson({ createdAt: "2026-09-19" }));
  writeTask(tasks, "new-active", taskJson({ createdAt: TODAY }));
  writeTask(path.join(tasks, "archive", MONTH), "new-archived", taskJson({
    status: "completed",
    createdAt: TODAY,
    completedAt: TODAY,
  }));
  writeTask(path.join(tasks, "archive", MONTH), "old-archived", taskJson({
    status: "completed",
    createdAt: "2026-09-01",
    completedAt: "2026-09-02",
  }));

  const result = computeTrellisDailyCounts({ roots: [root], localDate: TODAY, timeZoneId: "UTC" });
  assert.deepEqual(result, { projects: 1, tasksCreated: 2, tasksCompleted: 1 });
});

test("completed counts only archived tasks whose completedAt is the queried date", (t) => {
  const root = makeProject(t, "completed");
  const tasks = path.join(root, "tasks");
  writeTask(path.join(tasks, "archive", MONTH), "done-today", taskJson({
    status: "completed",
    createdAt: "2026-09-18",
    completedAt: TODAY,
  }));
  writeTask(path.join(tasks, "archive", MONTH), "done-yesterday", taskJson({
    status: "completed",
    createdAt: "2026-09-18",
    completedAt: "2026-09-19",
  }));
  // Completed but not archived: status alone is not a completion boundary.
  writeTask(tasks, "completed-active", taskJson({ status: "completed", createdAt: "2026-09-18" }));

  const result = computeTrellisDailyCounts({ roots: [root], localDate: TODAY, timeZoneId: "UTC" });
  assert.deepEqual(result, { projects: 1, tasksCreated: 0, tasksCompleted: 1 });
});

test("falls back to the task directory mtime when completedAt is missing", (t) => {
  const root = makeProject(t, "mtime-fallback");
  const tasks = path.join(root, "tasks");
  const noField = writeTask(path.join(tasks, "archive", MONTH), "no-completed-at", taskJson({
    status: "completed",
    createdAt: "2026-09-01",
    completedAt: null,
  }));
  const badField = writeTask(path.join(tasks, "archive", MONTH), "bad-completed-at", taskJson({
    status: "completed",
    createdAt: "2026-09-01",
    completedAt: 20260920,
  }));

  const mtimeToday = new Date(`${TODAY}T12:00:00Z`);
  fs.utimesSync(noField, mtimeToday, mtimeToday);
  const mtimeYesterday = new Date("2026-09-19T12:00:00Z");
  fs.utimesSync(badField, mtimeYesterday, mtimeYesterday);

  const result = computeTrellisDailyCounts({ roots: [root], localDate: TODAY, timeZoneId: "UTC" });
  assert.deepEqual(result, { projects: 1, tasksCreated: 0, tasksCompleted: 1 });
});

test("projects the mtime fallback into the queried time zone", (t) => {
  const root = makeProject(t, "mtime-zone");
  const tasks = path.join(root, "tasks");
  const taskDir = writeTask(path.join(tasks, "archive", MONTH), "zone-edge", taskJson({
    status: "completed",
    createdAt: "2026-09-01",
    completedAt: null,
  }));
  // 2026-09-20T18:00Z is already 2026-09-21 in Asia/Tokyo.
  const mtime = new Date(`${TODAY}T18:00:00Z`);
  fs.utimesSync(taskDir, mtime, mtime);

  const tokyo = computeTrellisDailyCounts({ roots: [root], localDate: TODAY, timeZoneId: "Asia/Tokyo" });
  assert.equal(tokyo.tasksCompleted, 0, "Tokyo date is already the next day");
  const utc = computeTrellisDailyCounts({ roots: [root], localDate: TODAY, timeZoneId: "UTC" });
  assert.equal(utc.tasksCompleted, 1, "UTC date is still the queried day");
});

test("scans only the queried month's archive folder", (t) => {
  const root = makeProject(t, "archive-bound");
  const tasks = path.join(root, "tasks");
  // A non-standard fixture: last month's folder holding a task whose date
  // fields claim today. The scan bound must keep it out of both counts.
  writeTask(path.join(tasks, "archive", "2026-08"), "misplaced", taskJson({
    status: "completed",
    createdAt: TODAY,
    completedAt: TODAY,
  }));

  const result = computeTrellisDailyCounts({ roots: [root], localDate: TODAY, timeZoneId: "UTC" });
  assert.deepEqual(result, { projects: 1, tasksCreated: 0, tasksCompleted: 0 });
});

test("returns null without roots, for an invalid date, or with no readable root", (t) => {
  assert.equal(computeTrellisDailyCounts({ roots: [], localDate: TODAY, timeZoneId: "UTC" }), null);
  assert.equal(computeTrellisDailyCounts({ roots: ["/tmp"], localDate: "2026-9-20", timeZoneId: "UTC" }), null);
  assert.equal(computeTrellisDailyCounts({ roots: ["/definitely/not/a/trellis/root"], localDate: TODAY, timeZoneId: "UTC" }), null);
  assert.equal(computeTrellisDailyCounts(null), null);
});

test("deduplicates roots and sums across projects", (t) => {
  const rootA = makeProject(t, "multi-a");
  const rootB = makeProject(t, "multi-b");
  const tasksA = path.join(rootA, "tasks");
  const tasksB = path.join(rootB, "tasks");
  writeTask(tasksA, "a-new", taskJson({ createdAt: TODAY }));
  writeTask(path.join(tasksA, "archive", MONTH), "a-done", taskJson({
    status: "completed",
    createdAt: "2026-09-01",
    completedAt: TODAY,
  }));
  writeTask(tasksB, "b-new", taskJson({ createdAt: TODAY }));

  const result = computeTrellisDailyCounts({
    roots: [rootA, rootA, path.join(rootA, "nested"), rootB],
    localDate: TODAY,
    timeZoneId: "UTC",
  });
  assert.deepEqual(result, { projects: 2, tasksCreated: 2, tasksCompleted: 1 });
});

test("skips malformed task.json and non-date createdAt values", (t) => {
  const root = makeProject(t, "malformed");
  const tasks = path.join(root, "tasks");
  writeTask(tasks, "broken", {});
  fs.writeFileSync(path.join(tasks, "broken", "task.json"), "{ not json", "utf8");
  writeTask(tasks, "array-root", []);
  fs.mkdirSync(path.join(tasks, "empty-dir"), { recursive: true });
  writeTask(tasks, "numeric-date", taskJson({ createdAt: 20260920 }));
  writeTask(tasks, "valid", taskJson({ createdAt: TODAY }));

  const result = computeTrellisDailyCounts({ roots: [root], localDate: TODAY, timeZoneId: "UTC" });
  assert.deepEqual(result, { projects: 1, tasksCreated: 1, tasksCompleted: 0 });
});

test("ignores the archive folder and stray files in the active tasks scan", (t) => {
  const root = makeProject(t, "active-scan");
  const tasks = path.join(root, "tasks");
  fs.mkdirSync(path.join(tasks, "archive", MONTH), { recursive: true });
  fs.writeFileSync(path.join(tasks, "stray.json"), "{}", "utf8");

  const result = computeTrellisDailyCounts({ roots: [root], localDate: TODAY, timeZoneId: "UTC" });
  assert.deepEqual(result, { projects: 1, tasksCreated: 0, tasksCompleted: 0 });
});

test("an injected fs drives the scan without touching the real disk", () => {
  const files = new Map();
  const fakeFs = {
    readdirSync(dirPath) {
      if (dirPath === "/proj/.trellis/tasks") {
        return [
          { name: "new", isDirectory: () => true },
          { name: "archive", isDirectory: () => true },
          { name: "notes.md", isDirectory: () => false },
        ];
      }
      if (dirPath === "/proj/.trellis/tasks/archive/2026-09") {
        return [{ name: "done", isDirectory: () => true }];
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readFileSync(filePath) {
      if (!files.has(filePath)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(filePath);
    },
    statSync() {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
  };
  files.set("/proj/.trellis/tasks/new/task.json", JSON.stringify({ createdAt: TODAY }));
  files.set("/proj/.trellis/tasks/archive/2026-09/done/task.json", JSON.stringify({
    createdAt: "2026-09-01",
    completedAt: null,
  }));

  const result = computeTrellisDailyCounts({
    roots: ["/proj/.trellis"],
    localDate: TODAY,
    timeZoneId: "UTC",
    fs: fakeFs,
  });
  assert.deepEqual(result, { projects: 1, tasksCreated: 1, tasksCompleted: 0 });
});
