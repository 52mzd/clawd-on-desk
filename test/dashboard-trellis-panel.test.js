"use strict";

// Focused harness for the Dashboard's Trellis tasks panel: the pure
// aggregation (dedupe / phase gating / progress normalization) plus the
// renderer-side contract (hidden when no binding, row focus, multi-session
// expansion into chips). The fake DOM is rebuilt locally, mirroring
// test/dashboard-session-history.test.js, so a drift in that file's expected
// node tree cannot mask a regression here.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");
const { i18n } = require("../src/i18n");
const {
  aggregateTrellisTasks,
  groupTrellisTasks,
  groupTrellisArchiveByMonth,
  buildTrellisTree,
  trellisArchiveMonthOf,
  TRELLIS_TREE_DEPTH_CAP,
  TRELLIS_PHASE_BADGE,
  normalizeProgress,
  trellisTaskOwningRoot,
  filterTrellisTasksByRoot,
  buildTrellisRootLabels,
  boardPhaseFor,
  bucketByBoardPhase,
} = require("../src/dashboard-trellis-panel");

// The fake DOM below models `hidden` as a plain JS property, so the CSS
// layer needs its own static guard: `.trellis-panel { display: flex }`
// overrides the UA `[hidden] { display: none }` rule, and without an
// explicit override the "hidden" panel would still leak a 12px margin gap.
it("keeps the hidden attribute stronger than .trellis-panel's display: flex", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
  assert.match(html, /\.trellis-panel\[hidden\]\s*\{\s*display:\s*none;/,
    "dashboard.html must ship .trellis-panel[hidden] { display: none } next to display: flex");
  assert.match(html, /\.trellis-detail-overlay\[hidden\]\s*\{\s*display:\s*none;/,
    "dashboard.html must ship .trellis-detail-overlay[hidden] { display: none } next to display: flex");
  assert.match(html, /\.trellis-view\[hidden\]\s*\{\s*display:\s*none;/,
    "dashboard.html must ship .trellis-view[hidden] { display: none } so the hidden second main can never leak");
});

function bindingSession(id, trellis, extra = {}) {
  return {
    id,
    displayTitle: `Title ${id}`,
    agentId: "claude-code",
    agentName: "Claude Code",
    canFocus: true,
    cwd: `/proj/${id}`,
    trellis,
    ...extra,
  };
}

describe("dashboard trellis panel aggregation (pure)", () => {
  it("deduplicates sessions bound to the same task into one row", () => {
    const trellis = {
      taskPath: ".trellis/tasks/09-20-dashboard-page",
      title: "Dashboard page",
      phase: "execute",
      progress: { done: 2, total: 5 },
    };
    const tasks = aggregateTrellisTasks([
      bindingSession("s1", trellis),
      bindingSession("s2", trellis, { canFocus: false }),
      bindingSession("s3", {
        taskPath: ".trellis/tasks/09-19-other",
        title: "Other",
        phase: "plan",
        progress: null,
      }),
    ]);
    assert.equal(tasks.length, 2);
    const first = tasks[0];
    assert.equal(first.taskPath, ".trellis/tasks/09-20-dashboard-page");
    assert.equal(first.title, "Dashboard page");
    assert.equal(first.phase, "execute");
    assert.deepEqual(first.progress, { done: 2, total: 5 });
    assert.equal(first.sessions.length, 2, "both bindings must be listed on the task");
    assert.deepEqual(first.sessions.map((s) => s.id), ["s1", "s2"]);
    assert.equal(first.sessions[1].canFocus, false);
    assert.equal(first.sessions[1].displayTitle, "Title s2");
    // cwd rides along so the detail view can resolve the .trellis root from
    // a bound session's working directory.
    assert.equal(first.sessions[0].cwd, "/proj/s1");
    assert.equal(first.sessions[1].cwd, "/proj/s2");
  });

  it("defaults a missing session cwd to an empty string", () => {
    const tasks = aggregateTrellisTasks([
      bindingSession("s1", { taskPath: ".trellis/tasks/t", phase: "execute", title: "T" },
        { cwd: undefined }),
    ]);
    assert.equal(tasks[0].sessions[0].cwd, "");
  });

  it("returns [] when no session carries a usable trellis binding", () => {
    assert.deepEqual(aggregateTrellisTasks([]), []);
    assert.deepEqual(aggregateTrellisTasks([bindingSession("s1", null)]), []);
    assert.deepEqual(aggregateTrellisTasks([bindingSession("s1", "junk")]), []);
    assert.deepEqual(
      aggregateTrellisTasks([bindingSession("s1", { phase: "execute" })]),
      [],
      "a binding without taskPath cannot be keyed, so it is dropped"
    );
  });

  it("drops bindings whose phase is unknown instead of rendering them", () => {
    const tasks = aggregateTrellisTasks([
      bindingSession("s1", { taskPath: ".trellis/tasks/x", phase: "archived" }),
      bindingSession("s2", { taskPath: ".trellis/tasks/y", phase: undefined, title: "Y" }),
    ]);
    assert.deepEqual(tasks, []);
  });

  it("keeps the last observed phase/progress and the first non-empty title", () => {
    const tasks = aggregateTrellisTasks([
      bindingSession("s1", {
        taskPath: ".trellis/tasks/t",
        title: "",
        phase: "plan",
        progress: { done: 1, total: 4 },
      }),
      bindingSession("s2", {
        taskPath: ".trellis/tasks/t",
        title: "Real title",
        phase: "finish",
        progress: null,
      }),
    ]);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "Real title");
    assert.equal(tasks[0].phase, "finish");
    assert.deepEqual(tasks[0].progress, { done: 1, total: 4 },
      "a binding without progress must not erase the last valid one");
  });

  it("maps every known phase onto the HUD-compatible badge definition", () => {
    assert.deepEqual(TRELLIS_PHASE_BADGE.plan, { labelKey: "sessionHudTrellisPhasePlan", cls: "phase-plan" });
    assert.deepEqual(TRELLIS_PHASE_BADGE.execute, { labelKey: "sessionHudTrellisPhaseExecute", cls: "phase-execute" });
    assert.deepEqual(TRELLIS_PHASE_BADGE.finish, { labelKey: "sessionHudTrellisPhaseFinish", cls: "phase-finish" });
    assert.deepEqual(TRELLIS_PHASE_BADGE.done, { labelKey: "sessionHudTrellisPhaseDone", cls: "phase-done" });
  });

  it("normalizes progress defensively", () => {
    assert.equal(normalizeProgress(null), null);
    assert.equal(normalizeProgress({}), null);
    assert.equal(normalizeProgress({ done: 1, total: 0 }), null);
    assert.equal(normalizeProgress({ done: 1, total: -4 }), null, "negative totals are not progress");
    assert.equal(normalizeProgress({ done: Number.NaN, total: 4 }), null);
    assert.deepEqual(normalizeProgress({ done: 2.9, total: 5.9 }), { done: 2, total: 5 });
    assert.deepEqual(normalizeProgress({ done: -1, total: 5 }), { done: 0, total: 5 });
  });
});

describe("dashboard trellis project filter (pure)", () => {
  it("labels roots by basename and disambiguates duplicates with ancestor segments", () => {
    const plain = buildTrellisRootLabels(["/a/proj", "/b/other"]);
    assert.equal(plain.get("/a/proj"), "proj");
    assert.equal(plain.get("/b/other"), "other");

    // Same basename → one ancestor segment ("name (parent)").
    const pair = buildTrellisRootLabels(["/a/one/proj", "/b/two/proj"]);
    assert.equal(pair.get("/a/one/proj"), "proj (one)");
    assert.equal(pair.get("/b/two/proj"), "proj (two)");

    // Parent segments also clash → one level deeper ("name (grand/parent)").
    const deep = buildTrellisRootLabels(["/x/w/proj", "/y/w/proj"]);
    assert.equal(deep.get("/x/w/proj"), "proj (x/w)");
    assert.equal(deep.get("/y/w/proj"), "proj (y/w)");

    // A root with no ancestor segments cannot be disambiguated → the
    // full path keeps every label unique.
    const bare = buildTrellisRootLabels(["/p", "/q/p"]);
    assert.equal(bare.get("/p"), "/p");
    assert.equal(bare.get("/q/p"), "p (q)");
  });

  it("assigns a task to the longest matching registered root", () => {
    const roots = ["/proj/one", "/proj/one/nested", "/proj/two"];
    assert.equal(trellisTaskOwningRoot("/proj/one", roots), "/proj/one");
    assert.equal(trellisTaskOwningRoot("/proj/one/sub", roots), "/proj/one");
    // Nested roots pick the most specific owner so a task never counts twice.
    assert.equal(trellisTaskOwningRoot("/proj/one/nested/deep", roots), "/proj/one/nested");
    assert.equal(trellisTaskOwningRoot("C:\\work\\proj", ["C:\\work"]), "C:\\work");
    assert.equal(trellisTaskOwningRoot("/proj/three", roots), null);
    // A prefix must land on a separator — "/proj/onesuffix" is not owned
    // by "/proj/one".
    assert.equal(trellisTaskOwningRoot("/proj/onesuffix", roots), null);
    assert.equal(trellisTaskOwningRoot(null, roots), null);
  });

  it("filters task lists by the selected root only", () => {
    const roots = ["/proj/one", "/proj/two"];
    const tasks = [
      { taskPath: "a", cwd: "/proj/one" },
      { taskPath: "b", cwd: "/proj/two/deep" },
      { taskPath: "c", cwd: "/elsewhere" },
    ];
    assert.deepEqual(filterTrellisTasksByRoot(tasks, roots, null), tasks);
    assert.deepEqual(
      filterTrellisTasksByRoot(tasks, roots, "/proj/one").map((task) => task.taskPath),
      ["a"]
    );
    assert.deepEqual(
      filterTrellisTasksByRoot(tasks, roots, "/proj/two").map((task) => task.taskPath),
      ["b"]
    );
  });
});


describe("dashboard trellis panel grouping (pure)", () => {
  function task(path, extra = {}) {
    return { taskPath: path, title: path, phase: "execute", progress: null, sessions: [], ...extra };
  }

  it("groups children under a live parent and sums subtree progress", () => {
    const rows = groupTrellisTasks([
      task(".trellis/tasks/parent", { progress: { done: 1, total: 2 } }),
      task(".trellis/tasks/kid-b", { parent: "parent", progress: { done: 2, total: 3 } }),
      task(".trellis/tasks/kid-a", { parent: "parent", progress: null }),
      task(".trellis/tasks/loner"),
    ]);
    assert.deepEqual(rows.map((r) => [r.task.taskPath, r.depth]), [
      [".trellis/tasks/parent", 0],
      [".trellis/tasks/kid-b", 1], // children keep their aggregate order
      [".trellis/tasks/kid-a", 1],
      [".trellis/tasks/loner", 0],
    ]);
    const parent = rows[0];
    assert.equal(parent.hasChildren, true);
    // Subtree sum counts children (and grandchildren), not the parent's own
    // progress — the group summary replaces it on the row.
    assert.deepEqual(parent.childSummary, { done: 2, total: 3 });
    assert.equal(rows[1].hasChildren, false);
    assert.equal(rows[1].childSummary, null);
    assert.equal(rows[3].childSummary, null, "childless tasks keep no summary");
  });

  it("sums nested grandchildren into the top group summary", () => {
    const rows = groupTrellisTasks([
      task(".trellis/tasks/top"),
      task(".trellis/tasks/mid", { parent: "top", progress: { done: 1, total: 4 } }),
      task(".trellis/tasks/leaf", { parent: "mid", progress: { done: 2, total: 2 } }),
    ]);
    assert.deepEqual(rows.map((r) => [r.task.taskPath, r.depth]), [
      [".trellis/tasks/top", 0],
      [".trellis/tasks/mid", 1],
      [".trellis/tasks/leaf", 2],
    ]);
    assert.deepEqual(rows[0].childSummary, { done: 3, total: 6 }, "subtree sum, not direct children only");
    assert.deepEqual(rows[1].childSummary, { done: 2, total: 2 });
    assert.equal(rows[2].hasChildren, false);
  });

  it("flattens orphans: missing, archived or cross-directory parents", () => {
    const rows = groupTrellisTasks([
      task(".trellis/tasks/orphan", { parent: "not-in-live-set" }),
      task(".trellis/tasks/bad", { parent: 42 }),
      task(".trellis/tasks/blank", { parent: "" }),
      // Same task NAME but a different directory must NOT fuse trees.
      task(".trellis/tasks/archive/2026-09/parent-dir/other"),
    ]);
    assert.deepEqual(rows.map((r) => [r.task.taskPath, r.depth]), [
      [".trellis/tasks/orphan", 0],
      [".trellis/tasks/bad", 0],
      [".trellis/tasks/blank", 0],
      [".trellis/tasks/archive/2026-09/parent-dir/other", 0],
    ]);
    for (const row of rows) assert.equal(row.hasChildren, false);
  });

  it("keeps parent cycles flat instead of looping or dropping rows", () => {
    const rows = groupTrellisTasks([
      task(".trellis/tasks/cyc-a", { parent: "cyc-b" }),
      task(".trellis/tasks/cyc-b", { parent: "cyc-a", progress: { done: 1, total: 1 } }),
      task(".trellis/tasks/self", { parent: "self" }),
    ]);
    assert.equal(rows.length, 3, "every task still renders exactly once");
    assert.deepEqual(rows.map((r) => r.depth), [0, 1, 0]);
  });

  it("aggregates the first non-empty parent onto the deduped task", () => {
    const tasks = aggregateTrellisTasks([
      bindingSession("s1", {
        taskPath: ".trellis/tasks/kid", phase: "execute", title: "Kid", parent: "",
      }),
      bindingSession("s2", {
        taskPath: ".trellis/tasks/kid", phase: "execute", title: "Kid", parent: "real-parent",
      }),
    ]);
    assert.equal(tasks[0].parent, "real-parent");
    const solo = aggregateTrellisTasks([
      bindingSession("s1", { taskPath: ".trellis/tasks/x", phase: "execute", parent: 7 }),
    ]);
    assert.equal(solo[0].parent, null);
  });

  it("tolerates junk input without throwing", () => {
    assert.deepEqual(groupTrellisTasks([]), []);
    assert.deepEqual(groupTrellisTasks(null), []);
    assert.equal(groupTrellisTasks([null, { taskPath: "x" }, {}]).length, 1);
  });
});


// ── Renderer-side harness ───────────────────────────────────────────────────

class FakeClassList {
  constructor(element) { this.element = element; }
  add(...names) {
    const set = new Set(this.element.className.split(/\s+/).filter(Boolean));
    for (const name of names) set.add(name);
    this.element.className = [...set].join(" ");
  }
  remove(...names) {
    const drop = new Set(names);
    this.element.className = this.element.className
      .split(/\s+/).filter((n) => n && !drop.has(n)).join(" ");
  }
  contains(name) { return this.element.className.split(/\s+/).includes(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.style = { setProperty() {} };
    this.dataset = {};
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  async dispatch(name) {
    const event = {
      stopPropagation() {}, preventDefault() {}, key: "",
    };
    for (const listener of this.listeners.get(name) || []) await listener(event);
  }
}

function descendants(root) {
  const out = [];
  for (const child of root.children || []) out.push(child, ...descendants(child));
  return out;
}

function byClass(root, className) {
  return descendants(root).filter(
    (el) => el.classList && el.classList.contains(className),
  );
}

function textOf(node) {
  const own = typeof node.textContent === "string" ? node.textContent : "";
  return [own, ...(node.children || []).map(textOf)].join(" ").replace(/\s+/g, " ").trim();
}

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

async function switchToTrellis(app) {
  await app.trellisTab.dispatch("click");
  await flush();
}


function loadDashboard({
  sessions = [],
  detailResult = null,
  detailError = null,
  docResult = null,
  docError = null,
  archiveResult = null,
  archiveError = null,
  activeResult = null,
  activeError = null,
  rootsResult = null,
  rootsError = null,
  addResult = null,
  removeResult = null,
  specResult = null,
  specError = null,
} = {}) {
  const elements = new Map(
    [
      "content", "title", "count", "quickBanner", "quotaSummary", "trellisPanel",
      "trellisDetailOverlay", "trellisView", "viewSessionsTab", "viewTrellisTab",
      "sessionsHeaderExtras",
      // v7 R6 spec map overlay (its file list / doc pane are built inline).
      "trellisSpecOverlay",
    ].map((id) => [id, new FakeElement("div")]),
  );
  // The real page starts with <main id="trellisView" hidden>; mirror that.
  elements.get("trellisView").hidden = true;
  const docListeners = new Map();
  const document = {
    title: "",
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new FakeElement("fragment"),
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    contains: () => true,
    addEventListener: (name, listener) => {
      if (!docListeners.has(name)) docListeners.set(name, []);
      docListeners.get(name).push(listener);
    },
  };

  const focusCalls = [];
  const detailCalls = [];
  const docCalls = [];
  const archiveCalls = [];
  const activeCalls = [];
  const rootsCalls = [];
  const addRootCalls = [];
  const specCalls = [];
  const removeRootCalls = [];
  let snapshotListener = null;
  let renderInterval = null;
  let quickIntentListener = null;
  // Minimal quick-mode surface: initQuickMode's platform gate keys off
  // quickEnter's presence, and a "refused" enter keeps the round inert so
  // the test only observes the view switch beginQuickRound makes.
  const quickApi = {
    quickEnter: async () => ({ status: "refused" }),
    quickPending: async () => ({ status: "ok" }),
    onQuickIntent: (cb) => { quickIntentListener = cb; },
    onQuickEntries: () => {},
    onQuickDismissed: () => {},
  };
  const api = {
    getI18n: async () => ({ lang: "en", translations: { ...i18n.en } }),
    getSnapshot: async () => ({ sessions, groups: [] }),
    getKimiQuotaStatus: async () => null,
    getSessionHistory: async () => [],
    onLangChange: () => {},
    onSessionSnapshot: (cb) => { snapshotListener = cb; },
    focusSession: (id) => { focusCalls.push(id); },
    hideSession: async () => ({ status: "ok" }),
    openSessionFolder: async () => ({ status: "ok" }),
    setSessionAlias: async () => ({ status: "ok" }),
    setSessionAutomationOverride: async () => ({ status: "ok" }),
    clearSessionAutomationGrant: async () => ({ status: "ok" }),
    ackCompletion: async () => ({ status: "ok" }),
    getTrellisTaskDetail: async (payload) => {
      detailCalls.push(payload);
      if (detailError) throw detailError;
      return typeof detailResult === "function" ? detailResult(payload) : detailResult;
    },
    getTrellisTaskDoc: async (payload) => {
      docCalls.push(payload);
      if (docError) throw docError;
      return typeof docResult === "function" ? docResult(payload) : docResult;
    },
    getTrellisArchiveList: async () => {
      archiveCalls.push(null);
      if (archiveError) throw archiveError;
      return typeof archiveResult === "function" ? archiveResult() : archiveResult;
    },
    getTrellisActiveList: async () => {
      activeCalls.push(null);
      if (activeError) throw activeError;
      return typeof activeResult === "function" ? activeResult() : activeResult;
    },
    getTrellisSpecTree: async (payload) => {
      specCalls.push(payload);
      if (specError) throw specError;
      return typeof specResult === "function" ? specResult(payload) : specResult;
    },
    listTrellisRoots: async () => {
      rootsCalls.push(null);
      if (rootsError) throw rootsError;
      return typeof rootsResult === "function" ? rootsResult() : rootsResult;
    },
    addTrellisRoot: async () => {
      addRootCalls.push(null);
      return addResult || { status: "cancelled" };
    },
    removeTrellisRoot: async (root) => {
      removeRootCalls.push(root);
      return removeResult || { status: "ok", roots: [] };
    },
    ...quickApi,
  };

  const context = vm.createContext({
    window: {
      dashboardAPI: api,
      addEventListener: () => {},
    }, document, console, Intl, Date,
    setInterval: (cb) => { renderInterval = cb; return 1; },
    requestAnimationFrame: (cb) => cb(),
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"),
    context,
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-trellis-panel.js"), "utf8"),
    context,
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "trellis-doc-renderer.js"), "utf8"),
    context,
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8"),
    context,
  );

  return {
    panel: elements.get("trellisPanel"),
    overlay: elements.get("trellisDetailOverlay"),
    specOverlay: elements.get("trellisSpecOverlay"),
    view: elements.get("trellisView"),
    content: elements.get("content"),
    titleEl: elements.get("title"),
    trellisTab: elements.get("viewTrellisTab"),
    sessionsTab: elements.get("viewSessionsTab"),
    headerExtras: elements.get("sessionsHeaderExtras"),
    focusCalls,
    detailCalls,
    docCalls,
    archiveCalls,
    activeCalls,
    rootsCalls,
    specCalls,
    addRootCalls,
    removeRootCalls,
    docListeners,
    pressKey: (key) => {
      for (const fn of docListeners.get("keydown") || []) {
        fn({ key, stopPropagation() {}, preventDefault() {} });
      }
    },
    pushSnapshot: (next) => snapshotListener && snapshotListener(next),
    tickRender: () => { if (renderInterval) renderInterval(); },
    quickIntent: (revision) => quickIntentListener && quickIntentListener({ revision }),
  };
}

describe("dashboard trellis panel rendering", () => {
  it("shows tasks with phase badge and steps, then hides when bindings disappear", async () => {
    const trellis = {
      taskPath: ".trellis/tasks/09-20-dashboard-page",
      title: "Dashboard page",
      phase: "execute",
      progress: { done: 2, total: 5 },
    };
    const app = loadDashboard({ sessions: [bindingSession("s1", trellis)] });
    await flush();
    assert.equal(app.panel.hidden, false);
    const rows = byClass(app.panel, "trellis-task-row");
    assert.equal(rows.length, 1);
    const text = textOf(app.panel);
    assert.ok(text.includes("Dashboard page"));
    assert.ok(text.includes(i18n.en.sessionHudTrellisPhaseExecute));
    assert.ok(text.includes("2/5"));
    assert.ok(!text.includes(i18n.en.dashboardTrellisBoundSessions.replace("{n}", "1")),
      "a single binding does not need a session count");

    app.pushSnapshot({ sessions: [bindingSession("s1", null, { cwd: null })], groups: [] });
    await flush();
    assert.equal(app.panel.hidden, true, "no live binding and no live cwd → the whole panel disappears");
    assert.equal(app.panel.children.length, 0);
  });

  it("hides the panel entirely when no session carries a binding", async () => {
    const plainSession = {
      id: "s9",
      agent: "pi",
      state: "working",
      cwd: "/repo/alpha",
    };
    const app = loadDashboard({ sessions: [plainSession], groups: [] });
    await flush();
    assert.equal(app.panel.hidden, true,
      "the archive browser lives in the independent view, so a cwd-only panel hides");
    assert.equal(app.panel.children.length, 0);
  });

  it("focuses the single bound session when the row is clicked", async () => {
    const trellis = {
      taskPath: ".trellis/tasks/t1",
      title: "Solo task",
      phase: "plan",
      progress: null,
    };
    const app = loadDashboard({ sessions: [bindingSession("s1", trellis)] });
    await flush();
    await byClass(app.panel, "trellis-task-row")[0].dispatch("click");
    assert.deepEqual(app.focusCalls, ["s1"]);
  });

  it("does not focus an unfocusable single binding", async () => {
    const trellis = { taskPath: ".trellis/tasks/t1", title: "Remote task", phase: "done" };
    const app = loadDashboard({
      sessions: [bindingSession("s1", trellis, { canFocus: false })],
    });
    await flush();
    await byClass(app.panel, "trellis-task-row")[0].dispatch("click");
    assert.deepEqual(app.focusCalls, [], "row click must not jump to a session that cannot focus");
  });

  it("expands multi-session bindings into chips that each own their focus call", async () => {
    const trellis = {
      taskPath: ".trellis/tasks/shared",
      title: "Shared task",
      phase: "execute",
      progress: { done: 1, total: 3 },
    };
    const app = loadDashboard({
      sessions: [
        bindingSession("s1", trellis),
        bindingSession("s2", trellis, { canFocus: false, displayTitle: "Remote helper" }),
      ],
    });
    await flush();

    const row = byClass(app.panel, "trellis-task-row")[0];
    assert.equal(byClass(app.panel, "trellis-session-chip").length, 0,
      "chips are hidden until the row is clicked");
    assert.ok(textOf(app.panel).includes(
      i18n.en.dashboardTrellisBoundSessions.replace("{n}", "2")
    ), "the binding count is visible without expanding");

    await row.dispatch("click");
    const chips = byClass(app.panel, "trellis-session-chip");
    assert.equal(chips.length, 2);
    assert.equal(app.focusCalls.length, 0, "expanding must not focus anything by itself");

    await chips[0].dispatch("click");
    assert.deepEqual(app.focusCalls, ["s1"]);
    assert.equal(chips[1].disabled, true, "unfocusable bindings render as disabled chips");

    // Collapse again: the same row click toggles the chip list away.
    const rowAfter = byClass(app.panel, "trellis-task-row")[0];
    await rowAfter.dispatch("click");
    assert.equal(byClass(app.panel, "trellis-session-chip").length, 0);
  });

  it("keeps an expanded row expanded across the one-second rebuild", async () => {
    const trellis = { taskPath: ".trellis/tasks/shared", title: "Shared task", phase: "execute" };
    const app = loadDashboard({
      sessions: [bindingSession("s1", trellis), bindingSession("s2", trellis)],
    });
    await flush();
    await byClass(app.panel, "trellis-task-row")[0].dispatch("click");
    assert.equal(byClass(app.panel, "trellis-session-chip").length, 2);

    app.tickRender();
    assert.equal(byClass(app.panel, "trellis-session-chip").length, 2,
      "the periodic rebuild must not collapse the user's expansion");
  });
});

// ── Task detail overlay (renderer harness) ─────────────────────────────

function detailOk(extra = {}) {
  return {
    status: "ok",
    task: {
      title: "Title from disk",
      phase: "execute",
      rawStatus: "in_progress",
      createdAt: "2026-09-20",
      completedAt: null,
      archived: false,
      docs: [],
      checklist: {
        items: [{ text: "step one", checked: true }, { text: "step two", checked: false }],
        done: 1,
        total: 2,
      },
      ...extra,
    },
  };
}

async function openDetail(app) {
  await byClass(app.panel, "trellis-task-detail-btn")[0].dispatch("click");
  await flush();
}

describe("dashboard trellis task detail overlay", () => {
  it("opens from the row-tail button with one IPC read and renders the card", async () => {
    const trellis = { taskPath: ".trellis/tasks/t1", title: "Row title", phase: "execute" };
    const app = loadDashboard({
      sessions: [bindingSession("s1", trellis)],
      detailResult: detailOk(),
    });
    await flush();

    await openDetail(app);
    assert.deepEqual(app.detailCalls, [{ taskPath: ".trellis/tasks/t1", cwd: "/proj/s1" }],
      "exactly one on-demand read carrying the bound session's cwd");
    assert.deepEqual(app.focusCalls, [],
      "the detail button must not steal the row's focus semantics");
    assert.equal(app.overlay.hidden, false);

    const text = textOf(app.overlay);
    assert.ok(text.includes("Title from disk"));
    assert.ok(text.includes(i18n.en.sessionHudTrellisPhaseExecute));
    assert.ok(text.includes(i18n.en.dashboardTrellisDetailCreated.replace("{date}", "2026-09-20")));
    assert.ok(text.includes(
      i18n.en.dashboardTrellisDetailSteps.replace("{done}", "1").replace("{total}", "2")
    ));
    assert.ok(text.includes("step one"));
    assert.ok(text.includes("step two"));
    const ticks = byClass(app.overlay, "trellis-detail-progress-ticks");
    assert.equal(ticks.length, 1);
    const cells = byClass(app.overlay, "trellis-progress-tick");
    assert.equal(cells.length, 2);
    assert.ok(cells[0].classList.contains("is-filled"));
    assert.ok(!cells[1].classList.contains("is-filled"));
    const items = byClass(app.overlay, "trellis-detail-check-item");
    assert.equal(items.length, 2);
    assert.ok(items[0].classList.contains("trellis-detail-check-item-done"));
    assert.ok(!items[1].classList.contains("trellis-detail-check-item-done"));
  });

  it("shows the archived badge and completed date for an archived task", async () => {
    const trellis = { taskPath: ".trellis/tasks/gone", title: "Gone", phase: "done" };
    const app = loadDashboard({
      sessions: [bindingSession("s1", trellis)],
      detailResult: detailOk({
        phase: "done",
        archived: true,
        completedAt: "2026-09-21",
        checklist: { items: [{ text: "only", checked: true }], done: 1, total: 1 },
      }),
    });
    await flush();
    await openDetail(app);
    const text = textOf(app.overlay);
    assert.ok(text.includes(i18n.en.dashboardTrellisDetailArchived));
    assert.ok(text.includes(
      i18n.en.dashboardTrellisDetailCompleted.replace("{date}", "2026-09-21")
    ));
  });

  it("renders an empty-checklist note instead of an empty list", async () => {
    const trellis = { taskPath: ".trellis/tasks/t1", title: "T", phase: "plan" };
    const app = loadDashboard({
      sessions: [bindingSession("s1", trellis)],
      detailResult: detailOk({ checklist: { items: [], done: 0, total: 0 } }),
    });
    await flush();
    await openDetail(app);
    const text = textOf(app.overlay);
    assert.ok(text.includes(i18n.en.dashboardTrellisDetailChecklistEmpty));
    assert.equal(byClass(app.overlay, "trellis-detail-check-item").length, 0);
    assert.equal(byClass(app.overlay, "trellis-detail-progress-fill").length, 0,
      "no checklist → no progress bar");
  });

  it("lists bound sessions in the card and focuses a chip on click", async () => {
    const trellis = { taskPath: ".trellis/tasks/shared", title: "Shared", phase: "execute" };
    const app = loadDashboard({
      sessions: [bindingSession("s1", trellis), bindingSession("s2", trellis, { canFocus: false })],
      detailResult: detailOk(),
    });
    await flush();
    await openDetail(app);
    const chips = byClass(app.overlay, "trellis-session-chip");
    assert.equal(chips.length, 2);
    await chips[0].dispatch("click");
    assert.deepEqual(app.focusCalls, ["s1"]);
    assert.equal(chips[1].disabled, true);
  });

  it("renders missing / error empty states without throwing", async () => {
    const trellis = { taskPath: ".trellis/tasks/t1", title: "T", phase: "execute" };

    const missing = loadDashboard({
      sessions: [bindingSession("s1", trellis)],
      detailResult: { status: "missing" },
    });
    await flush();
    await openDetail(missing);
    assert.equal(missing.overlay.hidden, false);
    assert.ok(textOf(missing.overlay).includes(i18n.en.dashboardTrellisDetailMissing));

    const errored = loadDashboard({
      sessions: [bindingSession("s1", trellis)],
      detailError: new Error("ipc boom"),
    });
    await flush();
    await openDetail(errored);
    assert.equal(errored.overlay.hidden, false);
    assert.ok(textOf(errored.overlay).includes(i18n.en.dashboardTrellisDetailError));
  });

  it("closes via the close button, ESC and backdrop semantics", async () => {
    const trellis = { taskPath: ".trellis/tasks/t1", title: "T", phase: "execute" };
    const app = loadDashboard({
      sessions: [bindingSession("s1", trellis)],
      detailResult: detailOk(),
    });
    await flush();

    // A key that is not Escape must not close the card.
    await openDetail(app);
    app.pressKey("Enter");
    assert.equal(app.overlay.hidden, false);

    app.pressKey("Escape");
    assert.equal(app.overlay.hidden, true, "ESC closes the open detail card");
    assert.equal(app.overlay.children.length, 0);

    // Close button closes too, and a second close is a no-op.
    await openDetail(app);
    await byClass(app.overlay, "trellis-detail-close")[0].dispatch("click");
    assert.equal(app.overlay.hidden, true);
    assert.deepEqual(app.detailCalls.map((p) => p.taskPath),
      [".trellis/tasks/t1", ".trellis/tasks/t1"],
      "every open is a fresh on-demand read");
  });

  it("keeps the card open across the one-second rebuild", async () => {
    const trellis = { taskPath: ".trellis/tasks/t1", title: "T", phase: "execute" };
    const app = loadDashboard({
      sessions: [bindingSession("s1", trellis)],
      detailResult: detailOk(),
    });
    await flush();
    await openDetail(app);
    app.tickRender();
    assert.equal(app.overlay.hidden, false, "the periodic rebuild must not close the card");
    assert.ok(textOf(app.overlay).includes("Title from disk"));
  });
});

// ── Task detail document tabs (renderer harness) ─────────────────────

const DOC_TASK = { taskPath: ".trellis/tasks/docs", title: "Docs", phase: "execute" };
const DOC_LIST = [
  { name: "prd.md", size: 120 },
  { name: "implement.md", size: 80 },
  { name: "research-notes.md", size: 40 },
];

function docOk(content, extra = {}) {
  return {
    status: "ok",
    name: "prd.md",
    size: Buffer.byteLength(content, "utf8"),
    truncated: false,
    content,
    ...extra,
  };
}

async function openDetailWithDocs(app, docResult) {
  await openDetail(app);
  return docResult;
}

async function clickTab(app, label) {
  const tab = byClass(app.overlay, "trellis-detail-tab")
    .find((el) => textOf(el) === label);
  assert.ok(tab, `tab ${label} must exist`);
  await tab.dispatch("click");
  await flush();
}

describe("dashboard trellis task detail doc tabs", () => {
  it("renders one tab per listed doc with overview active by default", async () => {
    const app = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
    });
    await flush();
    await openDetail(app);

    const tabs = byClass(app.overlay, "trellis-detail-tab");
    assert.deepEqual(tabs.map((el) => textOf(el)), [
      i18n.en.dashboardTrellisDetailTabOverview, "prd", "implement", "research-notes",
    ]);
    assert.equal(tabs[0].attributes["aria-selected"], "true");
    assert.deepEqual(app.docCalls, [], "no doc is read until its tab is opened");
    assert.ok(textOf(app.overlay).includes("step one"), "overview content stays visible");
  });

  it("fetches a doc once on tab click and renders the GFM subset", async () => {
    const md = [
      "# 标题",
      "",
      "| 列 | 值 |",
      "| --- | --- |",
      "| a | **b** |",
      "",
      "- [x] 完成",
      "- [ ] 待办",
      "",
      "```",
      "const x = 1;",
      "```",
    ].join("\n");
    const app = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
      docResult: docOk(md),
    });
    await flush();
    await openDetail(app);
    await clickTab(app, "prd");

    assert.deepEqual(app.docCalls, [{
      taskPath: ".trellis/tasks/docs",
      cwd: "/proj/s1",
      doc: "prd.md",
    }], "exactly one on-demand doc read with the frozen cwd");

    const doc = byClass(app.overlay, "trellis-detail-doc")[0];
    assert.ok(doc, "doc view renders");
    assert.equal(byClass(app.overlay, "md-h1").length, 1);
    assert.equal(byClass(app.overlay, "md-table").length, 1);
    assert.equal(byClass(app.overlay, "md-bold").length, 1);
    assert.equal(byClass(app.overlay, "md-task").length, 2);
    assert.equal(byClass(app.overlay, "md-code").length, 1);
    assert.ok(!textOf(app.overlay).includes("step one"), "overview content is tabbed away");

    // Reopening the same tab within the open card hits the cache only.
    await clickTab(app, i18n.en.dashboardTrellisDetailTabOverview);
    await clickTab(app, "prd");
    assert.equal(app.docCalls.length, 1, "cached doc is not re-fetched");
  });

  it("shows the truncation note for a truncated document", async () => {
    const app = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
      docResult: docOk("x", { truncated: true, size: 2 * 1024 * 1024 }),
    });
    await flush();
    await openDetail(app);
    await clickTab(app, "prd");
    assert.equal(byClass(app.overlay, "trellis-detail-doc-note").length, 1);
    assert.ok(textOf(app.overlay).includes(i18n.en.dashboardTrellisDocTruncated));
  });

  it("renders doc missing / error states and survives a hostile document", async () => {
    const hostile = [
      '<script>alert(1)</script>',
      '[x](javascript:alert(2))',
      '```',
      'unclosed <b>fence',
    ].join("\n");

    const missing = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
      docResult: { status: "missing" },
    });
    await flush();
    await openDetail(missing);
    await clickTab(missing, "prd");
    assert.ok(textOf(missing.overlay).includes(i18n.en.dashboardTrellisDocMissing));

    const boom = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
      docError: new Error("ipc boom"),
    });
    await flush();
    await openDetail(boom);
    await clickTab(boom, "prd");
    assert.ok(textOf(boom.overlay).includes(i18n.en.dashboardTrellisDocReadError));

    const evil = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
      docResult: docOk(hostile),
    });
    await flush();
    await openDetail(evil);
    await clickTab(evil, "prd");
    assert.equal(evil.overlay.hidden, false, "hostile markup never crashes the page");
    assert.ok(textOf(evil.overlay).includes("<script>alert(1)</script>"));
    assert.ok(textOf(evil.overlay).includes("x"), "link label survives without the URL");
  });

  it("collapses an h2 section on heading click and restores it on a second click", async () => {
    const md = "## Section A\ncontent one\n\n## Section B\ncontent two\n";
    const app = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
      docResult: docOk(md),
    });
    await flush();
    await openDetail(app);
    await clickTab(app, "prd");

    const headings = byClass(app.overlay, "md-heading-collapsible");
    assert.equal(headings.length, 2);
    const paragraphs = () => byClass(app.overlay, "md-p");
    assert.equal(paragraphs().length, 2);
    assert.equal(paragraphs()[0].hidden, false);

    await headings[0].dispatch("click");
    assert.ok(headings[0].classList.contains("md-collapsed"));
    assert.equal(headings[0].attributes["aria-expanded"], "false");
    assert.equal(paragraphs()[0].hidden, true, "section A's body hides");
    assert.equal(paragraphs()[1].hidden, false, "section B stays visible (next h2 boundary)");

    await headings[0].dispatch("click");
    assert.equal(paragraphs()[0].hidden, false, "second click restores the body");
  });

  it("drops the doc cache when the card closes and re-reads on reopen", async () => {
    const app = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
      docResult: docOk("# again\n"),
    });
    await flush();
    await openDetail(app);
    await clickTab(app, "prd");
    assert.equal(app.docCalls.length, 1);

    await byClass(app.overlay, "trellis-detail-close")[0].dispatch("click");
    await openDetail(app);
    await clickTab(app, "prd");
    assert.equal(app.docCalls.length, 2, "close clears the ephemeral doc cache");
  });

  it("re-opening a card without closing it also drops the previous doc cache", async () => {
    // Same overlay, no close click in between: opening must still reset the
    // per-card doc cache — a stale entry must not be reused across opens and
    // the fingerprint must not accumulate keys from a previous open.
    const app = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
      docResult: docOk("# fresh\n"),
    });
    await flush();
    await openDetail(app);
    await clickTab(app, "prd");
    assert.equal(app.docCalls.length, 1);

    await byClass(app.panel, "trellis-task-detail-btn")[0].dispatch("click");
    await flush();
    await clickTab(app, "prd");
    assert.equal(app.docCalls.length, 2,
      "openTrellisDetail clears the cache even without a close in between");
  });

  it("keeps the open doc tab and its collapse state stable across the one-second rebuild", async () => {
    const app = loadDashboard({
      sessions: [bindingSession("s1", DOC_TASK)],
      detailResult: detailOk({ docs: DOC_LIST }),
      docResult: docOk("## stay\nbody\n"),
    });
    await flush();
    await openDetail(app);
    await clickTab(app, "prd");
    // Collapse the h2 section, then let the periodic tick run: the unchanged
    // signature must skip the rebuild, so the collapsed DOM survives as-is.
    const heading = byClass(app.overlay, "md-heading-collapsible")[0];
    await heading.dispatch("click");
    const body = byClass(app.overlay, "md-p")[0];
    assert.equal(body.hidden, true);
    app.tickRender();
    assert.equal(app.overlay.hidden, false);
    assert.equal(byClass(app.overlay, "trellis-detail-doc").length, 1,
      "the doc view survives the periodic rebuild");
    assert.ok(heading.classList.contains("md-collapsed"),
      "collapse state survives the periodic rebuild");
    assert.equal(body.hidden, true, "the collapsed body stays hidden after the tick");
  });
});

