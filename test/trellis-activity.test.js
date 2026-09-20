"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const {
  createTrellisActivity,
  ACTIVE_POLL_MS,
  IDLE_POLL_MS,
} = require("../src/trellis-activity");
const {
  makeSessionKey,
  parseSessionKey,
} = require("../src/session-key");

const PROJECT = path.resolve("/proj");
const CWD = path.join(PROJECT, "app");

// ── fakes ──

function makeFakeTimers() {
  const timers = new Map(); // id → { fn, delay }
  let nextId = 1;
  const flushAsync = async () => {
    // Advance the microtask/macrotask chain until it settles (fake fs
    // promises resolve immediately, so a couple of setImmediate rounds are
    // enough; the cap only guards against a runaway chain).
    for (let i = 0; i < 25; i++) {
      const before = timers.size;
      await new Promise((resolve) => setImmediate(resolve));
      if (timers.size === before) break;
    }
  };
  return {
    setTimeoutFn: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { fn, delay: delay || 0 });
      return id;
    },
    clearTimeoutFn: (id) => {
      timers.delete(id);
    },
    pendingDelays: () => [...timers.values()].map((t) => t.delay),
    async runDue() {
      const due = [...timers.values()];
      timers.clear();
      for (const t of due) t.fn();
      await flushAsync();
    },
  };
}

// In-memory read-only filesystem: directories are implied by file paths.
// Every write method counts the attempt and throws, so the read-only red
// line is asserted by writeOps staying empty.
function makeFakeFs() {
  const files = new Map(); // resolved path → content
  const writeOps = [];
  const readOps = { readFile: 0, stat: 0, readdir: 0 };

  const key = (p) => path.resolve(p);
  function isDir(k) {
    if (k === path.parse(k).root) return true;
    for (const f of files.keys()) {
      let d = path.dirname(f);
      for (;;) {
        if (d === k) return true;
        const parent = path.dirname(d);
        if (parent === d) break;
        d = parent;
      }
    }
    return false;
  }
  function enoent() {
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    return err;
  }

  const fsApi = {
    async readFile(p) {
      readOps.readFile += 1;
      const k = key(p);
      if (!files.has(k)) throw enoent();
      return files.get(k);
    },
    async stat(p) {
      readOps.stat += 1;
      const k = key(p);
      if (files.has(k)) return { isDirectory: () => false };
      if (isDir(k)) return { isDirectory: () => true };
      throw enoent();
    },
    async readdir(p) {
      readOps.readdir += 1;
      const k = key(p);
      if (!isDir(k)) throw enoent();
      const names = new Set();
      for (const f of files.keys()) {
        const d = path.dirname(f);
        if (d === k) {
          names.add(path.basename(f));
          continue;
        }
        let cur = d;
        for (;;) {
          const parent = path.dirname(cur);
          if (parent === k) {
            names.add(path.basename(cur));
            break;
          }
          if (parent === cur) break;
          cur = parent;
        }
      }
      return [...names];
    },
    // Read-only red line: any write attempt is recorded and fails loudly.
    writeFile(p) { writeOps.push(["writeFile", p]); throw new Error("read-only fs"); },
    writeFileSync(p) { writeOps.push(["writeFileSync", p]); throw new Error("read-only fs"); },
    mkdir(p) { writeOps.push(["mkdir", p]); throw new Error("read-only fs"); },
    mkdirSync(p) { writeOps.push(["mkdirSync", p]); throw new Error("read-only fs"); },
    rm(p) { writeOps.push(["rm", p]); throw new Error("read-only fs"); },
    unlink(p) { writeOps.push(["unlink", p]); throw new Error("read-only fs"); },
    rename(a, b) { writeOps.push(["rename", a, b]); throw new Error("read-only fs"); },
    appendFile(p) { writeOps.push(["appendFile", p]); throw new Error("read-only fs"); },
  };

  return {
    fsApi,
    files,
    writeOps,
    readOps,
    add(p, content) {
      files.set(key(p), content);
      return p;
    },
    remove(p) {
      files.delete(key(p));
    },
  };
}

function isoAgo(clockNow, msAgo) {
  return new Date(clockNow - msAgo).toISOString();
}

function makeHarness({ sessions = new Map(), getLiveSessions = null } = {}) {
  const fakeFs = makeFakeFs();
  const timers = makeFakeTimers();
  const clock = { now: 1758000000000 };
  const updates = [];
  const celebrations = [];
  const aggregates = [];
  const activity = createTrellisActivity({
    state: { sessions },
    ...(getLiveSessions ? { getLiveSessions } : {}),
    fs: fakeFs.fsApi,
    now: () => clock.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onTrellisUpdate: (ids) => updates.push(ids),
    onCelebration: (taskPath) => celebrations.push(taskPath),
    onAggregateChange: (aggregate) => aggregates.push(aggregate),
  });
  return { fakeFs, timers, clock, updates, celebrations, aggregates, activity, sessions };
}

function addTask(fake, taskName, taskJson, { prd = false, implementMd = null, root = PROJECT } = {}) {
  const dir = path.join(root, ".trellis", "tasks", taskName);
  fake.add(path.join(dir, "task.json"), JSON.stringify(taskJson));
  if (prd) fake.add(path.join(dir, "prd.md"), "# prd\n");
  if (implementMd) fake.add(path.join(dir, "implement.md"), implementMd);
  return dir;
}

function addPointer(fake, filename, payload, { root = PROJECT } = {}) {
  return fake.add(
    path.join(root, ".trellis", ".runtime", "sessions", filename),
    JSON.stringify(payload)
  );
}

