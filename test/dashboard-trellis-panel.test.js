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

// Non-enumerable so a stray deepEqual/JSON.stringify on an element can
// never walk the whole tree back up through its parents (cycles).
function linkParent(child, parent) {
  if (!child || typeof child !== "object") return;
  Object.defineProperty(child, "parentNode", {
    value: parent, writable: true, configurable: true, enumerable: false,
  });
}

// Selector subset the dashboard renderer actually uses: `.class`,
// `.class[attr]`, `.class[attr="value"]` and the descendant combinator.
// `data-*` attributes are matched through dataset too, because FakeElement
// does not mirror dataset writes into `attributes` the way the real DOM
// does. Unknown syntax simply does not match (a silent miss is fine here —
// the empty result is what a wrong selector produces in the browser too).
function selectorCompoundMatches(el, compound) {
  if (!el || !el.classList) return false;
  for (const cls of compound.match(/\.[A-Za-z0-9_-]+/g) || []) {
    if (!el.classList.contains(cls.slice(1))) return false;
  }
  for (const [, name, value] of compound.matchAll(/\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]/g)) {
    const camel = name.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const actual = el.attributes[name] !== undefined
      ? el.attributes[name]
      : el.dataset[camel];
    if (actual === undefined) return false;
    if (value !== undefined && String(actual) !== value) return false;
  }
  return true;
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
  appendChild(child) {
    this.children.push(child);
    linkParent(child, this);
    return child;
  }
  replaceChildren(...children) {
    this.children = children;
    for (const child of children) linkParent(child, this);
  }
  // 09-25: the fold/keyboard paths (isTrellisRowVisible, applySubtreeFold,
  // moveTrellisSplitSelection) need parentNode + querySelectorAll to run
  // at all. Without them the tests silently took the rebuild fallback —
  // "consistent" with the broken-vs-correct split but never exercising it.
  querySelectorAll(selector) {
    const chain = String(selector).trim().split(/\s+/);
    const last = chain[chain.length - 1];
    return descendants(this).filter((el) => {
      if (!selectorCompoundMatches(el, last)) return false;
      let node = el.parentNode || null;
      for (let i = chain.length - 2; i >= 0; i--) {
        let found = false;
        while (node) {
          if (selectorCompoundMatches(node, chain[i])) { found = true; node = node.parentNode || null; break; }
          node = node.parentNode || null;
        }
        if (!found) return false;
      }
      return true;
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
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

// The v7 contract keeps `is-collapsed` on the group HEAD div, while the
// click handler lives on the inner .trellis-split-group-toggle button
// (UI redesign 09-24 Batch B). Dispatch at the toggle when present.
function groupHeadToggle(head) {
  return byClass(head, "trellis-split-group-toggle")[0] || head;
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
  networkOverviewResult = null,
  networkOverviewError = null,
} = {}) {
  const elements = new Map(
    [
      "content", "title", "count", "quickBanner", "quotaSummary", "trellisPanel",
      "trellisDetailOverlay", "trellisView", "viewSessionsTab", "viewTrellisTab",
      "sessionsHeaderExtras",
      // v7 R6 spec map overlay (its file list / doc pane are built inline).
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
  const networkOverviewCalls = [];
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
    getTrellisNetworkOverview: async (payload) => {
      networkOverviewCalls.push(payload);
      if (networkOverviewError) throw networkOverviewError;
      return typeof networkOverviewResult === "function" ? networkOverviewResult(payload) : networkOverviewResult;
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
    view: elements.get("trellisView"),
    // Renderer module scope, for the pure fold helpers (applySubtreeFold /
    // isTrellisRowVisible) — they are DOM-shape logic, not DOM plumbing.
    sandbox: context,
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
    networkOverviewCalls,
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
    // Root management moved to Settings → Trellis (09-25): no manage
    // drawer, no root rows in the view — chips are the primary UI.
    assert.equal(byClass(app.view, "trellis-root-row").length, 0);
    assert.equal(byClass(app.view, "trellis-filter-manage").length, 0);

    const activeRows = byClass(app.view, "trellis-split-row");
    assert.equal(activeRows.length, 1);
    assert.ok(textOf(app.view).includes("Disk task"));
    assert.ok(textOf(app.view).includes("1/2"));

    // Archive group starts COLLAPSED (v7): the collapsed head is a
    // button carrying the phase label + root count + refresh. The spec /
    // relations groups (v7 R10) also start collapsed — three heads total,
    // the DONE one is found by its phase label.
    const collapsedHeads = byClass(app.view, "trellis-split-group-head").filter(
      (el) => el.classList.contains("is-collapsed"),
    );
    assert.equal(collapsedHeads.length, 3,
      "done + spec + relations groups each render one collapsed head");
    const doneHead = collapsedHeads.find((el) =>
      textOf(el).includes(i18n.en.dashboardTrellisPhaseArchived)
    );
    assert.ok(doneHead, "the collapsed done head carries the phase label");
    assert.ok(textOf(doneHead).includes("1"),
      "the collapsed head carries the loaded count");
    assert.equal(
      byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-archived")).length,
      0,
      "no archived rows render while collapsed"
    );

    // Expanding the archive opens the newest month by default.
    await groupHeadToggle(doneHead).dispatch("click");
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
    // 09-25: the split-view empty hints (ActiveEmpty/ArchivedEmpty) are
    // retired — the phase heads' own 0-counts communicate emptiness. The
    // i18n keys themselves were deleted, so nothing to assert here.
    assert.ok(byClass(app.view, "trellis-view-add-root").length === 0,
      "no add-root button in the view — Settings owns add/remove");
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
    await groupHeadToggle(archiveHead).dispatch("click");
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
    await groupHeadToggle(archiveHead).dispatch("click");
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
    await groupHeadToggle(archiveHead).dispatch("click");
    await flush();
    const monthToggle = byClass(app.view, "trellis-split-month-toggle")[0];
    assert.equal(monthToggle.attributes["aria-expanded"], "true", "newest month starts open");

    await monthToggle.dispatch("click");
    // 09-25 LOCAL folds: rows stay mounted and carry the fold class — the
    // old "count rows" check became "count rows WITHOUT the fold class".
    assert.equal(byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-archived") && !el.classList.contains("is-month-folded")).length, 0,
      "collapsing the month hides its rows");
    await byClass(app.view, "trellis-split-month-toggle")[0].dispatch("click");
    assert.equal(byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-archived") && !el.classList.contains("is-month-folded")).length, 1);

    // The archive group head carries its own ↻ refresh button.
    // Global refresh lives in the chip bar (09-25): one ↻ refreshes
    // roots + active + archive at once — archive head no longer owns it.
    const refresh = byClass(app.view, "trellis-filter-refresh")[0];
    assert.ok(refresh, "global refresh button in chip bar");
    await refresh.dispatch("click");
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
    await groupHeadToggle(archiveHead).dispatch("click");
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
    const branchRow = byClass(app.view, "trellis-split-row").find(
      (el) => el.dataset.hasChildren === "true",
    );

    // v7: the caret is the only fold affordance; the branch row itself is
    // selectable like any other row (split view renders into the pane).
    await carets[0].dispatch("click");
    assert.equal(
      byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-child") && !el.classList.contains("is-subtree-folded")).length,
      0,
      "folding the branch hides its child rows",
    );
    assert.equal(byClass(app.view, "trellis-split-caret")[0].attributes["aria-expanded"], "false");
    // 09-25 review: the "hidden state" assertion above is green on BOTH
    // paths — a full rebuild re-applies the fold class too. Only node
    // identity proves the LOCAL path ran (and that the CSS caret
    // transition got a surviving element with a from→to pair).
    assert.equal(
      byClass(app.view, "trellis-split-row").find((el) => el.classList.contains("is-child")),
      kidRows[0],
      "the child row node must be REUSED, not rebuilt",
    );
    assert.equal(byClass(app.view, "trellis-split-caret")[0], carets[0], "the caret node is reused too");
    assert.ok(branchRow.classList.contains("is-collapsed"),
      "caret rotation anchors on the ROW (.trellis-split-row.is-collapsed)");
    // …and the 1s tick must not mistake the local fold for new data and
    // rebuild the tree: the structural signature has to stay in sync or the
    // local path's work is thrown away one tick later.
    app.tickRender();
    assert.equal(
      byClass(app.view, "trellis-split-row").find((el) => el.classList.contains("is-child")),
      kidRows[0],
      "the 1s tick keeps the folded row mounted (no rebuild after a local fold)",
    );

    await byClass(app.view, "trellis-split-caret")[0].dispatch("click");
    assert.equal(
      byClass(app.view, "trellis-split-row").filter((el) => el.classList.contains("is-child")).length,
      1,
      "the caret alone re-expands the subtree",
    );
    assert.equal(
      byClass(app.view, "trellis-split-row").find((el) => el.classList.contains("is-child")),
      kidRows[0],
      "the same child node comes back on expand",
    );
    assert.ok(!branchRow.classList.contains("is-collapsed"),
      "expanding clears the row's caret rotation class");

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
      // v7 R10: spec + relations groups render BELOW the phase groups, so
      // "last head" is no longer DONE — match by the archived phase label.
      return byClass(app.view, "trellis-split-group-head").find((el) =>
        textOf(el).includes(i18n.en.dashboardTrellisPhaseArchived)
      );
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
    // Global refresh moved to the chip bar (09-25) — the archive head
    // keeps only its fold toggle.
    assert.equal(byClass(doneHead(), "trellis-split-refresh").length, 0);

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
    const branchRow = byClass(app.view, "trellis-split-row").find(
      (el) => el.dataset.hasChildren === "true",
    );
    const keptChild = childRows()[0];

    await tools[1].dispatch("click");
    assert.equal(childRows().filter((el) => !el.classList.contains("is-subtree-folded")).length, 0, "collapse-all folds every branch");
    assert.equal(childRows()[0], keptChild, "collapse-all must reuse the mounted row, not rebuild");
    assert.ok(branchRow.classList.contains("is-collapsed"),
      "collapse-all rotates the caret via the ROW class (it only wrote the caret before)");
    assert.equal(byClass(app.view, "trellis-split-caret")[0].attributes["aria-expanded"], "false");

    await tools[0].dispatch("click");
    assert.equal(childRows().length, 1, "expand-all restores every branch");
    assert.equal(childRows()[0], keptChild, "expand-all must reuse the mounted row too");
    assert.ok(!branchRow.classList.contains("is-collapsed"),
      "expand-all clears the row's caret rotation (it only cleared the caret's before)");
    assert.equal(byClass(app.view, "trellis-split-caret")[0].attributes["aria-expanded"], "true");
  });

  it("walks an HTMLCollection-shaped sibling list for local subtree folds", () => {
    // Real Electron DOM: `parent.children` is an HTMLCollection — no
    // indexOf, and Array.isArray() is ALWAYS false. The first fix probed
    // Array.isArray() there, so production silently took the rebuild
    // fallback while the (array-backed) test sandbox "agreed" via the same
    // fallback. This stub is the real shape.
    const app = loadDashboard({ activeResult: { status: "ok", tasks: [] } });
    const makeRow = (depth) => {
      const row = new FakeElement("div");
      row.className = "trellis-split-row";
      row.dataset.depth = String(depth);
      return row;
    };
    const root = makeRow(0);
    const child = makeRow(1);
    const grandchild = makeRow(2);
    const siblingRoot = makeRow(0);
    const collection = { 0: root, 1: child, 2: grandchild, 3: siblingRoot, length: 4 };
    assert.equal(Array.isArray(collection), false);
    assert.equal(typeof collection.indexOf, "undefined");

    const touched = app.sandbox.applySubtreeFold(collection, root, true);
    assert.equal(touched.length, 2);
    assert.equal(touched[0], child);
    assert.equal(touched[1], grandchild);
    assert.ok(child.classList.contains("is-subtree-folded"));
    assert.ok(grandchild.classList.contains("is-subtree-folded"));
    assert.ok(!siblingRoot.classList.contains("is-subtree-folded"),
      "the next same-depth row belongs to a different subtree");

    app.sandbox.applySubtreeFold(collection, root, false);
    assert.ok(!child.classList.contains("is-subtree-folded"));
    assert.ok(!grandchild.classList.contains("is-subtree-folded"));
  });

  it("skips folded rows when navigating with the arrow keys", async () => {
    const app = loadDashboard({
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/p", title: "Plan task", phase: "plan", cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/a", title: "Task A", phase: "execute", cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/kid", title: "Kid", parent: "a", phase: "execute", cwd: "/proj/one" },
      ] },
      archiveResult: { status: "ok", tasks: [] },
    });
    await flush();
    await switchToTrellis(app);
    const rowNamed = (text) => byClass(app.view, "trellis-split-row")
      .find((el) => textOf(el).includes(text));
    const selected = () => byClass(app.view, "trellis-split-row")
      .find((el) => el.classList.contains("is-selected"));

    // Fold the execute branch, then walk down from the plan row: ↓ must
    // skip the folded "Kid" row (it is still mounted, just display:none).
    await byClass(app.view, "trellis-split-caret")[0].dispatch("click");
    await rowNamed("Plan task").dispatch("click");
    await flush();
    assert.ok(rowNamed("Kid").classList.contains("is-subtree-folded"), "Kid sits behind a folded branch");
    app.pressKey("ArrowDown");
    await flush();
    assert.ok(textOf(selected()).includes("Task A"),
      "↓ lands on the next VISIBLE row, never on a row inside a folded subtree");
    app.pressKey("ArrowUp");
    await flush();
    assert.ok(textOf(selected()).includes("Plan task"));
    assert.ok(!app.detailCalls.some((call) => call.taskPath === ".trellis/tasks/kid"),
      "keyboard navigation never selects the folded row");

    // Phase-card fold hides a whole group by CHILD selector — same rule.
    const executeHead = byClass(app.view, "trellis-split-group-head")
      .find((el) => textOf(el).includes(i18n.en.dashboardTrellisPhaseExecute));
    const executeCard = byClass(app.view, "trellis-split-phase-card")
      .find((el) => el.dataset.phase === "execute");
    const aRow = rowNamed("Task A");
    await groupHeadToggle(executeHead).dispatch("click");
    assert.ok(executeCard.classList.contains("is-folded"), "phase fold hides rows via the CARD class");
    assert.equal(byClass(app.view, "trellis-split-phase-card")
      .find((el) => el.dataset.phase === "execute"), executeCard,
    "the phase card is reused, not rebuilt");
    assert.equal(rowNamed("Task A"), aRow, "the hidden rows are reused too");
    assert.ok(executeHead.classList.contains("is-collapsed"), "head keeps the rotation anchor");
    app.pressKey("ArrowDown");
    await flush();
    assert.ok(textOf(selected()).includes("Plan task"),
      "a selection inside a folded phase card falls back to the first visible row");
    assert.equal(rowNamed("Task A"), aRow, "the row node survives the fold AND the re-selection");
  });

  it("keeps a folded archive subtree folded across a rebuild", async () => {
    const app = loadDashboard({
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [] },
      archiveResult: { status: "ok", tasks: [
        archivedTask({ taskPath: ".trellis/tasks/archive/2026-09/root", title: "Arch root", cwd: "/proj/one" }),
        archivedTask({ taskPath: ".trellis/tasks/archive/2026-09/root-kid", title: "Arch kid", parent: "root", cwd: "/proj/one" }),
      ] },
    });
    await flush();
    await switchToTrellis(app);
    const archiveHead = byClass(app.view, "trellis-split-group-head")
      .find((el) => el.classList.contains("is-collapsed"));
    await groupHeadToggle(archiveHead).dispatch("click");
    await flush();
    const kidRow = () => byClass(app.view, "trellis-split-row")
      .find((el) => textOf(el).includes("Arch kid"));
    assert.ok(kidRow(), "the archive child renders under its root");

    await byClass(app.view, "trellis-split-caret")[0].dispatch("click");
    assert.ok(kidRow().classList.contains("is-subtree-folded"), "local archive fold hides the child");

    // Any structural rebuild must re-derive the fold from collapsedPaths.
    // The old code passed a constant `true` as ancestorsExpanded here, so
    // the direct child leaked back into view while deeper rows stayed
    // hidden (the "archive revival" bug).
    await byClass(app.view, "trellis-filter-refresh")[0].dispatch("click");
    await flush();
    assert.ok(kidRow().classList.contains("is-subtree-folded"),
      "a rebuild re-applies the archive subtree fold (ancestorsExpanded must read collapsedPaths)");
  });

  it("skips rows inside a folded archive month when navigating", async () => {
    const app = loadDashboard({
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", cwd: "/proj/one" },
      ] },
      archiveResult: { status: "ok", tasks: [
        archivedTask({ taskPath: ".trellis/tasks/archive/2026-09/done-thing", title: "Done thing", cwd: "/proj/one" }),
      ] },
    });
    await flush();
    await switchToTrellis(app);
    const archiveHead = byClass(app.view, "trellis-split-group-head")
      .find((el) => el.classList.contains("is-collapsed"));
    await groupHeadToggle(archiveHead).dispatch("click");
    await flush();
    // Select the last active row, then fold the month: ↓ has nowhere
    // visible to go, so the selection must stay put.
    await byClass(app.view, "trellis-split-row")
      .find((el) => textOf(el).includes("Task A")).dispatch("click");
    await flush();
    const archivedRow = () => byClass(app.view, "trellis-split-row")
      .find((el) => el.classList.contains("is-archived"));
    const keptRow = archivedRow();
    await byClass(app.view, "trellis-split-month-toggle")[0].dispatch("click");
    assert.equal(archivedRow(), keptRow, "the month fold reuses the row node");
    assert.ok(keptRow.classList.contains("is-month-folded"));
    // openMonths lives in the structural signature → the sync after the
    // local fold is what keeps the next 1s tick from rebuilding.
    app.tickRender();
    assert.equal(archivedRow(), keptRow, "the 1s tick keeps the folded month mounted");
    app.pressKey("ArrowDown");
    await flush();
    const selected = byClass(app.view, "trellis-split-row")
      .find((el) => el.classList.contains("is-selected"));
    assert.ok(textOf(selected).includes("Task A"),
      "↓ must not select a row hidden inside the folded month");
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
    await groupHeadToggle(heads.find((el) => textOf(el).includes(i18n.en.dashboardTrellisPhaseArchived))).dispatch("click");

    const rows = byClass(app.view, "trellis-split-row");
    const kid = rows.find((el) => textOf(el).includes("Done kid"));
    assert.ok(kid, "the adopted archived task renders");
    assert.ok(kid.classList.contains("is-child"), "it nests under its still-active parent");
    assert.ok(
      rows[rows.indexOf(kid) - 1].classList.contains("is-parent"),
      "…and sits directly under the parent row",
    );

    // Only the orphan owns a month sub-group: the adopted task left its own.
    // Month heads share the phase-head anatomy (R7): bare label + separate
    // auto-right count pill instead of the old "month · count" merged text.
    assert.deepEqual(byClass(app.view, "trellis-split-month-label").map(textOf), ["2026-08"]);
    assert.ok(byClass(app.view, "trellis-split-group-count").map(textOf).includes("1"));
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
      // v7 R10: spec + relations groups render BELOW the phase groups, so
      // "last head" is no longer DONE — match by the archived phase label.
      return byClass(app.view, "trellis-split-group-head").find((el) =>
        textOf(el).includes(i18n.en.dashboardTrellisPhaseArchived)
      );
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
      // v7 R10: spec + relations groups render BELOW the phase groups, so
      // "last head" is no longer DONE — match by the archived phase label.
      return byClass(app.view, "trellis-split-group-head").find((el) =>
        textOf(el).includes(i18n.en.dashboardTrellisPhaseArchived)
      );
    };
    await groupHeadToggle(doneHead()).dispatch("click");
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

    // Removing the selected root (now done in Settings) refreshes the roots
    // list; the stale selection must not silently filter everything out.
    registered = ["/proj/one"];
    await byClass(app.view, "trellis-filter-refresh")[0].dispatch("click");
    await flush();
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

    // The bar is primary: chips + spec entry + gear icon (09-25 polish: no
    // redundant "全部项目" title when nothing is selected — chips already
    // list every root).
    assert.equal(byClass(app.view, "trellis-filter-title").length, 0);
    assert.equal(byClass(app.view, "trellis-filter-chip").length, 3);
    // v7 R10: no 📐 button anymore — spec docs live in a left-column group.
    assert.equal(byClass(app.view, "trellis-spec-open").length, 0);
    // Root management lives in Settings → Trellis (09-25): no ⚙ button,
    // no root rows — chips are the only root UI in the view.
    assert.equal(byClass(app.view, "trellis-filter-manage").length, 0);
    assert.equal(byClass(app.view, "trellis-root-row").length, 0);
  });

      it("resets spec and relations content when the project chip switches", async () => {
    let specByRoot = new Map([
      ["/proj/one", { status: "ok", truncated: false, files: [
        { group: "frontend", relPath: "frontend/one.md", filled: true, lines: 9, refCount: 0 },
      ] }],
      ["/proj/two", { status: "ok", truncated: false, files: [
        { group: "backend", relPath: "backend/two.md", filled: true, lines: 4, refCount: 0 },
      ] }],
    ]);
    let netByRoot = new Map([
      ["/proj/one", { status: "ok", nodes: [], edges: [
        { parentTaskPath: ".trellis/tasks/one-p", childTaskPath: ".trellis/tasks/one-c", parentMissing: false },
      ], specGroups: [], prdGroups: [], truncated: false }],
      ["/proj/two", { status: "ok", nodes: [], edges: [
        { parentTaskPath: ".trellis/tasks/two-p", childTaskPath: ".trellis/tasks/two-c", parentMissing: false },
      ], specGroups: [], prdGroups: [], truncated: false }],
    ]);
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/one", "/proj/two"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", phase: "plan", progress: null, parent: null, cwd: "/proj/one" },
      ] },
      archiveResult: { status: "ok", tasks: [] },
      specResult: (payload) => specByRoot.get(payload.root),
      networkOverviewResult: (payload) => netByRoot.get(payload.root),
    });
    await flush();
    await switchToTrellis(app);

    // Expand both groups under the default scope (All → first root).
    const headByText = (label) => byClass(app.view, "trellis-split-group-head")
      .find((el) => textOf(el).includes(label));
    await headByText(i18n.en.dashboardTrellisSpecGroup).dispatch("click");
    await flush();
    await headByText(i18n.en.dashboardTrellisLinksGroup).dispatch("click");
    await flush();
    assert.deepEqual(app.specCalls.map((p) => p.root), ["/proj/one"]);
    assert.ok(byClass(app.view, "trellis-spec-row").some((el) => textOf(el).includes("frontend/one.md")));
    assert.ok(byClass(app.view, "trellis-network-row").some((el) => textOf(el).includes("one-p")));

    // Switch the chip (chips = [All, /proj/one, /proj/two]): both groups
    // must refetch for the new root.
    await byClass(app.view, "trellis-filter-chip")[2].dispatch("click");
    await flush();
    assert.deepEqual(app.specCalls.map((p) => p.root), ["/proj/one", "/proj/two"],
      "the spec group refetches for the newly selected root");
    assert.deepEqual(app.networkOverviewCalls.map((p) => p.root), ["/proj/one", "/proj/two"],
      "the relations group refetches too");
    assert.ok(byClass(app.view, "trellis-spec-row").every((el) => textOf(el).includes("two.md")),
      "the spec rows now show the second root's docs");
    assert.ok(byClass(app.view, "trellis-network-row").some((el) => textOf(el).includes("two-p")),
      "and the relations rows show the second root's graph");

    // Back to All: falls back to the first root again.
    await byClass(app.view, "trellis-filter-chip")[0].dispatch("click");
    await flush();
    assert.deepEqual(app.specCalls.map((p) => p.root), ["/proj/one", "/proj/two", "/proj/one"]);
    assert.ok(byClass(app.view, "trellis-spec-row").some((el) => textOf(el).includes("frontend/one.md")));
  });
