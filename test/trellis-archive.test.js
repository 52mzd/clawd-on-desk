"use strict";

// Focused tests for the shared archive traversal (src/trellis-archive.js):
// the one implementation behind both the recap daily counts and the
// Dashboard's archived-task list. The recap-specific semantics (single
// month bound, mtime fallback projection) stay covered by
// test/recap-trellis.test.js — this file pins the traversal itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listArchivedTasks, MONTH_DIR_PATTERN } = require("../src/trellis-archive");

function makeArchive(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawd-trellis-archive-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "tasks", "archive");
}

function writeArchived(archiveBase, month, name, taskJson) {
  const dir = path.join(archiveBase, month, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), `${JSON.stringify(taskJson)}\n`, "utf8");
  return dir;
}

test("month mode reads exactly one folder and mirrors the recap bound", (t) => {
  const archive = makeArchive(t, "month-mode");
  writeArchived(archive, "2026-08", "old-task", {
    title: "Old", createdAt: "2026-08-01", completedAt: "2026-08-02",
  });
  writeArchived(archive, "2026-09", "new-task", {
    title: "New", createdAt: "2026-09-01", completedAt: "2026-09-20",
  });

  assert.deepEqual(
    listArchivedTasks(fs, archive, { month: "2026-09" }).map((e) => e.name),
    ["new-task"]
  );
  // A month folder that does not exist is an empty list, never an error.
  assert.deepEqual(listArchivedTasks(fs, archive, { month: "2027-01" }), []);
});

test("month-less mode reads every YYYY-MM folder in lexical order", (t) => {
  const archive = makeArchive(t, "all-months");
  writeArchived(archive, "2026-08", "a", { title: "A", createdAt: "2026-08-01", completedAt: "2026-08-02" });
  writeArchived(archive, "2026-10", "c", { title: "C", createdAt: "2026-10-01", completedAt: "2026-10-02" });
  writeArchived(archive, "2026-09", "b", { title: "B", createdAt: "2026-09-01", completedAt: "2026-09-02" });
  // Stray directories that are not YYYY-MM months are ignored.
  fs.mkdirSync(path.join(archive, "notes.d"), { recursive: true });
  fs.writeFileSync(path.join(archive, "notes.d", "task.json"), "{}", "utf8");

  const entries = listArchivedTasks(fs, archive);
  assert.deepEqual(entries.map((e) => [e.month, e.name]), [
    ["2026-08", "a"],
    ["2026-09", "b"],
    ["2026-10", "c"],
  ]);
  assert.equal(entries[0].dir, path.join(archive, "2026-08", "a"));
});

test("exposes sanitized title/dates and skips unreadable task.json", (t) => {
  const archive = makeArchive(t, "sanitize");
  writeArchived(archive, "2026-09", "full", {
    title: "  Full  ", parent: "  parent-name  ", createdAt: "2026-09-01", completedAt: "2026-09-20",
  });
  writeArchived(archive, "2026-09", "sparse", {});
  writeArchived(archive, "2026-09", "bad-dates", {
    title: "Bad", parent: 42, createdAt: 20260901, completedAt: 20260920,
  });
  const corrupt = path.join(archive, "2026-09", "corrupt");
  fs.mkdirSync(corrupt, { recursive: true });
  fs.writeFileSync(path.join(corrupt, "task.json"), "{ not json", "utf8");

  const byName = new Map(listArchivedTasks(fs, archive).map((e) => [e.name, e]));
  assert.ok(byName.has("full"));
  assert.equal(byName.get("full").title, "Full");
  assert.equal(byName.get("full").createdAt, "2026-09-01");
  assert.equal(byName.get("full").completedAt, "2026-09-20");
  assert.equal(byName.get("full").completedAtMs, Date.parse("2026-09-20"));
  assert.equal(byName.get("full").parent, "parent-name", "the task.json parent NAME is trimmed and passed through for the archive tree");

  assert.ok(!byName.has("corrupt"), "corrupt task.json entries are skipped");
  const sparse = byName.get("sparse");
  assert.equal(sparse.title, null);
  assert.equal(sparse.parent, null);
  assert.equal(sparse.createdAt, null);
  assert.equal(sparse.completedAt, null);

  const bad = byName.get("bad-dates");
  assert.equal(bad.parent, null, "a non-string parent normalizes to null");
  assert.equal(bad.createdAt, null);
  assert.equal(bad.completedAt, null);
  // Invalid stored dates still fall back to the directory mtime.
  assert.ok(Number.isFinite(bad.completedAtMs), "unusable completedAt falls back to mtime ms");
});

test("falls back to the directory mtime only when completedAt is unusable", (t) => {
  const archive = makeArchive(t, "mtime");
  const valid = writeArchived(archive, "2026-09", "valid", {
    createdAt: "2026-09-01", completedAt: "2026-09-20",
  });
  const missing = writeArchived(archive, "2026-09", "missing", {
    createdAt: "2026-09-01", completedAt: null,
  });
  fs.utimesSync(missing, new Date("2026-09-21T08:00:00Z"), new Date("2026-09-21T08:00:00Z"));

  const byName = new Map(listArchivedTasks(fs, archive).map((e) => [e.name, e]));
  assert.equal(byName.get("valid").completedAtMs, Date.parse("2026-09-20"));
  assert.equal(byName.get("missing").completedAtMs, Date.parse("2026-09-21T08:00:00Z"));
  // A valid completedAt must not be overridden by the stat fallback.
  fs.utimesSync(valid, new Date("2026-09-25T08:00:00Z"), new Date("2026-09-25T08:00:00Z"));
  const reread = new Map(listArchivedTasks(fs, archive).map((e) => [e.name, e]));
  assert.equal(reread.get("valid").completedAtMs, Date.parse("2026-09-20"));
});

test("a missing archive base is an empty list", (t) => {
  const archive = makeArchive(t, "missing");
  assert.deepEqual(listArchivedTasks(fs, path.join(archive, "nope")), []);
});

test("an injected fs drives the traversal without touching the real disk", () => {
  const fakeFs = {
    readdirSync(dirPath, opts) {
      assert.equal(opts.withFileTypes, true);
      if (dirPath === "/p/tasks/archive") {
        return [{ name: "2026-09", isDirectory: () => true }];
      }
      if (dirPath === "/p/tasks/archive/2026-09") {
        return [{ name: "done", isDirectory: () => true }];
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readFileSync(filePath) {
      if (filePath === "/p/tasks/archive/2026-09/done/task.json") {
        return JSON.stringify({ title: "Done", createdAt: "2026-09-01", completedAt: "2026-09-20" });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    statSync() {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
  };
  const entries = listArchivedTasks(fakeFs, "/p/tasks/archive");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "done");
  assert.equal(entries[0].title, "Done");
  assert.equal(entries[0].completedAt, "2026-09-20");
});

test("MONTH_DIR_PATTERN accepts only YYYY-MM folder names", () => {
  assert.ok(MONTH_DIR_PATTERN.test("2026-09"));
  assert.ok(!MONTH_DIR_PATTERN.test("2026-9"));
  assert.ok(!MONTH_DIR_PATTERN.test("20269"));
  assert.ok(!MONTH_DIR_PATTERN.test("notes"));
  assert.ok(!MONTH_DIR_PATTERN.test(".DS_Store"));
});