function pointerPayload({ platform, currentTask, seenAgoMs = 5 * 60 * 1000, clockNow }) {
  return {
    platform,
    last_seen_at: isoAgo(clockNow, seenAgoMs),
    current_task: currentTask,
    current_run: null,
  };
}

const IN_PROGRESS_TASK = { title: "Trellis 流程感知", status: "in_progress", subtasks: [] };

// ── pointer binding (design D1) ──

describe("trellis-activity pointer binding", () => {
  it("binds a pi session through its namespaced id (prefix stripped)", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:01a0b040-370d-70b0-8e1a-9c8626dfd17e", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "09-19-x", IN_PROGRESS_TASK, { prd: true });
    addPointer(
      h.fakeFs,
      "pi_01a0b040-370d-70b0-8e1a-9c8626dfd17e.json",
      pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/09-19-x", clockNow: h.clock.now })
    );

    h.activity.start();
    await h.timers.runDue();

    assert.deepStrictEqual(h.activity.getTrellisInfo("pi:01a0b040-370d-70b0-8e1a-9c8626dfd17e"), {
      taskPath: ".trellis/tasks/09-19-x",
      title: "Trellis 流程感知",
      phase: "execute",
      progress: null,
      parallelCount: 1,
    });
    assert.deepStrictEqual(h.updates, [["pi:01a0b040-370d-70b0-8e1a-9c8626dfd17e"]]);
  });

  it("binds a snapshot-scoped session id via getLiveSessions + rawSessionId", async () => {
    // main.js feeds snapshot entries whose id is a scoped key ("s1.<b64>.<b64>");
    // the trellis pointer file on disk is named after the raw id instead.
    const scopedId = makeSessionKey({
      profileId: "profile_a",
      rawSessionId: "pi:01a0b040-370d-70b0-8e1a-9c8626dfd17e",
    });
    const parsed = parseSessionKey(scopedId);
    assert.equal(parsed.rawSessionId, "pi:01a0b040-370d-70b0-8e1a-9c8626dfd17e");
    const h = makeHarness({
      getLiveSessions: () => [
        { id: scopedId, rawSessionId: parsed.rawSessionId, agentId: "pi", cwd: CWD, headless: false },
      ],
    });
    addTask(h.fakeFs, "09-19-x", IN_PROGRESS_TASK, { prd: true });
    addPointer(
      h.fakeFs,
      "pi_01a0b040-370d-70b0-8e1a-9c8626dfd17e.json",
      pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/09-19-x", clockNow: h.clock.now })
    );

    h.activity.start();
    await h.timers.runDue();

    assert.equal(h.activity.getTrellisInfo(scopedId).phase, "execute");
    assert.deepStrictEqual(h.updates, [[scopedId]]);
  });

  it("binds a claude session whose id carries no namespace prefix", async () => {
    const h = makeHarness({
      sessions: new Map([["6218983c-1109-4a8d-8fde-a9b121655801", { agentId: "claude-code", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "09-18-y", { title: "Y", status: "planning", subtasks: [] });
    addPointer(
      h.fakeFs,
      "claude_6218983c-1109-4a8d-8fde-a9b121655801.json",
      pointerPayload({
        platform: "claude",
        currentTask: ".trellis/tasks/09-18-y",
        clockNow: h.clock.now,
      })
    );

    h.activity.start();
    await h.timers.runDue();

    const info = h.activity.getTrellisInfo("6218983c-1109-4a8d-8fde-a9b121655801");
    assert.strictEqual(info.phase, "plan");
    assert.strictEqual(info.taskPath, ".trellis/tasks/09-18-y");
  });

  it("counts subtask progress and parallel in_progress tasks", async () => {
    const h = makeHarness({
      sessions: new Map([["codex:3f2504e0-4f89-41d3-9a0c-0305e82c3301", { agentId: "codex", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", {
      title: "A",
      status: "in_progress",
      subtasks: [{ name: "s1", status: "completed" }, { name: "s2", status: "pending" }],
    });
    addTask(h.fakeFs, "task-b", { title: "B", status: "in_progress", subtasks: [] });
    addTask(h.fakeFs, "task-c", { title: "C", status: "completed", subtasks: [] });
    addPointer(
      h.fakeFs,
      "codex_3f2504e0-4f89-41d3-9a0c-0305e82c3301.json",
      pointerPayload({
        platform: "codex",
        currentTask: ".trellis/tasks/task-a",
        clockNow: h.clock.now,
      })
    );

    h.activity.start();
    await h.timers.runDue();

    const info = h.activity.getTrellisInfo("codex:3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    assert.deepStrictEqual(info.progress, { done: 1, total: 2 });
    // task-a + task-b are in_progress; task-c is completed.
    assert.strictEqual(info.parallelCount, 2);
  });

  it("dedupes the task.json read across sessions on the same task", async () => {
    const h = makeHarness({
      sessions: new Map([
        ["codex:aaa", { agentId: "codex", cwd: CWD }],
        ["codex:bbb", { agentId: "codex", cwd: CWD }],
      ]),
    });
    addTask(h.fakeFs, "shared", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "codex_aaa.json", pointerPayload({ platform: "codex", currentTask: ".trellis/tasks/shared", clockNow: h.clock.now }));
    addPointer(h.fakeFs, "codex_bbb.json", pointerPayload({ platform: "codex", currentTask: ".trellis/tasks/shared", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();

    // 2 pointer reads + 1 binding read (task.json + prd stat + implement.md
    // ENOENT) + 1 parallelCount read (the root scan does not dedupe against
    // the per-round task cache).
    assert.strictEqual(h.fakeFs.readOps.readFile, 5);
    assert.strictEqual(h.activity.getTrellisInfo("codex:aaa").taskPath, ".trellis/tasks/shared");
    assert.strictEqual(h.activity.getTrellisInfo("codex:bbb").taskPath, ".trellis/tasks/shared");
  });

  it("yields null when the pointer is missing and no fallback exists", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:some-session", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:some-session"), null);
    // First-round null is not a change — nothing was ever shown.
    assert.deepStrictEqual(h.updates, []);
  });

  it("yields null on a corrupt exact pointer without falling back to a neighbour", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:victim", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    // The exact pointer exists but is corrupt; a second healthy pi pointer
    // sits next to it. Adopting the neighbour would mis-attribute its task.
    h.fakeFs.add(path.join(PROJECT, ".trellis", ".runtime", "sessions", "pi_victim.json"), "not-json{{");
    addPointer(h.fakeFs, "pi_neighbour.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:victim"), null);
  });

  it("gives up when the fallback finds several same-platform candidates", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "pi_one.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));
    addPointer(h.fakeFs, "pi_two.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:mine"), null);
  });

  it("adopts the single fresh fallback candidate on exact-key miss", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    // Filename does not match sanitize("mine") — e.g. the host rewrote its
    // session id; the fallback still finds exactly one pi pointer.
    addPointer(h.fakeFs, "pi_actual.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:mine").taskPath, ".trellis/tasks/task-a");
  });

  it("ignores a stale fallback candidate (>30min) and transcript pointers", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "pi_stale.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", seenAgoMs: 31 * 60 * 1000, clockNow: h.clock.now }));
    // Transcript-kind file must not count as a session pointer candidate.
    addPointer(h.fakeFs, "pi_transcript_abcdef.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:mine"), null);
  });

  it("rejects a current_task that escapes tasks/", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    h.fakeFs.add(path.join(path.resolve("/outside"), "task.json"), JSON.stringify(IN_PROGRESS_TASK));
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: "../../outside", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:mine"), null);
  });

  it("detects an archived task through tasks/archive/<month>/<name>", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    // No active task dir; the pointer still references the old path.
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", "tasks", "archive", "2026-09", "gone", "task.json"),
      JSON.stringify({ title: "Gone", status: "completed", subtasks: [] })
    );
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/gone", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();

    const info = h.activity.getTrellisInfo("pi:mine");
    assert.strictEqual(info.phase, "done");
    assert.strictEqual(info.taskPath, ".trellis/tasks/archive/2026-09/gone");
    assert.strictEqual(info.title, "Gone");
    // Archived tasks are outside tasks/<name>, so they do not inflate the
    // in_progress count.
    assert.strictEqual(info.parallelCount, 0);
  });
});

