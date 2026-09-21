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
  TRELLIS_PHASE_BADGE,
  normalizeProgress,
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
    this.style = {};
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

function loadDashboard({
  sessions = [],
  detailResult = null,
  detailError = null,
  archiveResult = null,
  archiveError = null,
  activeResult = null,
  activeError = null,
  rootsResult = null,
  rootsError = null,
  addResult = null,
  removeResult = null,
} = {}) {
  const elements = new Map(
    [
      "content", "title", "count", "quickBanner", "quotaSummary", "trellisPanel",
      "trellisDetailOverlay", "trellisView", "viewSessionsTab", "viewTrellisTab",
      "sessionsHeaderExtras",
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
  const archiveCalls = [];
  const activeCalls = [];
  const rootsCalls = [];
  const addRootCalls = [];
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
    fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8"),
    context,
  );

  return {
    panel: elements.get("trellisPanel"),
    overlay: elements.get("trellisDetailOverlay"),
    view: elements.get("trellisView"),
    content: elements.get("content"),
    titleEl: elements.get("title"),
    trellisTab: elements.get("viewTrellisTab"),
    sessionsTab: elements.get("viewSessionsTab"),
    headerExtras: elements.get("sessionsHeaderExtras"),
    focusCalls,
    detailCalls,
    archiveCalls,
    activeCalls,
    rootsCalls,
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
    const fills = byClass(app.overlay, "trellis-detail-progress-fill");
    assert.equal(fills.length, 1);
    assert.equal(fills[0].style.width, "50%");
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
  async function switchToTrellis(app) {
    await app.trellisTab.dispatch("click");
    await flush();
  }

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
    const rows = byClass(app.view, "trellis-root-row");
    assert.equal(rows.length, 1);
    assert.ok(textOf(rows[0]).includes("/proj/s1"));

    const activeRows = byClass(app.view, "trellis-task-row");
    assert.equal(activeRows.length, 1);
    assert.ok(textOf(app.view).includes("Disk task"));
    assert.ok(textOf(app.view).includes("1/2"));

    assert.ok(textOf(app.view).includes(
      `${i18n.en.dashboardTrellisArchiveTitle} (1)`
    ), "the archive section header carries the loaded count");
    assert.equal(byClass(app.view, "trellis-archive-row").length, 1,
      "the newest month is open by default");
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
    await byClass(app.view, "trellis-archive-row")[0].dispatch("click");
    await flush();
    assert.deepEqual(app.detailCalls, [{
      taskPath: ".trellis/tasks/archive/2026-09/done-thing",
      cwd: "/proj/s1",
    }], "the archive row's taskPath and cwd feed the detail read");
    assert.equal(app.overlay.hidden, false);
    assert.ok(textOf(app.overlay).includes("Title from disk"));
    assert.equal(byClass(app.overlay, "trellis-session-chip").length, 0,
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
    await byClass(app.view, "trellis-task-detail-btn")[0].dispatch("click");
    await flush();
    assert.deepEqual(app.detailCalls, [{ taskPath: ".trellis/tasks/t1", cwd: "/proj/s1" }]);
    assert.equal(app.overlay.hidden, false);
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
    const retry = byClass(app.view, "trellis-archive-retry")[0];
    assert.ok(retry);

    archiveFailing = false;
    activeFailing = false;
    await retry.dispatch("click");
    await flush();
    assert.equal(app.archiveCalls.length, 2);
    assert.equal(byClass(app.view, "trellis-archive-row").length, 1);
    // The archive retry only heals the archive section; the active section
    // has its own refresh behind the same ↻ affordance.
    await byClass(app.view, "trellis-active-refresh")[0].dispatch("click");
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
    const month = byClass(app.view, "trellis-archive-month")[0];
    assert.equal(month.attributes["aria-expanded"], "true", "newest month starts open");

    await month.dispatch("click");
    assert.equal(byClass(app.view, "trellis-archive-row").length, 0,
      "collapsing the month hides its rows");
    await byClass(app.view, "trellis-archive-month")[0].dispatch("click");
    assert.equal(byClass(app.view, "trellis-archive-row").length, 1);

    // The active section's ↻ and the archive section's ↻ are distinct
    // buttons; pick the archive one via its extra distinguishing class.
    const archiveRefresh = descendants(app.view).find(
      (el) => el.classList && el.classList.contains("trellis-archive-refresh")
        && !el.classList.contains("trellis-active-refresh")
    );
    await archiveRefresh.dispatch("click");
    await flush();
    assert.equal(app.archiveCalls.length, 2);
    assert.equal(byClass(app.view, "trellis-archive-row").length, 1,
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
});