it("lists spec docs in the left-column group with status badges", async () => {
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

    // The spec group starts collapsed with the other phase groups.
    const heads = byClass(app.view, "trellis-split-group-head");
    const specHead = heads.find((el) => textOf(el).includes(i18n.en.dashboardTrellisSpecGroup));
    assert.ok(specHead, "the spec group head renders below the phase groups");
    assert.ok(specHead.classList.contains("is-collapsed"));
    assert.equal(byClass(app.view, "trellis-spec-row").length, 0, "collapsed → no rows");
    assert.deepEqual(app.specCalls, [], "nothing is fetched before expanding");

    await specHead.dispatch("click");
    await flush();
    assert.deepEqual(app.specCalls, [{ root: "/proj/one" }], "first expand lazy-loads the tree");

    const rows = byClass(app.view, "trellis-spec-row");
    assert.equal(rows.length, 3);
    assert.ok(textOf(rows[0]).includes("frontend/index.md"));

    // Filled docs show a body-line count, never a "filled" badge.
    assert.equal(textOf(byClass(rows[0], "trellis-spec-file-lines")[0]), "12 lines");
    assert.equal(byClass(rows[0], "trellis-spec-file-empty").length, 0);
    assert.equal(textOf(byClass(rows[0], "trellis-spec-file-refs")[0]), "3");

    // Heading-only docs read as empty instead of looking filled.
    assert.ok(rows[1].classList.contains("is-empty-spec"));
    assert.equal(
      textOf(byClass(rows[1], "trellis-spec-file-empty")[0]),
      i18n.en.dashboardTrellisSpecEmptyDoc,
    );
    assert.equal(byClass(rows[1], "trellis-spec-file-refs").length, 0);

    // A doc that could not be read stays neutral: no empty badge, no count.
    assert.ok(!rows[2].classList.contains("is-empty-spec"));
    assert.equal(byClass(rows[2], "trellis-spec-file-empty").length, 0);
    assert.equal(byClass(rows[2], "trellis-spec-file-lines").length, 0);
    assert.equal(textOf(byClass(rows[2], "trellis-spec-file-refs")[0]), "1");
  });
});