describe("trellis-activity implement.md checklist", () => {
  function checklistHarness(implementMd, taskJson) {
    const h = makeHarness({
      sessions: new Map([["pi:s1", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", taskJson || IN_PROGRESS_TASK, { prd: true, implementMd });
    addPointer(
      h.fakeFs,
      "pi_s1.json",
      pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now })
    );
    return h;
  }

  it("derives progress + nextStep from the first unchecked item", async () => {
    const h = checklistHarness("# plan\n\n- [x] parse\n- [ ] **wire the bubble**\n- [ ] test\n");
    h.activity.start();
    await h.timers.runDue();

    const info = h.activity.getTrellisInfo("pi:s1");
    assert.strictEqual(info.phase, "execute");
    assert.deepStrictEqual(info.progress, { done: 1, total: 3 });
    assert.strictEqual(info.nextStep, "wire the bubble");
  });

  it("truncates a long next step to 40 code points", async () => {
    const h = checklistHarness(`- [ ] ${"x".repeat(60)}`);
    h.activity.start();
    await h.timers.runDue();

    const info = h.activity.getTrellisInfo("pi:s1");
    assert.strictEqual(Array.from(info.nextStep).length, 41); // 40 + ellipsis
    assert.ok(info.nextStep.endsWith("…"));
  });

  it("fully ticked checklist → check phase, no nextStep key", async () => {
    const h = checklistHarness("- [x] a\n- [x] b");
    h.activity.start();
    await h.timers.runDue();

    const info = h.activity.getTrellisInfo("pi:s1");
    assert.strictEqual(info.phase, "check");
    assert.deepStrictEqual(info.progress, { done: 2, total: 2 });
    assert.strictEqual("nextStep" in info, false);
  });

  it("a task without implement.md keeps the exact legacy TrellisInfo shape", async () => {
    const h = checklistHarness(null, {
      title: "T",
      status: "in_progress",
      subtasks: [{ status: "completed" }, { status: "pending" }],
    });
    h.activity.start();
    await h.timers.runDue();

    assert.deepStrictEqual(h.activity.getTrellisInfo("pi:s1"), {
      taskPath: ".trellis/tasks/task-a",
      title: "T",
      phase: "execute",
      progress: { done: 1, total: 2 },
      parallelCount: 1,
    });
  });

  it("re-notifies when the next unchecked item changes", async () => {
    const h = checklistHarness("- [x] a\n- [ ] second");
    h.activity.start();
    await h.timers.runDue();
    assert.strictEqual(h.activity.getTrellisInfo("pi:s1").nextStep, "second");

    // Tick the second item and add a third: the next step changes — the
    // diff must fan out an update.
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", "tasks", "task-a", "implement.md"),
      "- [x] a\n- [x] second\n- [ ] third"
    );
    h.timers.runDue();
    await h.timers.runDue();

    const info = h.activity.getTrellisInfo("pi:s1");
    assert.strictEqual(info.nextStep, "third");
    assert.deepStrictEqual(h.updates.at(-1), ["pi:s1"]);
  });
});

// ── gating & backoff (design D3) ──

describe("trellis-activity gating & backoff", () => {
  it("does zero IO with no live sessions and backs off to 15s", async () => {
    const h = makeHarness();
    h.activity.start();
    await h.timers.runDue();

    assert.deepStrictEqual(h.fakeFs.readOps, { readFile: 0, stat: 0, readdir: 0 });
    assert.deepStrictEqual(h.timers.pendingDelays(), [IDLE_POLL_MS]);
  });

  it("skips headless sessions and agents with no trellis mapping (zero IO)", async () => {
    const h = makeHarness({
      sessions: new Map([
        ["codex:headless", { agentId: "codex", cwd: CWD, headless: true }],
        ["qwen-code:x", { agentId: "qwen-code", cwd: CWD }],
      ]),
    });
    h.activity.start();
    await h.timers.runDue();

    assert.deepStrictEqual(h.fakeFs.readOps, { readFile: 0, stat: 0, readdir: 0 });
    assert.deepStrictEqual(h.timers.pendingDelays(), [IDLE_POLL_MS]);
  });

  it("does steady-state zero IO when no session cwd has a .trellis root", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: path.resolve("/nowhere/app") }]]),
    });
    h.activity.start();
    await h.timers.runDue();
    assert.ok(h.fakeFs.readOps.stat > 0, "first round probes for a root");
    assert.deepStrictEqual(h.timers.pendingDelays(), [IDLE_POLL_MS]);

    // The negative root memo keeps later rounds IO-free until it expires.
    const statAfterFirst = h.fakeFs.readOps.stat;
    await h.timers.runDue();
    assert.strictEqual(h.fakeFs.readOps.stat, statAfterFirst);
    assert.strictEqual(h.activity.getTrellisInfo("pi:mine"), null);
  });

  it("polls at 5s with a bindable session and recovers when one appears", async () => {
    const sessions = new Map();
    const h = makeHarness({ sessions });
    h.activity.start();
    await h.timers.runDue();
    assert.deepStrictEqual(h.timers.pendingDelays(), [IDLE_POLL_MS]);

    sessions.set("pi:late", { agentId: "pi", cwd: CWD });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "pi_late.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    await h.timers.runDue();
    assert.deepStrictEqual(h.timers.pendingDelays(), [ACTIVE_POLL_MS]);
    assert.strictEqual(h.activity.getTrellisInfo("pi:late").phase, "execute");
  });

  it("stops polling at the root-search depth bound (≤8 stat probes)", async () => {
    const deepCwd = path.resolve("/a/b/c/d/e/f/g/h/i/j/deep");
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: deepCwd }]]),
    });
    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.fakeFs.readOps.stat, 8);
    assert.strictEqual(h.activity.getTrellisInfo("pi:mine"), null);
  });
});