// ── Parent/child grouping + archived section (renderer harness) ────────

function archivedTask(extra = {}) {
  return {
    taskPath: ".trellis/tasks/archive/2026-09/done-thing",
    title: "Done thing",
    createdAt: "2026-09-10",
    completedAt: "2026-09-20",
    completedAtMs: Date.parse("2026-09-20"),
    durationMs: 10 * 24 * 60 * 60 * 1000,
    cwd: "/proj/s1",
    ...extra,
  };
}

describe("dashboard trellis panel grouping (rendering)", () => {
  it("renders a live parent as a group header with indented children", async () => {
    const app = loadDashboard({
      sessions: [
        bindingSession("s1", {
          taskPath: ".trellis/tasks/parent",
          title: "Parent",
          phase: "execute",
          progress: { done: 1, total: 2 },
        }),
        bindingSession("s2", {
          taskPath: ".trellis/tasks/kid",
          title: "Kid",
          phase: "plan",
          progress: { done: 2, total: 3 },
          parent: "parent",
        }),
        bindingSession("s3", {
          taskPath: ".trellis/tasks/loner",
          title: "Loner",
          phase: "execute",
        }),
      ],
    });
    await flush();
    const rows = byClass(app.panel, "trellis-task-row");
    assert.equal(rows.length, 3);
    assert.ok(rows[0].classList.contains("trellis-task-row-group"), "parent row gets the group class");
    assert.ok(!rows[0].classList.contains("trellis-task-row-child"));
    assert.ok(rows[1].classList.contains("trellis-task-row-child"), "kid row is indented");
    assert.ok(!rows[2].classList.contains("trellis-task-row-child"), "loner stays flat");
    // The parent row shows the subtree summary instead of its own 1/2.
    assert.ok(textOf(app.panel).includes(
      i18n.en.dashboardTrellisGroupProgress.replace("{done}", "2").replace("{total}", "3")
    ));
    assert.ok(!textOf(app.panel).includes("1/2"), "own progress yields to the group summary");
  });
});