describe("dashboard trellis v7 R8 project drawers", () => {
    it("lists relations in the left-column group and jumps on click", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", phase: "execute", progress: null, parent: null, cwd: "/proj/one" },
        { taskPath: ".trellis/tasks/kid", title: "Kid", phase: "plan", progress: null, parent: "a", cwd: "/proj/one" },
      ] },
      archiveResult: { status: "ok", tasks: [] },
      networkOverviewResult: { status: "ok", nodes: [
        { taskPath: ".trellis/tasks/a", title: "Task A", archived: false, priority: null },
        { taskPath: ".trellis/tasks/kid", title: "Kid", archived: false, priority: null },
      ], edges: [
        { parentTaskPath: ".trellis/tasks/a", childTaskPath: ".trellis/tasks/kid", parentMissing: false },
      ], specGroups: [], prdGroups: [], truncated: false },
    });
    await flush();
    await switchToTrellis(app);

    // The relations group starts collapsed with the others.
    const netHead = byClass(app.view, "trellis-split-group-head")
      .find((el) => textOf(el).includes(i18n.en.dashboardTrellisLinksGroup));
    assert.ok(netHead, "the relations group head renders");
    assert.ok(netHead.classList.contains("is-collapsed"));
    assert.equal(byClass(app.view, "trellis-network-row").length, 0);
    assert.deepEqual(app.networkOverviewCalls, [], "nothing fetched before expanding");

    await netHead.dispatch("click");
    await flush();
    assert.deepEqual(app.networkOverviewCalls, [{ root: "/proj/one" }], "first expand lazy-loads");
    const rows = byClass(app.view, "trellis-network-row");
    assert.equal(rows.length, 1, "one vertical group row");
    assert.ok(textOf(rows[0]).includes(".trellis/tasks/a"),
      "the group row carries its parent path");
    const side = byClass(rows[0], "trellis-split-row-side")[0];
    assert.ok(textOf(side).includes("2"), "the side carries the member count");

    // Clicking the group row shows members in the right pane.
    await rows[0].dispatch("click");
    await flush();
    const pane = byClass(app.view, "trellis-split-detail")[0];
    assert.equal(byClass(pane, "trellis-network-group-content").length, 1);
    const members = byClass(pane, "trellis-network-ref");
    assert.equal(members.length, 2, "parent + child");

    // Clicking a member jumps to that task in the split list.
    await members[1].dispatch("click");
    await flush();
    assert.deepEqual(app.detailCalls, [{ taskPath: ".trellis/tasks/kid", cwd: "/proj/one" }]);
    assert.equal(byClass(app.view, "trellis-network-group-content").length, 0,
      "a task selection replaces the group view in the pane");
  });

  it("shows the spec doc in the right pane when its row is clicked", async () => {
    const app = loadDashboard({
      sessions: [],
      rootsResult: { status: "ok", roots: ["/proj/one"] },
      activeResult: { status: "ok", tasks: [
        { taskPath: ".trellis/tasks/a", title: "Task A", phase: "plan", progress: null, parent: null, cwd: "/proj/one" },
      ] },
      archiveResult: { status: "ok", tasks: [] },
      specResult: { status: "ok", truncated: false, files: [
        { group: "frontend", relPath: "frontend/index.md", filled: true, lines: 8, refCount: 1 },
      ] },
    });
    await flush();
    await switchToTrellis(app);

    const specHead = byClass(app.view, "trellis-split-group-head")
      .find((el) => textOf(el).includes(i18n.en.dashboardTrellisSpecGroup));
    await specHead.dispatch("click");
    await flush();

    await byClass(app.view, "trellis-spec-row")[0].dispatch("click");
    await flush();

    const row = byClass(app.view, "trellis-spec-row")[0];
    assert.ok(row.classList.contains("is-selected"), "the clicked row highlights");
    const pane = byClass(app.view, "trellis-split-detail")[0];
    assert.ok(byClass(pane, "trellis-spec-doc-content").length === 1,
      "the right pane renders the spec doc, not the task card");
    assert.ok(textOf(pane).includes("frontend/index.md"));

    // Clicking a task row routes the pane back to the task detail.
    await byClass(app.view, "trellis-split-row")
      .filter((el) => !el.classList.contains("is-archived"))[0].dispatch("click");
    await flush();
    assert.equal(byClass(app.view, "trellis-spec-doc-content").length, 0,
      "a task selection replaces the spec doc in the pane");
  });
});