// ── phase transitions & celebrations (design D5) ──

describe("trellis-activity phase transitions", () => {
  function setupTask(h, taskJson) {
    addTask(h.fakeFs, "task-a", taskJson);
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));
  }

  it("seeds the first observation silently (no celebration on boot)", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    setupTask(h, { title: "A", status: "completed", subtasks: [] });

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:mine").phase, "finish");
    assert.deepStrictEqual(h.celebrations, []);
  });

  it("does not celebrate planning → in_progress", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    setupTask(h, { title: "A", status: "planning", subtasks: [] });
    h.activity.start();
    await h.timers.runDue();

    addTask(h.fakeFs, "task-a", { title: "A", status: "in_progress", subtasks: [] });
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:mine").phase, "execute");
    assert.deepStrictEqual(h.celebrations, []);
  });

  it("celebrates in_progress → completed once with the relative task path", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    setupTask(h, { title: "A", status: "in_progress", subtasks: [] });
    h.activity.start();
    await h.timers.runDue();

    addTask(h.fakeFs, "task-a", { title: "A", status: "completed", subtasks: [] });
    await h.timers.runDue();

    assert.deepStrictEqual(h.celebrations, [".trellis/tasks/task-a"]);
  });

  it("suppresses a finish → done double-celebration within 10s but still updates", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    setupTask(h, { title: "A", status: "in_progress", subtasks: [] });
    h.activity.start();
    await h.timers.runDue();

    addTask(h.fakeFs, "task-a", { title: "A", status: "completed", subtasks: [] });
    await h.timers.runDue();
    assert.strictEqual(h.celebrations.length, 1);

    // Archive move 5s later: phase becomes done, the second cheer is
    // suppressed by the 10s window, but the diff notification still fires.
    h.clock.now += 5 * 1000;
    h.fakeFs.remove(path.join(PROJECT, ".trellis", "tasks", "task-a", "task.json"));
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", "tasks", "archive", "2026-09", "task-a", "task.json"),
      JSON.stringify({ title: "A", status: "completed", subtasks: [] })
    );
    const updatesBefore = h.updates.length;
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:mine").phase, "done");
    assert.strictEqual(h.celebrations.length, 1);
    assert.strictEqual(h.updates.length, updatesBefore + 1);
  });

  it("celebrates the archive transition again once the window has passed", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    setupTask(h, { title: "A", status: "in_progress", subtasks: [] });
    h.activity.start();
    await h.timers.runDue();

    addTask(h.fakeFs, "task-a", { title: "A", status: "completed", subtasks: [] });
    await h.timers.runDue();

    h.clock.now += 11 * 1000;
    h.fakeFs.remove(path.join(PROJECT, ".trellis", "tasks", "task-a", "task.json"));
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", "tasks", "archive", "2026-09", "task-a", "task.json"),
      JSON.stringify({ title: "A", status: "completed", subtasks: [] })
    );
    await h.timers.runDue();

    assert.deepStrictEqual(h.celebrations, [".trellis/tasks/task-a", ".trellis/tasks/archive/2026-09/task-a"]);
  });

  it("drops the binding when the task vanishes without an archive copy", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    setupTask(h, { title: "A", status: "in_progress", subtasks: [] });
    h.activity.start();
    await h.timers.runDue();
    assert.ok(h.activity.getTrellisInfo("pi:mine"));

    h.fakeFs.remove(path.join(PROJECT, ".trellis", "tasks", "task-a", "task.json"));
    await h.timers.runDue();

    assert.strictEqual(h.activity.getTrellisInfo("pi:mine"), null);
    assert.deepStrictEqual(h.updates.at(-1), ["pi:mine"]);
  });
});