describe("dashboard trellis independent view", () => {





  it("switches views on the tab and loads roots, active tasks and archive in one round", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/s1"] },
      activeResult: {
        status: "ok",
        tasks: [{
          taskPath: ".trellis/tasks/t1",
          title: "Disk task",
          phase: "execute",
          progress: { done: 1, total: 2 },
          parent: null,
          cwd: "/proj/s1",
        }],
      },
      archiveResult: { status: "ok", tasks: [archivedTask()] },
    });
    await flush();
    assert.equal(app.view.hidden, true, "starts on the sessions view");
    assert.equal(app.headerExtras.hidden, false);
    assert.equal(app.archiveCalls.length, 0, "nothing is fetched before the switch");
    await switchToTrellis(app);
    assert.equal(app.view.hidden, false);
    assert.equal(app.content.classList.contains("hidden"), true);
    assert.equal(app.headerExtras.hidden, true, "session-only header extras hide");
    assert.equal(app.titleEl.textContent, i18n.en.dashboardViewTrellis);

    assert.equal(app.rootsCalls.length, 1);
    // v7 R5: the project bar is the primary control; the root list (full
    // paths + remove) lives behind the ⚙ drawer toggle.
    assert.equal(byClass(app.view, "trellis-root-row").length, 0, "the manage drawer starts closed");
    await byClass(app.view, "trellis-filter-manage")[0].dispatch("click");
    const rows = byClass(app.view, "trellis-root-row");
    assert.equal(rows.length, 1);
    assert.ok(textOf(rows[0]).includes("/proj/s1"));

    const activeRows = byClass(app.view, "trellis-split-row");
    assert.equal(activeRows.length, 1);
    assert.ok(textOf(app.view).includes("Disk task"));
    assert.ok(textOf(app.view).includes("1/2"));

    // Archive group starts COLLAPSED (v7): the collapsed head is a
    // button carrying the phase label + root count + refresh.
    const collapsedHeads = byClass(app.view, "trellis-split-group-head").filter(
      (el) => el.classList.contains("is-collapsed"),
    );
    assert.equal(collapsedHeads.length, 1,
      "the archive group renders one collapsed head");
    assert.ok(textOf(collapsedHeads[0]).includes(
      i18n.en.dashboardTrellisPhaseArchived
    ), "the collapsed head carries the phase label");
    assert.ok(textOf(collapsedHeads[0]).includes("1"),
      "the collapsed head carries the loaded count");
    assert.equal(
      byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-archived")).length,
      0,
      "no archived rows render while collapsed"
    );

    // Expanding the archive opens the newest month by default.
    await collapsedHeads[0].dispatch("click");
    await flush();
    const archivedRows = byClass(app.view, "trellis-split-row").filter(
      (el) => el.classList.contains("is-archived"),
    );
    assert.equal(archivedRows.length, 1,
      "the newest month is open by default after expanding");
    assert.ok(textOf(app.view).includes("Done thing"));
    assert.ok(textOf(app.view).includes(
      i18n.en.dashboardTrellisArchivedDurationDays.replace("{n}", "10")
    ));

    // Switching back restores the sessions chrome without refetching.
    await app.sessionsTab.dispatch("click");
    await flush();
    assert.equal(app.view.hidden, true);
    assert.equal(app.content.classList.contains("hidden"), false);
    assert.equal(app.headerExtras.hidden, false);
    assert.equal(app.titleEl.textContent, i18n.en.dashboardWindowTitle);
  });

  it("switches back to sessions when a quick round starts on the trellis view", async () => {
    // The numbered skeleton renders inside the sessions content area, so
    // every quick entry point (intent, pending round) must leave the
    // trellis view before painting digits.
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: [] },
      activeResult: { status: "ok", tasks: [] },
      archiveResult: { status: "ok", tasks: [] },
    });
    await flush();
    await switchToTrellis(app);
    assert.equal(app.view.hidden, false);

    app.quickIntent(1);
    await flush();
    assert.equal(app.view.hidden, true, "a quick round must land on the sessions view");
    assert.equal(app.content.classList.contains("hidden"), false);
    assert.equal(app.headerExtras.hidden, false);
  });

  it("shows the empty-state guide when no root is registered", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: [] },
      activeResult: { status: "ok", tasks: [] },
      archiveResult: { status: "ok", tasks: [] },
    });
    await flush();
    await switchToTrellis(app);
    assert.equal(byClass(app.view, "trellis-root-row").length, 0);
    assert.ok(textOf(app.view).includes(i18n.en.dashboardTrellisRootsEmptyHint));
    assert.ok(textOf(app.view).includes(i18n.en.dashboardTrellisActiveEmpty));
    assert.ok(textOf(app.view).includes(i18n.en.dashboardTrellisArchivedEmpty));
    assert.ok(byClass(app.view, "trellis-view-add-root").length,
      "the add-root button stays reachable in the empty state");
  });

  it("add uses the picker channel and remove passes the exact registered root", async () => {
    let registered = ["/proj/s1"];
    const app = loadDashboard({
      sessions: [],
      rootsResult: () => ({ status: "ok", roots: registered }),
      activeResult: { status: "ok", tasks: [] },
      archiveResult: { status: "ok", tasks: [] },
      addResult: { status: "ok", roots: ["/proj/s1", "/proj/two"] },
      removeResult: { status: "ok", roots: [] },
    });
    await flush();
    await switchToTrellis(app);

    await byClass(app.view, "trellis-filter-manage")[0].dispatch("click");
    await byClass(app.view, "trellis-view-add-root")[0].dispatch("click");
    registered = ["/proj/s1", "/proj/two"];
    await flush();
    assert.equal(app.addRootCalls.length, 1, "add never carries a path from the renderer");
    assert.equal(app.rootsCalls.length, 2, "a successful add refreshes the roots list");

    await byClass(app.view, "trellis-root-remove")[0].dispatch("click");
    await flush();
    assert.deepEqual(app.removeRootCalls, ["/proj/s1"],
      "remove passes the row's exact registered root string");
  });

  it("opens the shared detail overlay from an archived row", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/s1"] },
      activeResult: { status: "ok", tasks: [] },
      archiveResult: { status: "ok", tasks: [archivedTask()] },
      detailResult: detailOk({ archived: true, phase: "done", completedAt: "2026-09-20" }),
    });
    await flush();
    await switchToTrellis(app);
    // v7: archive group starts collapsed — expand it, then click the row.
    const archiveHead = byClass(app.view, "trellis-split-group-head").find(
      (el) => el.classList.contains("is-collapsed")
    );
    await archiveHead.dispatch("click");
    await flush();
    await byClass(app.view, "trellis-split-row")[0].dispatch("click");
    await flush();
    assert.deepEqual(app.detailCalls, [{
      taskPath: ".trellis/tasks/archive/2026-09/done-thing",
      cwd: "/proj/s1",
    }], "the archive row's taskPath and cwd feed the detail read");
    // v7: the detail card renders in the embedded split pane; the shared
    // overlay host stays hidden.
    assert.equal(app.overlay.hidden, true);
    assert.ok(textOf(app.view).includes("Title from disk"));
    assert.equal(byClass(app.view, "trellis-session-chip").length, 0,
      "archived tasks have no bound sessions");
  });

  it("opens the detail overlay from an active row without session chips", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/s1"] },
      activeResult: {
        status: "ok",
        tasks: [{
          taskPath: ".trellis/tasks/t1",
          title: "Disk task",
          phase: "plan",
          progress: null,
          parent: null,
          cwd: "/proj/s1",
        }],
      },
      archiveResult: { status: "ok", tasks: [] },
      detailResult: detailOk(),
    });
    await flush();
    await switchToTrellis(app);
    // v7: row click selects the task — the detail card opens embedded in
    // the split pane (no overlay, no per-row ⓘ button anymore).
    await byClass(app.view, "trellis-split-row")[0].dispatch("click");
    await flush();
    assert.deepEqual(app.detailCalls, [{ taskPath: ".trellis/tasks/t1", cwd: "/proj/s1" }]);
    assert.equal(app.overlay.hidden, true);
    assert.ok(textOf(app.view).includes("Disk task"));
  });

  it("shows archive and active error states with retry buttons that refetch", async () => {
    let archiveFailing = true;
    let activeFailing = true;
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/s1"] },
      activeResult: () => {
        if (activeFailing) throw new Error("boom");
        return { status: "ok", tasks: [] };
      },
      archiveResult: () => {
        if (archiveFailing) throw new Error("boom");
        return { status: "ok", tasks: [archivedTask()] };
      },
    });
    await flush();
    await switchToTrellis(app);
    assert.ok(textOf(app.view).includes(i18n.en.dashboardTrellisActiveError));
    assert.ok(textOf(app.view).includes(i18n.en.dashboardTrellisArchivedError));
    // v7: retry buttons live inline in the group heads — the first one
    // belongs to the first (non-done) group, the last one to the archive.
    const retries = byClass(app.view, "trellis-split-retry");
    assert.ok(retries.length >= 2);
    const retry = retries[retries.length - 1];

    archiveFailing = false;
    activeFailing = false;
    await retry.dispatch("click");
    await flush();
    assert.equal(app.archiveCalls.length, 2);
    // The archive group starts collapsed — expand it to see the healed row.
    const archiveHead = byClass(app.view, "trellis-split-group-head").find(
      (el) => el.classList.contains("is-collapsed"),
    );
    await archiveHead.dispatch("click");
    await flush();
    assert.equal(
      byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-archived")).length,
      1,
    );
    // The archive retry only heals the archive list; the active list has
    // its own retry in the first group head.
    await byClass(app.view, "trellis-split-retry")[0].dispatch("click");
    await flush();
    assert.ok(!textOf(app.view).includes(i18n.en.dashboardTrellisActiveError));
  });

  it("collapses and re-expands month groups, and the refresh button refetches", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/s1"] },
      activeResult: { status: "ok", tasks: [] },
      archiveResult: { status: "ok", tasks: [archivedTask()] },
    });
    await flush();
    await switchToTrellis(app);
    // v7: the archive group starts collapsed — expand it first.
    let archiveHead = byClass(app.view, "trellis-split-group-head").find(
      (el) => el.classList.contains("is-collapsed"),
    );
    await archiveHead.dispatch("click");
    await flush();
    const month = byClass(app.view, "trellis-split-month-head")[0];
    assert.equal(month.attributes["aria-expanded"], "true", "newest month starts open");

    await month.dispatch("click");
    assert.equal(byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-archived")).length, 0,
      "collapsing the month hides its rows");
    await byClass(app.view, "trellis-split-month-head")[0].dispatch("click");
    assert.equal(byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-archived")).length, 1);

    // The archive group head carries its own ↻ refresh button.
    const archiveRefresh = byClass(app.view, "trellis-split-refresh")[0];
    await archiveRefresh.dispatch("click");
    await flush();
    assert.equal(app.archiveCalls.length, 2);
    assert.equal(byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-archived")).length, 1,
      "the refresh keeps the month open");
  });

  it("renders coarse minute/hour durations and — for zero durations", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/s1"] },
      activeResult: { status: "ok", tasks: [] },
      archiveResult: { status: "ok", tasks: [
        archivedTask({ title: "Quick", durationMs: 20 * 60 * 1000 }),
        archivedTask({ title: "Hours", durationMs: 3 * 60 * 60 * 1000 }),
        archivedTask({ title: "SameDay", durationMs: 0 }),
        archivedTask({ title: "Moved", completedAt: null }),
      ] },
    });
    await flush();
    await switchToTrellis(app);
    // v7: expand the collapsed archive group to render month rows.
    const archiveHead = byClass(app.view, "trellis-split-group-head").find(
      (el) => el.classList.contains("is-collapsed"),
    );
    await archiveHead.dispatch("click");
    await flush();
    const text = textOf(app.view);
    assert.ok(text.includes(i18n.en.dashboardTrellisArchivedDurationMinutes.replace("{n}", "20")));
    assert.ok(text.includes(i18n.en.dashboardTrellisArchivedDurationHours.replace("{n}", "3")));
    assert.ok(text.includes("—"));
    // mtime fallback label when the stored completedAt is unusable —
    // rendered in the app language (en here), never the system locale.
    assert.ok(text.includes(
      new Date(Date.parse("2026-09-20")).toLocaleDateString("en")
    ), "mtime-completed tasks render a localized date");
  });

  it("nests active children under their parent and toggles the subtree with the caret", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/s1"] },
      activeResult: { status: "ok", tasks: [
        {
          taskPath: ".trellis/tasks/parent", title: "Parent", phase: "execute",
          progress: null, parent: null, cwd: "/proj/s1",
        },
        {
          taskPath: ".trellis/tasks/kid", title: "Kid", phase: "plan",
          progress: { done: 1, total: 2 }, parent: "parent", cwd: "/proj/s1",
        },
      ] },
      archiveResult: { status: "ok", tasks: [] },
    });
    await flush();
    await switchToTrellis(app);

    // Default: an active branch starts expanded — the kid row renders
    // indented (is-child modifier) after the parent row.
    const kidRows = byClass(app.view, "trellis-split-row").filter(
      (el) => el.classList.contains("is-child"),
    );
    assert.equal(kidRows.length, 1);
    assert.ok(textOf(kidRows[0]).includes("Kid"));
    const carets = byClass(app.view, "trellis-split-caret");
    assert.equal(carets.length, 1, "only the branch row carries a caret");
    assert.equal(carets[0].attributes["aria-expanded"], "true");

    // v7: the caret is the only fold affordance; the branch row itself is
    // selectable like any other row (split view renders into the pane).
    await carets[0].dispatch("click");
    assert.equal(
      byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-child")).length,
      0,
      "folding the branch hides its child rows",
    );
    assert.equal(byClass(app.view, "trellis-split-caret")[0].attributes["aria-expanded"], "false");

    await byClass(app.view, "trellis-split-caret")[0].dispatch("click");
    assert.equal(
      byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-child")).length,
      1,
      "the caret alone re-expands the subtree",
    );

    // A leaf row keeps the v2 click semantics: render its detail.
    const leafRow = byClass(app.view, "trellis-split-row").filter(
      (el) => el.classList.contains("is-child"),
    )[0];
    await leafRow.dispatch("click");
    assert.deepEqual(app.detailCalls, [{ taskPath: ".trellis/tasks/kid", cwd: "/proj/s1" }]);
  });

  it("starts archive branches collapsed and wires the expand/collapse-all tools", async () => {
    const app = loadDashboard({
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/kid", title: "Kid", parent: "a", cwd: "/proj/one" },
      ] },
      archiveResult: { status: "ok", tasks: [
        archivedTask({ taskPath: ".trellis/tasks/archive/2026-09/done-thing", title: "Done thing", cwd: "/proj/one" }),
      ] },
    });
    await flush();
    await switchToTrellis(app);

    const doneHead = () => {
      const heads = byClass(app.view, "trellis-split-group-head");
      return heads[heads.length - 1];
    };
    // v7 ships the archived group folded: the head carries the modifier and
    // no archived row is materialized yet.
    assert.ok(doneHead().classList.contains("is-collapsed"));
    assert.equal(
      byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-archived")).length,
      0,
      "a collapsed archived group renders no rows",
    );
    // ↻ refresh is a sibling of the fold toggle, never nested inside it.
    assert.equal(byClass(doneHead(), "trellis-split-refresh").length, 1);

    // The foot bar owns the bulk tools; they drive the same collapsedPaths
    // set the per-row carets write to.
    const tools = byClass(app.view, "trellis-split-foot-btn");
    assert.deepEqual(tools.map(textOf), [
      i18n.en.dashboardTrellisTreeExpandAll,
      i18n.en.dashboardTrellisTreeCollapseAll,
    ]);

    const childRows = () =>
      byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-child"));
    assert.equal(childRows().length, 1, "branches start expanded");

    await tools[1].dispatch("click");
    assert.equal(childRows().length, 0, "collapse-all folds every branch");

    await tools[0].dispatch("click");
    assert.equal(childRows().length, 1, "expand-all restores every branch");
  });

  it("shows an archived subtask under its still-active parent and keeps it out of the archive months", async () => {
    const app = loadDashboard({
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/live-parent", title: "Live parent", cwd: "/proj/one" },
      ] },
      archiveResult: { status: "ok", tasks: [
        archivedTask({ taskPath: ".trellis/tasks/archive/2026-09/done-kid", title: "Done kid", parent: "live-parent" }),
        archivedTask({ taskPath: ".trellis/tasks/archive/2026-08/old-loner", title: "Old loner" }),
      ] },
    });
    await flush();
    await switchToTrellis(app);

    const heads = byClass(app.view, "trellis-split-group-head");
    await heads[heads.length - 1].dispatch("click");

    const rows = byClass(app.view, "trellis-split-row");
    const kid = rows.find((el) => textOf(el).includes("Done kid"));
    assert.ok(kid, "the adopted archived task renders");
    assert.ok(kid.classList.contains("is-child"), "it nests under its still-active parent");
    assert.ok(
      rows[rows.indexOf(kid) - 1].classList.contains("is-parent"),
      "…and sits directly under the parent row",
    );

    // Only the orphan owns a month sub-group: the adopted task left its own.
    assert.deepEqual(byClass(app.view, "trellis-split-month-label").map(textOf), ["2026-08 · 1"]);
    assert.equal(byClass(app.view, "trellis-split-month-head").length, 1);
  });
});

