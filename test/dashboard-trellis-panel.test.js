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
});

function bindingSession(id, trellis, extra = {}) {
  return {
    id,
    displayTitle: `Title ${id}`,
    agentId: "claude-code",
    agentName: "Claude Code",
    canFocus: true,
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

function loadDashboard({ sessions = [] } = {}) {
  const elements = new Map(
    ["content", "title", "count", "quickBanner", "quotaSummary", "trellisPanel"]
      .map((id) => [id, new FakeElement("div")]),
  );
  const document = {
    title: "",
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new FakeElement("fragment"),
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    contains: () => true,
  };

  const focusCalls = [];
  let snapshotListener = null;
  let renderInterval = null;
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
  };

  const context = vm.createContext({
    window: { dashboardAPI: api }, document, console, Intl, Date,
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
    focusCalls,
    pushSnapshot: (next) => snapshotListener && snapshotListener(next),
    tickRender: () => { if (renderInterval) renderInterval(); },
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

    app.pushSnapshot({ sessions: [bindingSession("s1", null)], groups: [] });
    await flush();
    assert.equal(app.panel.hidden, true, "no live binding → the whole panel disappears");
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