// ── diff notifications (design D4) ──

describe("trellis-activity diff notifications", () => {
  it("does not re-notify when nothing changed", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();
    assert.strictEqual(h.updates.length, 1);

    await h.timers.runDue();
    await h.timers.runDue();
    assert.strictEqual(h.updates.length, 1);
  });

  it("reports only the session whose task changed", async () => {
    const h = makeHarness({
      sessions: new Map([
        ["pi:a", { agentId: "pi", cwd: CWD }],
        ["codex:b", { agentId: "codex", cwd: CWD }],
      ]),
    });
    addTask(h.fakeFs, "task-a", { title: "A", status: "in_progress", subtasks: [] });
    addTask(h.fakeFs, "task-b", { title: "B", status: "in_progress", subtasks: [] });
    addPointer(h.fakeFs, "pi_a.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));
    addPointer(h.fakeFs, "codex_b.json", pointerPayload({ platform: "codex", currentTask: ".trellis/tasks/task-b", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();
    assert.strictEqual(h.updates.length, 1);
    assert.deepStrictEqual(h.updates[0].sort(), ["codex:b", "pi:a"]);

    addTask(h.fakeFs, "task-a", { title: "A2", status: "in_progress", subtasks: [] });
    await h.timers.runDue();
    assert.deepStrictEqual(h.updates.at(-1), ["pi:a"]);
  });

  it("notifies on subtask progress changes", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", { title: "A", status: "in_progress", subtasks: [{ name: "s", status: "pending" }] });
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();
    assert.deepStrictEqual(h.activity.getTrellisInfo("pi:mine").progress, { done: 0, total: 1 });

    addTask(h.fakeFs, "task-a", { title: "A", status: "in_progress", subtasks: [{ name: "s", status: "completed" }] });
    await h.timers.runDue();

    assert.deepStrictEqual(h.activity.getTrellisInfo("pi:mine").progress, { done: 1, total: 1 });
    assert.deepStrictEqual(h.updates.at(-1), ["pi:mine"]);
  });

  it("notifies on parallelCount changes once the 30s root cache expires", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    addTask(h.fakeFs, "task-b", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();
    assert.strictEqual(h.activity.getTrellisInfo("pi:mine").parallelCount, 2);

    // task-b completes; within the cache TTL the count stays stale.
    addTask(h.fakeFs, "task-b", { title: "B", status: "completed", subtasks: [] });
    h.clock.now += 10 * 1000;
    await h.timers.runDue();
    assert.strictEqual(h.activity.getTrellisInfo("pi:mine").parallelCount, 2);
    assert.strictEqual(h.updates.length, 1);

    // Past the TTL the count refreshes and the change is reported.
    h.clock.now += 21 * 1000;
    await h.timers.runDue();
    assert.strictEqual(h.activity.getTrellisInfo("pi:mine").parallelCount, 1);
    assert.deepStrictEqual(h.updates.at(-1), ["pi:mine"]);
  });
});

// ── getByProject (phase 5 / R5 — Settings tab digest) ──

describe("trellis-activity getByProject", () => {
  it("returns the active task digest built by the polling pass", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", { title: "A", status: "in_progress", subtasks: [] });
    addTask(h.fakeFs, "task-b", { title: "B", status: "planning", subtasks: [] });
    addTask(h.fakeFs, "task-c", { title: "C", status: "completed", subtasks: [] });
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();

    assert.deepStrictEqual(h.activity.getByProject(PROJECT), [
      { title: "A", phase: "execute" },
      { title: "B", phase: "plan" },
    ]);
  });

  it("is a pure cache read — no fresh IO between calls", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));
    h.activity.start();
    await h.timers.runDue();

    const reads = { ...h.fakeFs.readOps };
    assert.deepStrictEqual(h.activity.getByProject(PROJECT), [{ title: "Trellis 流程感知", phase: "execute" }]);
    h.activity.getByProject(PROJECT);
    h.activity.getByProject(path.join(PROJECT, "never-polled"));
    assert.deepStrictEqual(h.fakeFs.readOps, reads);
  });

  it("returns null for unknown roots, nothing active, and after stop()", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-c", { title: "C", status: "completed", subtasks: [] });
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-c", clockNow: h.clock.now }));
    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getByProject(PROJECT), null, "only completed tasks → nothing active");
    assert.strictEqual(h.activity.getByProject(path.join(PROJECT, "other")), null, "never polled");
    assert.strictEqual(h.activity.getByProject(""), null);
    assert.strictEqual(h.activity.getByProject(null), null);

    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    h.clock.now += 31 * 1000;
    await h.timers.runDue();
    assert.deepStrictEqual(h.activity.getByProject(PROJECT), [{ title: "Trellis 流程感知", phase: "execute" }]);

    h.activity.stop();
    assert.strictEqual(h.activity.getByProject(PROJECT), null, "stop() clears the digest cache");
  });
});

// ── getKnownRoots (recap Trellis section data source) ──