describe("dashboard trellis project filter (rendering)", () => {
  function activeTask(extra = {}) {
    return {
      taskPath: ".trellis/tasks/t",
      title: "Task",
      phase: "execute",
      progress: null,
      parent: null,
      cwd: "/proj/one",
      ...extra,
    };
  }

  async function loadTrellisView(overrides = {}) {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/one", "/proj/two"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/b", title: "Task B", cwd: "/proj/two/deep" },
      ] },
      archiveResult: { status: "ok", tasks: [
        archivedTask({ title: "Done one", cwd: "/proj/one" }),
        archivedTask({ title: "Done two", cwd: "/proj/two" }),
      ] },
      ...overrides,
    });
    await flush();
    await app.trellisTab.dispatch("click");
    await flush();
    return app;
  }

  it("merges projects under All with per-root chips, counts and row origin tags", async () => {
    const app = loadDashboard({
      rootsResult: { status: "ok", roots: ["/proj/one", "/proj/two/deep", "/proj/empty"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/b", title: "Task B", cwd: "/proj/two/deep" },
      ] },
      archiveResult: { status: "ok", tasks: [
        archivedTask({ taskPath: ".trellis/tasks/archive/2026-09/done-one", title: "Done one", cwd: "/proj/one" }),
      ] },
    });
    await flush();
    await switchToTrellis(app);

    const chips = byClass(app.view, "trellis-filter-chip");
    assert.equal(chips.length, 4, "All + one chip per registered root");
    assert.deepEqual(
      chips.map((el) => textOf(byClass(el, "trellis-filter-chip-label")[0])),
      [i18n.en.dashboardTrellisFilterAll, "one", "deep", "empty"],
    );
    assert.deepEqual(
      chips.map((el) => textOf(byClass(el, "trellis-filter-count")[0])),
      ["2", "1", "1", "0"],
      "counts are per-root live-task totals; the empty root stays at 0",
    );
    assert.equal(chips[0].attributes["aria-pressed"], "true", "All is the default selection");

    // Rows tag their origin only while several projects are merged.
    assert.deepEqual(byClass(app.view, "trellis-task-project").map(textOf), ["one", "deep"]);
    assert.equal(byClass(app.view, "trellis-split-row").length, 2, "All merges both live lists");

    // The archived group follows the same selection and counts its rows.
    const doneHead = () => {
      const heads = byClass(app.view, "trellis-split-group-head");
      return heads[heads.length - 1];
    };
    assert.equal(textOf(byClass(doneHead(), "trellis-split-group-count")[0]), "1");
  });

  it("selecting a chip narrows both lists and hides the origin tags", async () => {
    const app = loadDashboard({
      rootsResult: { status: "ok", roots: ["/proj/one", "/proj/two"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/b", title: "Task B", cwd: "/proj/two" },
      ] },
      archiveResult: { status: "ok", tasks: [
        archivedTask({ taskPath: ".trellis/tasks/archive/2026-09/done-one", title: "Done one", cwd: "/proj/one" }),
        archivedTask({ taskPath: ".trellis/tasks/archive/2026-09/done-two", title: "Done two", cwd: "/proj/two" }),
      ] },
    });
    await flush();
    await switchToTrellis(app);

    await byClass(app.view, "trellis-filter-chip")[1].dispatch("click");
    const rows = () => byClass(app.view, "trellis-split-row");
    assert.equal(rows().length, 1);
    assert.ok(textOf(rows()[0]).includes("Task A"));
    assert.ok(!textOf(app.view).includes("Task B"), "tasks owned by another root disappear");
    assert.equal(
      byClass(app.view, "trellis-task-project").length,
      0,
      "the single-project view already names the project in the filter title",
    );
    assert.equal(textOf(byClass(app.view, "trellis-filter-title")[0]), "one");

    const chips = byClass(app.view, "trellis-filter-chip");
    assert.equal(chips[1].attributes["aria-pressed"], "true");
    assert.equal(chips[0].attributes["aria-pressed"], "false");

    // The archived group honors the same selection.
    const doneHead = () => {
      const heads = byClass(app.view, "trellis-split-group-head");
      return heads[heads.length - 1];
    };
    await doneHead().dispatch("click");
    assert.equal(textOf(byClass(doneHead(), "trellis-split-group-count")[0]), "1");
    const archived = rows().filter((el) => el.classList.contains("is-archived"));
    assert.equal(archived.length, 1);
    assert.ok(textOf(archived[0]).includes("Done one"));
    assert.ok(!textOf(app.view).includes("Done two"));

    // Back to All: the merged view returns untouched (memory state only).
    await byClass(app.view, "trellis-filter-chip")[0].dispatch("click");
    assert.equal(
      rows().filter((el) => !el.classList.contains("is-archived")).length,
      2,
      "both live lists come back",
    );
    assert.equal(
      rows()
        .filter((el) => !el.classList.contains("is-archived"))
        .reduce((sum, el) => sum + byClass(el, "trellis-task-project").length, 0),
      2,
      "every live row tags its project again",
    );
  });

  it("dims empty-project chips but keeps them clickable into the empty view", async () => {
    const app = loadDashboard({
      rootsResult: { status: "ok", roots: ["/proj/full", "/proj/void"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", cwd: "/proj/full" },
      ] },
      archiveResult: { status: "ok", tasks: [] },
    });
    await flush();
    await switchToTrellis(app);

    const chips = byClass(app.view, "trellis-filter-chip");
    assert.equal(chips.length, 3);
    assert.ok(chips[2].classList.contains("trellis-filter-chip-empty"),
      "0 active + 0 archived dims the chip");
    assert.equal(chips[2].disabled, false, "dimmed but still clickable");

    await chips[2].dispatch("click");
    assert.equal(byClass(app.view, "trellis-task-row").length, 0);
    assert.ok(textOf(app.view).includes(i18n.en.dashboardTrellisActiveEmpty));
    assert.ok(textOf(app.view).includes(i18n.en.dashboardTrellisArchivedEmpty));
  });

  it("falls back to All when the selected root gets unregistered", async () => {
    let registered = ["/proj/one", "/proj/two"];
    const app = loadDashboard({
      rootsResult: () => ({ status: "ok", roots: registered }),
      removeResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/b", title: "Task B", cwd: "/proj/two" },
      ] },
      archiveResult: { status: "ok", tasks: [] },
    });
    await flush();
    await switchToTrellis(app);

    await byClass(app.view, "trellis-filter-chip")[2].dispatch("click");
    assert.equal(byClass(app.view, "trellis-split-row").length, 1);

    // Removing the selected root refreshes the roots list; the stale
    // selection must not silently filter everything out. Removal lives in
    // the ⚙ manage drawer (v7 R5).
    registered = ["/proj/one"];
    await byClass(app.view, "trellis-filter-manage")[0].dispatch("click");
    await byClass(app.view, "trellis-root-remove")[1].dispatch("click");
    await flush();
    assert.deepEqual(app.removeRootCalls, ["/proj/two"]);
    assert.equal(
      byClass(app.view, "trellis-split-row").length,
      2,
      "an unregistered selection falls back to the merged All view",
    );
    assert.equal(
      byClass(app.view, "trellis-filter-chip").length,
      2,
      "the chip row follows the shrunken roots list",
    );
  });

  it("disambiguates duplicate basenames in chips and row tags", async () => {
    const app = loadDashboard({
      rootsResult: { status: "ok", roots: ["/a/one/proj", "/b/two/proj"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", cwd: "/a/one/proj" },
        { taskPath: ".trellis/tasks/b", title: "Task B", cwd: "/b/two/proj" },
      ] },
      archiveResult: { status: "ok", tasks: [] },
    });
    await flush();
    await switchToTrellis(app);

    const chips = byClass(app.view, "trellis-filter-chip");
    assert.ok(textOf(chips[1]).includes("proj (one)"));
    assert.ok(textOf(chips[2]).includes("proj (two)"));
    const tags = byClass(app.view, "trellis-task-project");
    assert.equal(tags.length, 2);
    assert.ok(textOf(tags[0]).includes("proj (one)"));
    assert.ok(textOf(tags[1]).includes("proj (two)"));
  });
});