describe("trellis doc fold static guards (R4 lessons)", () => {
  // R4 bug class: author `display` (e.g. fold-card display:flex) beats the
  // UA rule for [hidden], so collapsed parents left nested cards visible.
  // This bit three separate times (quota feedback, quick banner, fold
  // cards) before the global guard existed — do not let it be "cleaned up".
  it("dashboard.html keeps the global [hidden] display:none override", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
    assert.match(html, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s,
      "global [hidden]{display:none!important} guard missing — author display "
      + "(fold cards, quick banner, quota summary are display:flex) would "
      + "beat the [hidden] attribute again");
  });

  it("both right-pane doc render paths wire collapse handlers", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
    const calls = src.match(/wireTrellisDocCollapse\(/g) || [];
    // 1 definition + >=2 call sites (task doc path + spec doc pane path).
    // A new render path that forgets to wire = headings not clickable.
    assert.ok(calls.length >= 3,
      `wireTrellisDocCollapse expected >=3 occurrences (def + 2 paths), got ${calls.length}`);
  });
});

describe("dashboard.html CSS structural guards (09-25 lessons)", () => {
  // 09-25 bug class: anchored edits to the big inline <style> block left
  // behind stray selector lines / orphan declarations when the oldText
  // anchor only covered a rule's head. Braces went unbalanced, rules got
  // swallowed by their neighbors, and the WHOLE UI misrendered. Run this
  // after ANY bulk CSS edit to dashboard.html.
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
  const styleStart = html.indexOf("<style>") + "<style>".length;
  const styleEnd = html.indexOf("</style>");
  const css = html.slice(styleStart, styleEnd);

  it("<style> block braces stay balanced (depth 0 at end)", () => {
    let depth = 0;
    let min = 0;
    for (const line of css.split("\n")) {
      depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      min = Math.min(min, depth);
    }
    assert.equal(depth, 0, `<style> braces unbalanced: final depth ${depth}`);
    assert.equal(min, 0, `<style> braces close before opening (min depth ${min}) — a stray } is eating selectors`);
  });

  it("<style> block has no orphan top-level declarations", () => {
    // A top-level `prop: value;` line at brace depth 0 means a selector
    // head was deleted while its body survived — the signature of the
    // 09-25 mis-edit class. (Custom props in :root are fine; those live at
    // depth 1 inside the :root block.)
    let depth = 0;
    const orphans = [];
    css.split("\n").forEach((line, i) => {
      if (depth === 0 && /^[-a-zA-Z]+\s*:\s*[^;{]+;\s*$/.test(line)) {
        orphans.push(`css line ${i + 1}: ${line.trim()}`);
      }
      depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    });
    assert.deepEqual(orphans, [],
      "orphan top-level declarations in <style> — a selector head was lost in an edit; rules are merging");
  });

  it("renderer avoids DOM methods missing from the vm test sandbox", () => {
    // node:test runs the renderer via vm.runInNewContext with a minimal
    // DOM stub: no insertBefore/prepend (and timers only behind typeof
    // guards). If a future change needs them, extend the stub first.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
    assert.ok(!/\.insertBefore\(/.test(src),
      "dashboard-renderer uses insertBefore — the vm sandbox DOM has no insertBefore; build order via appendChild instead");
    assert.ok(!/\.prepend\(/.test(src),
      "dashboard-renderer uses prepend — the vm sandbox DOM has no prepend; build order via appendChild instead");
  });

  it("keeps the fold classes wired on both sides (09-25 review)", () => {
    // Two separate responsibilities, two separate classes: HIDING vs caret
    // ROTATION. The first fix mixed them up and wrote classes nothing
    // consumed (row.is-folded) while skipping the ones CSS actually
    // anchored (row.is-collapsed on collapse-all).
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
    assert.match(css, /\.trellis-split-row\.is-subtree-folded,\s*\n\.trellis-split-row\.is-month-folded\s*\{\s*display:\s*none;/,
      "CSS must hide folded subtree + month rows");
    assert.match(css, /\.trellis-split-phase-card\.is-folded > \.trellis-split-row\s*\{\s*display:\s*none;/,
      "CSS must hide the rows of a folded phase card");
    assert.match(css, /\.trellis-split-row\.is-collapsed \.trellis-split-caret\s*\{\s*transform:\s*rotate\(-90deg\);|\n\s*transform:\s*rotate\(-90deg\);/,
      "CSS must rotate the caret off the ROW class");
    // Every class in that contract needs a renderer writer, or it is dead CSS.
    for (const cls of ["is-subtree-folded", "is-month-folded", "is-folded", "is-collapsed"]) {
      assert.ok(src.includes(`"${cls}"`), `no renderer writer for .${cls} — dead CSS`);
    }
    // …and the retired dead classes must not come back: rotation never
    // hangs off the caret button, and rows never carry a bare is-folded.
    assert.ok(!/\.trellis-split-caret\.is-collapsed/.test(css),
      "no CSS consumer exists for a caret-level is-collapsed — rotate via the ROW");
    assert.ok(!src.includes('caret.classList.add("is-collapsed")'),
      "the caret button must not carry the fold class (rotation anchors on the row)");
    assert.ok(!src.includes('caret.classList.toggle("is-collapsed"'),
      "the caret button must not carry the fold class (rotation anchors on the row)");
    // The real-machine failure mode the first attempt shipped: in Electron
    // `Element.children` is an HTMLCollection, so `Array.isArray()` is always
    // false and the "local fold" branch silently fell through to a full-tree
    // rebuild on every click. The vm sandbox cannot catch this — its
    // FakeElement.children IS a real array, so both shapes look green there.
    // Pin the shape statically instead of relying on anyone remembering to
    // write the HTMLCollection stub.
    assert.ok(!/Array\.isArray\([^)]*\.children\s*\)/.test(src),
      "Element.children is an HTMLCollection — normalize with Array.from, never Array.isArray");
    // Rows never carry a bare is-folded: that class means "this phase CARD is
    // folded", so a row-level writer is dead code by definition.
    assert.ok(!/(?:row|caret)\.classList\.(?:add|toggle)\("is-folded"/.test(src),
      "is-folded belongs to the phase card only — a row/caret writer is dead code");
  });
});