describe("trellis-activity getKnownRoots", () => {
  it("returns deduplicated resolved roots and survives session changes", async () => {
    const h = makeHarness({
      sessions: new Map([
        ["pi:one", { agentId: "pi", cwd: CWD }],
        ["pi:two", { agentId: "pi", cwd: path.join(PROJECT, "lib") }],
      ]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    h.activity.start();
    await h.timers.runDue();

    assert.deepStrictEqual(h.activity.getKnownRoots(), [path.join(PROJECT, ".trellis")]);

    // Roots are retained after the sessions end (positive cache): a project
    // worked on earlier today still feeds the recap section tonight.
    h.sessions.clear();
    h.clock.now += 60 * 1000;
    await h.timers.runDue();
    assert.deepStrictEqual(h.activity.getKnownRoots(), [path.join(PROJECT, ".trellis")]);
  });

  it("is empty without a .trellis root and after stop()", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    h.activity.start();
    await h.timers.runDue();
    assert.deepStrictEqual(h.activity.getKnownRoots(), []);

    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    h.clock.now += 60 * 1000;
    await h.timers.runDue();
    assert.deepStrictEqual(h.activity.getKnownRoots(), [path.join(PROJECT, ".trellis")]);

    h.activity.stop();
    assert.deepStrictEqual(h.activity.getKnownRoots(), []);
  });
});

// ── read-only red line (design D7) ──

describe("trellis-activity readTaskDetail", () => {
  const TASK_JSON = {
    title: "详情任务",
    status: "in_progress",
    createdAt: "2026-09-20",
    completedAt: null,
    subtasks: [],
  };
  const MD = ["# implement", "- [x] done thing", "- [ ] next thing", ""].join("\n");

  // readTaskDetail resolves a root only from a live trellis-capable
  // session's cwd, so every harness needs one session working in CWD.
  function makeDetailHarness(sessions = new Map([["pi:detail", { agentId: "pi", cwd: CWD }]])) {
    return makeHarness({ sessions });
  }

  it("reads an active task with checklist, dates and derived phase", async () => {
    const h = makeDetailHarness();
    addTask(h.fakeFs, "09-20-x", TASK_JSON, { prd: true, implementMd: MD });
    const result = await h.activity.readTaskDetail(CWD, ".trellis/tasks/09-20-x");
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.task.title, "详情任务");
    assert.strictEqual(result.task.phase, "execute");
    assert.strictEqual(result.task.rawStatus, "in_progress");
    assert.strictEqual(result.task.createdAt, "2026-09-20");
    assert.strictEqual(result.task.completedAt, null);
    assert.strictEqual(result.task.archived, false);
    assert.strictEqual(result.task.checklist.total, 2);
    assert.strictEqual(result.task.checklist.done, 1);
    assert.deepStrictEqual(
      result.task.checklist.items.map((i) => [i.text, i.checked]),
      [["done thing", true], ["next thing", false]]
    );
    assert.deepStrictEqual(h.fakeFs.writeOps, [], "detail reads stay read-only");
  });

  it("derives the check phase from a fully-ticked checklist", async () => {
    const h = makeDetailHarness();
    addTask(h.fakeFs, "t", TASK_JSON, {
      prd: true,
      implementMd: "- [x] a\n- [x] b\n",
    });
    const result = await h.activity.readTaskDetail(CWD, ".trellis/tasks/t");
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.task.phase, "check");
    assert.strictEqual(result.task.checklist.done, 2);
  });

  it("returns an empty checklist when implement.md is absent", async () => {
    const h = makeDetailHarness();
    addTask(h.fakeFs, "t", TASK_JSON, { prd: true });
    const result = await h.activity.readTaskDetail(CWD, ".trellis/tasks/t");
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.task.checklist, { items: [], done: 0, total: 0 });
  });

  it("falls back to the archive copy when the active dir just disappeared", async () => {
    const h = makeDetailHarness();
    const active = addTask(h.fakeFs, "gone", TASK_JSON, { prd: true, implementMd: MD });
    // The fake fs implies directories from files, so the active dir only
    // disappears once every file under it is gone (task.py moves the whole
    // dir in one commit).
    for (const name of ["task.json", "prd.md", "implement.md"]) {
      h.fakeFs.remove(path.join(active, name));
    }
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", "tasks", "archive", "2026-09", "gone", "task.json"),
      JSON.stringify({ ...TASK_JSON, status: "completed", completedAt: "2026-09-21" })
    );
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", "tasks", "archive", "2026-09", "gone", "implement.md"),
      MD
    );
    const result = await h.activity.readTaskDetail(CWD, ".trellis/tasks/gone");
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.task.archived, true);
    assert.strictEqual(result.task.phase, "done");
    assert.strictEqual(result.task.completedAt, "2026-09-21");
  });

  it("reads an already-archived taskPath directly", async () => {
    const h = makeDetailHarness();
    addTask(h.fakeFs, "old", TASK_JSON);
    const archivedJson = path.join(
      PROJECT, ".trellis", "tasks", "archive", "2026-08", "old", "task.json"
    );
    h.fakeFs.add(archivedJson, JSON.stringify(TASK_JSON));
    const result = await h.activity.readTaskDetail(
      CWD,
      ".trellis/tasks/archive/2026-08/old"
    );
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.task.archived, true);
    assert.strictEqual(result.task.phase, "done");
  });

  it("reports missing when no root or no task dir exists anywhere", async () => {
    const noRoot = makeDetailHarness(new Map([["pi:x", { agentId: "pi", cwd: "/nowhere" }]]));
    assert.deepStrictEqual(
      await noRoot.activity.readTaskDetail("/nowhere", ".trellis/tasks/x"),
      { status: "missing" }
    );

    const h = makeDetailHarness();
    addTask(h.fakeFs, "other", TASK_JSON);
    assert.deepStrictEqual(
      await h.activity.readTaskDetail(CWD, ".trellis/tasks/nope"),
      { status: "missing" }
    );
    assert.deepStrictEqual(
      await h.activity.readTaskDetail(CWD, ".trellis/tasks/archive/2026-09/nope"),
      { status: "missing" }
    );
  });

  it("reports an error for a corrupt task.json instead of half-empty data", async () => {
    const h = makeDetailHarness();
    const dir = addTask(h.fakeFs, "corrupt", TASK_JSON);
    h.fakeFs.remove(path.join(dir, "task.json"));
    h.fakeFs.add(path.join(dir, "task.json"), "{not json");
    const result = await h.activity.readTaskDetail(CWD, ".trellis/tasks/corrupt");
    assert.deepStrictEqual(result, { status: "error", message: "unreadable-task-json" });
  });

  it("rejects malformed and traversal taskPath inputs before any fs read", async () => {
    const h = makeDetailHarness();
    addTask(h.fakeFs, "t", TASK_JSON);
    for (const bad of [
      null,
      undefined,
      42,
      "",
      ".trellis/tasks/",
      "tasks/t",
      ".trellis/other/t",
      ".trellis/tasks/../secrets",
      ".trellis/tasks/a/../../escape",
      ".trellis/tasks//double",
      ".trellis/tasks/a\\..\\..\\..\\Windows",
      ".trellis/tasks/t\\..\\secret",
      ".trellis/tasks/archive/2026-09\\..\\..\\..\\win",
    ]) {
      assert.deepStrictEqual(
        await h.activity.readTaskDetail(CWD, bad),
        { status: "missing" },
        JSON.stringify(bad)
      );
    }
    assert.deepStrictEqual(
      await h.activity.readTaskDetail(null, ".trellis/tasks/t"),
      { status: "missing" }
    );
  });

  it("falls back to the task dir basename when task.json has no title", async () => {
    const h = makeDetailHarness();
    addTask(h.fakeFs, "nameless", { status: "planning", subtasks: [] }, { prd: true });
    const result = await h.activity.readTaskDetail(CWD, ".trellis/tasks/nameless");
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.task.title, "nameless");
    assert.strictEqual(result.task.phase, "plan");
    assert.strictEqual(result.task.createdAt, null);
  });

  it("refuses a cwd no live trellis-capable session is working in", async () => {
    // Disk has the task under PROJECT, but the only live session works in
    // CWD — a cwd the panel never showed must not resolve any root.
    const h = makeDetailHarness(new Map([[
      "pi:other",
      { agentId: "pi", cwd: path.join(PROJECT, "unrelated") },
    ]]));
    addTask(h.fakeFs, "t", TASK_JSON);
    assert.deepStrictEqual(
      await h.activity.readTaskDetail(path.join(PROJECT, "app-sub"), ".trellis/tasks/t"),
      { status: "missing" }
    );
    // headless sessions do not count either
    const headless = makeHarness({
      sessions: new Map([["pi:hl", { agentId: "pi", cwd: CWD, headless: true }]]),
    });
    addTask(headless.fakeFs, "t", TASK_JSON);
    assert.deepStrictEqual(
      await headless.activity.readTaskDetail(CWD, ".trellis/tasks/t"),
      { status: "missing" }
    );
  });
});