describe("dashboard trellis v7 single view (R5–R7)", () => {
  const priorityTask = (extra = {}) => ({
    taskPath: ".trellis/tasks/p0-task",
    title: "Hotfix",
    phase: "execute",
    progress: null,
    parent: null,
    priority: "p0",
    cwd: "/proj/one",
    ...extra,
  });

  it("badges a P0 task on its row and on the detail card", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [priorityTask()] },
      archiveResult: { status: "ok", tasks: [] },
      detailResult: detailOk({ priority: "p0" }),
    });
    await flush();
    await switchToTrellis(app);

    const chip = byClass(app.view, "trellis-priority");
    assert.equal(chip.length, 1);
    assert.ok(chip[0].classList.contains("pri-p0"), "the rank travels in the modifier class");
    assert.equal(textOf(chip[0]), "P0");
    assert.ok(byClass(app.view, "trellis-split-row-sub").length > 0, "the chip rides the sub line");

    await byClass(app.view, "trellis-split-row")[0].dispatch("click");
    await flush();
    // v7 renders the detail inside the split pane (the overlay stays for
    // the session-driven cards only).
    const pane = byClass(app.view, "trellis-split-detail")[0];
    const detailChip = byClass(pane, "trellis-priority");
    assert.equal(detailChip.length, 1);
    assert.ok(detailChip[0].classList.contains("pri-p0"));
    assert.ok(detailChip[0].classList.contains("trellis-detail-meta-item"));
  });

  it("renders no badge for tasks without a usable priority", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "A", phase: "plan", progress: null, parent: null, cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/b", title: "B", phase: "plan", progress: null, parent: null, priority: "urgent", cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/c", title: "C", phase: "plan", progress: null, parent: null, priority: null, cwd: "/proj/one" },
      ] },
      archiveResult: { status: "ok", tasks: [] },
    });
    await flush();
    await switchToTrellis(app);
    assert.equal(
      byClass(app.view, "trellis-priority").length,
      0,
      "an unrankable value must not be rendered as a badge",
    );
  });

  it("folds the root list behind the project bar's manage toggle", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/one", "/proj/two"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "A", phase: "plan", progress: null, parent: null, cwd: "/proj/one" },
      ] },
      archiveResult: { status: "ok", tasks: [] },
    });
    await flush();
    await switchToTrellis(app);

    // The bar is primary: title + chips + spec entry + ⚙.
    assert.equal(textOf(byClass(app.view, "trellis-filter-title")[0]), i18n.en.dashboardTrellisFilterAll);
    assert.equal(byClass(app.view, "trellis-filter-chip").length, 3);
    assert.equal(byClass(app.view, "trellis-spec-open").length, 1);
    const manage = byClass(app.view, "trellis-filter-manage");
    assert.equal(manage.length, 1);
    assert.equal(manage[0].attributes["aria-expanded"], "false");

    // The full-path list (and its remove buttons) stays out of the way.
    assert.equal(byClass(app.view, "trellis-root-row").length, 0);
    assert.equal(byClass(app.view, "trellis-roots-section").length, 0);

    await manage[0].dispatch("click");
    const rows = byClass(app.view, "trellis-root-row");
    assert.equal(rows.length, 2, "⚙ reveals the manage drawer");
    assert.ok(textOf(rows[0]).includes("/proj/one"));
    assert.equal(byClass(app.view, "trellis-root-remove").length, 2);
    assert.equal(byClass(app.view, "trellis-filter-manage")[0].attributes["aria-expanded"], "true");

    await byClass(app.view, "trellis-filter-manage")[0].dispatch("click");
    assert.equal(byClass(app.view, "trellis-root-row").length, 0, "⚙ folds it away again");
  });

  it("opens the spec map from the project bar and marks unfilled docs with reference counts", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [] },
      archiveResult: { status: "ok", tasks: [] },
      specResult: { status: "ok", truncated: false, files: [
        { group: "frontend", relPath: "frontend/index.md", filled: true, lines: 12, refCount: 3 },
        { group: "guides", relPath: "guides/index.md", filled: false, lines: 0, refCount: 0 },
        { group: "guides", relPath: "guides/legacy.md", filled: null, lines: null, refCount: 1 },
      ] },
    });
    await flush();
    await switchToTrellis(app);

    assert.deepEqual(app.specCalls, [], "nothing is fetched before the entry is clicked");
    await byClass(app.view, "trellis-spec-open")[0].dispatch("click");
    await flush();
    assert.deepEqual(app.specCalls, [{ root: "/proj/one" }]);

    const files = byClass(app.specOverlay, "trellis-spec-file-button");
    assert.equal(files.length, 3);
    assert.deepEqual(
      files.map((el) => textOf(byClass(el, "trellis-spec-file-name")[0])),
      ["frontend/index.md", "guides/index.md", "guides/legacy.md"],
    );

    // Filled docs show a body-line count, never a "filled" badge.
    assert.equal(textOf(byClass(files[0], "trellis-spec-file-lines")[0]), "12 lines");
    assert.equal(byClass(files[0], "trellis-spec-file-empty").length, 0);
    assert.equal(textOf(byClass(files[0], "trellis-spec-file-refs")[0]), "⛓3");

    // Heading-only docs read as empty instead of looking filled.
    assert.ok(files[1].classList.contains("is-empty"));
    assert.equal(
      textOf(byClass(files[1], "trellis-spec-file-empty")[0]),
      i18n.en.dashboardTrellisSpecEmptyDoc,
    );
    assert.equal(byClass(files[1], "trellis-spec-file-refs").length, 0);

    // A doc that could not be read stays neutral: no empty badge, no count.
    assert.ok(!files[2].classList.contains("is-empty"));
    assert.equal(byClass(files[2], "trellis-spec-file-empty").length, 0);
    assert.equal(byClass(files[2], "trellis-spec-file-lines").length, 0);
    assert.equal(textOf(byClass(files[2], "trellis-spec-file-refs")[0]), "⛓1");
  });
});