describe("trellis-activity read-only red line", () => {
  it("performs zero write operations across a full lifecycle", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK, { prd: true });
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();
    // planning → execute → completed → archived, plus fallback reads.
    addTask(h.fakeFs, "task-a", { title: "A", status: "completed", subtasks: [] });
    await h.timers.runDue();
    h.clock.now += 11 * 1000;
    h.fakeFs.remove(path.join(PROJECT, ".trellis", "tasks", "task-a", "task.json"));
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", "tasks", "archive", "2026-09", "task-a", "task.json"),
      JSON.stringify({ title: "A", status: "completed", subtasks: [] })
    );
    await h.timers.runDue();

    assert.deepStrictEqual(h.fakeFs.writeOps, []);
  });
});

// ── lifecycle (watcher skeleton guarantees) ──

describe("trellis-activity lifecycle", () => {
  it("start() is idempotent — a second start schedules nothing extra", async () => {
    const h = makeHarness();
    assert.strictEqual(h.activity.start(), true);
    assert.strictEqual(h.activity.start(), false);
    assert.strictEqual(h.timers.pendingDelays().length, 1);

    await h.timers.runDue();
    assert.strictEqual(h.timers.pendingDelays().length, 1);
  });

  it("stop() clears the timer and the cache; a stale queued callback is a no-op", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));
    h.activity.start();
    await h.timers.runDue();
    assert.ok(h.activity.getTrellisInfo("pi:mine"));

    assert.strictEqual(h.activity.stop(), true);
    assert.deepStrictEqual(h.timers.pendingDelays(), []);
    assert.strictEqual(h.activity.getTrellisInfo("pi:mine"), null);

    // A timer callback that fired before stop() but runs after it must hit
    // the token guard and do nothing (watcher skeleton L556-578 comment).
    const readsAfterStop = { ...h.fakeFs.readOps };
    h.fakeFs.remove(path.join(PROJECT, ".trellis", "tasks", "task-a", "task.json"));
    await h.timers.runDue(); // nothing scheduled anymore
    assert.deepStrictEqual(h.fakeFs.readOps, readsAfterStop);
  });

  it("restarts cleanly after stop()", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    h.activity.start();
    await h.timers.runDue();
    h.activity.stop();

    h.activity.start();
    await h.timers.runDue();
    assert.strictEqual(h.activity.getTrellisInfo("pi:mine").phase, "execute");
    assert.deepStrictEqual(h.timers.pendingDelays(), [ACTIVE_POLL_MS]);
  });

  it("keeps polling after a round throws (loop survives, retries next round)", async () => {
    const h = makeHarness({
      sessions: new Map([["pi:mine", { agentId: "pi", cwd: CWD }]]),
    });
    addTask(h.fakeFs, "task-a", IN_PROGRESS_TASK);
    addPointer(h.fakeFs, "pi_mine.json", pointerPayload({ platform: "pi", currentTask: ".trellis/tasks/task-a", clockNow: h.clock.now }));

    // Make every readFile throw mid-round after start.
    h.activity.start();
    const originalReadFile = h.fakeFs.fsApi.readFile;
    let sabotaged = false;
    h.fakeFs.fsApi.readFile = async (p) => {
      if (!sabotaged) {
        sabotaged = true;
        throw new Error("disk exploded");
      }
      return originalReadFile(p);
    };
    await h.timers.runDue();
    h.fakeFs.fsApi.readFile = originalReadFile;

    // The loop must have rescheduled and recovered on the next round.
    assert.deepStrictEqual(h.timers.pendingDelays(), [ACTIVE_POLL_MS]);
    await h.timers.runDue();
    assert.strictEqual(h.activity.getTrellisInfo("pi:mine").phase, "execute");
  });
});

// ── project aggregates (avatar R3/R3.1) ──

describe("trellis-activity project aggregates", () => {
  function bindCodex(h, { taskName = "task-a", taskJson = IN_PROGRESS_TASK } = {}) {
    addTask(h.fakeFs, taskName, taskJson, { prd: true });
    addPointer(
      h.fakeFs,
      "codex_s1.json",
      pointerPayload({ platform: "codex", currentTask: `.trellis/tasks/${taskName}`, clockNow: h.clock.now })
    );
  }

  it("counts executing tasks of bound roots and reports them once on change", async () => {
    const h = makeHarness({
      sessions: new Map([["s1", { agentId: "codex", cwd: CWD }]]),
    });
    bindCodex(h);
    addTask(h.fakeFs, "task-b", { title: "B", status: "in_progress", subtasks: [] });
    addTask(h.fakeFs, "task-c", { title: "C", status: "completed", subtasks: [] });

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getExecutingCount(), 2);
    assert.strictEqual(h.activity.hasPlanningBinding(), false);
    assert.deepStrictEqual(h.aggregates, [{ executingCount: 2, planningActive: false }]);

    // Steady rounds with nothing changed must not re-fan-out.
    await h.timers.runDue();
    assert.strictEqual(h.aggregates.length, 1);
  });

  it("dedupes one root across sessions bound to different tasks", async () => {
    const h = makeHarness({
      sessions: new Map([
        ["s1", { agentId: "codex", cwd: CWD }],
        ["s2", { agentId: "claude-code", cwd: CWD }],
      ]),
    });
    bindCodex(h, { taskName: "task-a" });
    addTask(h.fakeFs, "task-b", { title: "B", status: "in_progress", subtasks: [] });
    addPointer(
      h.fakeFs,
      "claude_s2.json",
      pointerPayload({ platform: "claude", currentTask: ".trellis/tasks/task-b", clockNow: h.clock.now })
    );

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getExecutingCount(), 2);
    assert.deepStrictEqual(h.aggregates, [{ executingCount: 2, planningActive: false }]);
  });

  it("flags planning bindings and clears them when the task moves to executing", async () => {
    const h = makeHarness({
      sessions: new Map([["s1", { agentId: "codex", cwd: CWD }]]),
    });
    bindCodex(h, { taskJson: { title: "A", status: "planning", subtasks: [] } });

    h.activity.start();
    await h.timers.runDue();

    assert.strictEqual(h.activity.hasPlanningBinding(), true);
    assert.strictEqual(h.activity.getExecutingCount(), 0);
    assert.deepStrictEqual(h.aggregates, [{ executingCount: 0, planningActive: true }]);

    // Task moves planning → in_progress. parallelCount rides a 30s TTL cache,
    // so advance past it before the next round.
    h.fakeFs.add(
      path.join(PROJECT, ".trellis", "tasks", "task-a", "task.json"),
      JSON.stringify({ title: "A", status: "in_progress", subtasks: [] })
    );
    h.clock.now += 31 * 1000;
    await h.timers.runDue();

    assert.strictEqual(h.activity.hasPlanningBinding(), false);
    assert.strictEqual(h.activity.getExecutingCount(), 1);
    assert.deepStrictEqual(h.aggregates, [
      { executingCount: 0, planningActive: true },
      { executingCount: 1, planningActive: false },
    ]);
  });

  it("clears aggregates when the last bound session disappears", async () => {
    const h = makeHarness({
      sessions: new Map([["s1", { agentId: "codex", cwd: CWD }]]),
    });
    bindCodex(h);

    h.activity.start();
    await h.timers.runDue();
    assert.strictEqual(h.activity.getExecutingCount(), 1);

    h.sessions.clear();
    await h.timers.runDue();

    assert.strictEqual(h.activity.getExecutingCount(), 0);
    assert.strictEqual(h.activity.hasPlanningBinding(), false);
    assert.deepStrictEqual(h.aggregates, [
      { executingCount: 1, planningActive: false },
      { executingCount: 0, planningActive: false },
    ]);
  });

  it("stop() resets the aggregates without fan-out", async () => {
    const h = makeHarness({
      sessions: new Map([["s1", { agentId: "codex", cwd: CWD }]]),
    });
    bindCodex(h);

    h.activity.start();
    await h.timers.runDue();
    const fanouts = h.aggregates.length;
    assert.ok(fanouts > 0);

    h.activity.stop();
    assert.strictEqual(h.activity.getExecutingCount(), 0);
    assert.strictEqual(h.activity.hasPlanningBinding(), false);
    assert.strictEqual(h.aggregates.length, fanouts);
  });
});
