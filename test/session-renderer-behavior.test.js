"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { i18n, SUPPORTED_LANGS } = require("../src/i18n");

class FakeClassList {
  constructor(element) { this.element = element; }
  _set() { return new Set(this.element.className.split(/\s+/).filter(Boolean)); }
  _commit(set) { this.element.className = [...set].join(" "); }
  add(...names) {
    const set = this._set();
    for (const name of names) set.add(name);
    this._commit(set);
  }
  remove(...names) {
    const set = this._set();
    for (const name of names) set.delete(name);
    this._commit(set);
  }
  toggle(name, force) {
    const set = this._set();
    const shouldAdd = force === undefined ? !set.has(name) : Boolean(force);
    if (shouldAdd) set.add(name);
    else set.delete(name);
    this._commit(set);
    return shouldAdd;
  }
  contains(name) { return this._set().has(name); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.style = {};
  }
  appendChild(child) {
    this.children.push(child);
    // Non-enumerable parentNode (same pattern as dashboard-trellis-panel's
    // stub): the blank-space click handler walks parentNode to find the
    // nearest interactive ancestor, so the vm DOM needs a real parent chain.
    Object.defineProperty(child, "parentNode", {
      value: this, writable: true, configurable: true, enumerable: false,
    });
    return child;
  }
  // Standard DOM live count — createTrellisPanel's "list has content" gate
  // reads it; without the getter the gate sees undefined and always appends
  // the empty hint, diverging the vm DOM from the real one.
  get childElementCount() {
    return this.children.length;
  }
  replaceChildren(...children) {
    this.children = children;
    for (const child of children) {
      Object.defineProperty(child, "parentNode", {
        value: this, writable: true, configurable: true, enumerable: false,
      });
    }
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  // `overrides` lets a test synthesize a bubbling container click with a
  // specific event.target (e.g. the hud root itself, or a row's child).
  async dispatch(name, overrides) {
    const event = { stopPropagation() {}, preventDefault() {}, key: "", ...(overrides || {}) };
    for (const listener of this.listeners.get(name) || []) await listener(event);
  }
  querySelector(selector) {
    if (!selector.startsWith(".")) return null;
    return byClass(this, selector.slice(1))[0] || null;
  }
  replaceWith() {}
  focus() {}
  select() {}
}

function createDocument(ids) {
  const elements = new Map(ids.map((id) => [id, new FakeElement("div")]));
  return {
    title: "",
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new FakeElement("fragment"),
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    contains: () => true,
    elements,
  };
}

function descendants(root) {
  const result = [];
  for (const child of root.children || []) {
    result.push(child, ...descendants(child));
  }
  return result;
}

function byClass(root, className) {
  return descendants(root).filter((element) =>
    element.classList && element.classList.contains(className));
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function translations() {
  return {
    sessionHudTrellisTooltip: "Trellis task: {title} — {phase}",
    sessionHudTrellisPhaseExecute: "Execute",
    trellisHintExecute: "step {done}/{total}",
    sessionHudTrellisPanelActive: "Active",
    sessionHudTrellisPanelDone: "Done",
    sessionHudTrellisPanelAll: "View all in Dashboard",
    sessionHudTrellisPanelLoading: "Loading…",
    sessionHudTrellisPanelEmpty: "No tasks",
    sessionHudTrellisToggleTooltip: "Trellis tasks",
    dashboardWindowTitle: "Sessions",
    dashboardCount: "{n} active",
    dashboardJumpTerminal: "Jump",
    dashboardOpenFolder: "Open Folder",
    sessionFocusUnavailableRemote: "Remote sessions cannot focus a terminal on this computer.",
    sessionFocusUnavailableWebui: "WebUI sessions do not have a local terminal window.",
    sessionFocusUnavailableMissingTerminalInfo: "This session did not provide terminal window information.",
    sessionOpenFolderFailed: "Could not open folder: {reason}",
    sessionOpenFolderUnavailable: "This folder is no longer available.",
    sessionJustNow: "now",
    sessionHudElapsedSec: "{n}s",
    sessionMinAgo: "{n}m",
    sessionHrAgo: "{n}h",
    sessionBadgeIdle: "Idle",
    sessionLocal: "Local",
    sessionAutomationLabel: "Session automation",
    sessionAutomationFollowGlobal: "Follow global",
    sessionAutomationAsk: "Always ask",
    sessionAutomationAutoTools: "Auto-allow tools",
    sessionAutomationUnavailable: "Unavailable",
    sessionAutomationChangeFailed: "Could not update session automation.",
    sessionAutomationOrphansTitle: "Ended or hidden sessions",
    sessionAutomationOrphansHint: "These overrides remain active until revoked.",
    sessionAutomationRevoke: "Revoke",
    dashboardKimiQuotaRefresh: "Refresh Kimi quota",
    dashboardKimiQuotaRefreshing: "Refreshing Kimi…",
    dashboardKimiQuotaUpdated: "Kimi quota updated.",
    dashboardKimiQuotaRefreshFailed: "Refresh failed: {reason}",
    dashboardKimiQuotaEmpty: "No quota data yet. Click refresh to fetch it.",
    dashboardKimiQuotaRefreshShort: "Refresh",
    dashboardModel: "Model",
  };
}

function session(id, overrides = {}) {
  return {
    id,
    displayTitle: id,
    state: "idle",
    badge: "idle",
    updatedAt: Date.now(),
    canFocus: false,
    sourceType: "local",
    host: null,
    platform: null,
    cwd: "/safe/project",
    ...overrides,
  };
}

async function loadDashboard(
  sessions,
  openResult = { status: "ok" },
  snapshotOverrides = {},
  automationResult = { status: "applied" },
  kimiOptions = {}
) {
  const document = createDocument([
    "title",
    "count",
    "content",
    "quotaSummary",
  ]);
  const openCalls = [];
  const automationCalls = [];
  const kimiRefreshCalls = [];
  let renderInterval = null;
  const api = {
    onLangChange: () => {},
    onSessionSnapshot: () => {},
    getI18n: async () => ({ lang: "en", translations: translations() }),
    getSnapshot: async () => ({
      sessions,
      groups: [{ host: "", ids: sessions.map((s) => s.id) }],
      ...snapshotOverrides,
    }),
    openSessionFolder: async (...args) => {
      openCalls.push(args);
      return typeof openResult === "function" ? openResult(...args) : openResult;
    },
    focusSession: () => {},
    ackCompletion: async () => ({ status: "noop" }),
    hideSession: async () => ({ status: "ok" }),
    setSessionAutomationOverride: async (payload) => {
      automationCalls.push(["set", payload]);
      return typeof automationResult === "function"
        ? automationResult("set", payload)
        : automationResult;
    },
    clearSessionAutomationGrant: async (payload) => {
      automationCalls.push(["clear", payload]);
      return typeof automationResult === "function"
        ? automationResult("clear", payload)
        : automationResult;
    },
    getKimiQuotaStatus: async () => kimiOptions.status || {
      status: "ok",
      configured: false,
      decryptable: false,
      collectionEnabled: false,
      agentEnabled: true,
    },
    refreshKimiQuota: async () => {
      kimiRefreshCalls.push(true);
      return kimiOptions.refreshResult || { status: "ok" };
    },
  };
  const context = vm.createContext({
    window: { dashboardAPI: api }, document, console, Intl, Date,
    setInterval: (callback) => { renderInterval = callback; return 1; },
    requestAnimationFrame: (cb) => cb(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-trellis-panel.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "trellis-doc-renderer.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8"), context);
  await flush();
  return {
    root: document.elements.get("content"),
    quotaSummary: document.elements.get("quotaSummary"),
    openCalls,
    automationCalls,
    kimiRefreshCalls,
    tickRender: () => { if (renderInterval) renderInterval(); },
  };
}

// `panelResult` overrides the getTrellisPanel mock: a fixed object (e.g.
// `{status:"missing"}`) or a function of the request payload — the default
// still answers the ok fixture below.
async function loadHud(sessions, openResult = { status: "ok" }, panelResult = null) {
  const document = createDocument(["hud"]);
  const openCalls = [];
  const focusCalls = [];
  const ackCalls = [];
  let snapshotListener = null;
  let feedbackTimeout = null;

  // 09-28 trellis-freshness-time: the trellis panel polls while open —
  // record interval timers so tests can drive ticks and see clears (a
  // bare `() => 0` keeps pollTimer falsy and hides the real paths).
  const intervalTimers = [];
  const clearedIntervals = [];
  const api = {
    onLangChange: () => {},
    onSessionSnapshot: (listener) => { snapshotListener = listener; },
    getI18n: async () => ({ lang: "en", translations: translations() }),
    openSessionFolder: async (...args) => {
      openCalls.push(args);
      return typeof openResult === "function" ? openResult(...args) : openResult;
    },
    focusSession: (id) => { focusCalls.push(id); },
    ackCompletion: async (id) => { ackCalls.push(id); return { status: "noop" }; },
    openDashboard: () => {},
    setPinned: () => {},
    getTrellisPanel: async (payload) => {
      openCalls.push(["getTrellisPanel", payload]);
      if (typeof panelResult === "function") return panelResult(payload);
      if (panelResult) return panelResult;
      return { status: "ok", projects: [
        { cwd: "/proj", name: "proj", active: [
          { taskPath: ".trellis/tasks/09-27-x", title: "Task X", phase: "execute", progress: { done: 1, total: 3 } },
        ], archived: [
          { taskPath: ".trellis/tasks/archive/2026-09/09-20-old", title: "Old", completedAt: "2026-09-20T10:00:00.000Z" },
        ] },
      ] };
    },
    openTrellisTask: (payload) => { openCalls.push(["openTrellisTask", payload]); },
  };
  const context = vm.createContext({
    window: { sessionHudAPI: api }, document, console, Date,
    setInterval: (callback) => { intervalTimers.push(callback); return intervalTimers.length; },
    clearInterval: (id) => {
      clearedIntervals.push(id);
      if (Number.isInteger(id) && id >= 1 && id <= intervalTimers.length) intervalTimers[id - 1] = null;
    },
    setTimeout: (callback) => { feedbackTimeout = callback; return 1; },
    clearTimeout: () => { feedbackTimeout = null; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8"), context);
  await flush();
  snapshotListener({ sessions, orderedIds: sessions.map((entry) => entry.id) });
  return {
    // 09-28 trellis-freshness-time: drive live interval ticks (elapsed
    // labels + the trellis panel poll) and inspect timer cleanup.
    fireIntervals: () => { for (const callback of intervalTimers.slice()) if (callback) callback(); },
    clearedIntervals,
    root: document.elements.get("hud"),
    openCalls,
    focusCalls,
    ackCalls,
    pushSnapshot: (nextSessions = sessions) => snapshotListener({
      sessions: nextSessions,
      orderedIds: nextSessions.map((entry) => entry.id),
    }),
    expireFeedback: async () => {
      const callback = feedbackTimeout;
      feedbackTimeout = null;
      if (callback) callback();
      await flush();
    },
  };
}

test("Dashboard renders local/remote/webui reasons and only local folder action", async () => {
  const { root } = await loadDashboard([
    session("local"),
    session("remote", { sourceType: "ssh", host: "host" }),
    session("webui", { platform: "webui" }),
  ]);
  assert.strictEqual(byClass(root, "card-unfocusable").length, 3);
  assert.deepStrictEqual(byClass(root, "focus-unavailable-reason").map((el) => el.textContent), [
    "This session did not provide terminal window information.",
    "Remote sessions cannot focus a terminal on this computer.",
    "WebUI sessions do not have a local terminal window.",
  ]);

  const cards = byClass(root, "card");
  const jumpButtons = (card) => descendants(card)
    .filter((el) => el.tagName === "BUTTON" && el.textContent === "Jump");
  assert.deepStrictEqual(jumpButtons(cards[0]).map((button) => button.disabled), [true]);
  assert.deepStrictEqual(jumpButtons(cards[1]), []);
  assert.deepStrictEqual(jumpButtons(cards[2]).map((button) => button.disabled), [true]);
  assert.strictEqual(byClass(root, "open-folder-button").length, 1);
});

test("Dashboard hosts the manual Kimi quota refresh inside the Kimi quota section", async () => {
  const dashboard = await loadDashboard(
    [],
    { status: "ok" },
    {},
    { status: "applied" },
    {
      status: {
        status: "ok",
        configured: true,
        decryptable: true,
        collectionEnabled: true,
        agentEnabled: true,
      },
    }
  );

  // Connected but nothing reported yet: the section stays visible with an
  // empty hint so the refresh that fetches the first numbers has a home.
  const button = byClass(dashboard.quotaSummary, "quota-refresh-button")[0];
  assert.ok(button, "Kimi quota section header should host the refresh button");
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(button.title, "Refresh Kimi quota");
  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-empty-hint").length, 1);

  await button.dispatch("click");
  await flush();

  assert.strictEqual(dashboard.kimiRefreshCalls.length, 1);
  assert.strictEqual(button.disabled, false);
  const feedback = byClass(dashboard.quotaSummary, "quota-refresh-feedback")[0];
  assert.ok(feedback, "Kimi quota section header should host the refresh feedback");
  assert.strictEqual(feedback.hidden, false);
  assert.strictEqual(feedback.textContent, "Kimi quota updated.");
});

test("Dashboard renders no Kimi quota section or refresh for a disconnected key", async () => {
  const dashboard = await loadDashboard([]);

  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-refresh-button").length, 0);
  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-section").length, 0);
});

test("Dashboard quota bars apply the same warn and hot boundaries as Orbit", async () => {
  const dashboard = await loadDashboard([], { status: "ok" }, {
    accountQuota: [{
      host: null,
      claudeQuota: {
        lastSeenAt: Date.now(),
        group: {
          claudeFiveHour: { usedPercent: 59 },
          claudeWeekly: { usedPercent: 60 },
        },
      },
      codexQuota: {
        lastSeenAt: Date.now(),
        group: {
          codexFiveHour: { usedPercent: 85 },
          codexWeekly: { usedPercent: 86 },
        },
      },
    }],
  });

  const classesByWidth = new Map(
    byClass(dashboard.quotaSummary, "quota-bar-fill")
      .map((fill) => [fill.style.width, fill.className])
  );
  assert.match(classesByWidth.get("59%"), /\bsev-ok\b/);
  assert.match(classesByWidth.get("60%"), /\bsev-warn\b/);
  assert.match(classesByWidth.get("85%"), /\bsev-warn\b/);
  assert.match(classesByWidth.get("86%"), /\bsev-hot\b/);
});

test("Dashboard renders the resolved custom agent name instead of its raw id", async () => {
  const { root } = await loadDashboard([
    session("custom", {
      agentId: "custom-nova-0123456789ab",
      agentName: "Nova AI",
    }),
  ]);

  const meta = byClass(root, "meta")[0];
  const renderedText = meta.children.map((child) => child.textContent || "").join("");
  assert.match(renderedText, /Nova AI/);
  assert.doesNotMatch(renderedText, /custom-nova/);
});

test("Dashboard keeps curated labels for built-in agents", async () => {
  const { root } = await loadDashboard([
    session("codex", { agentId: "codex", agentName: "Codex CLI" }),
  ]);

  const meta = byClass(root, "meta")[0];
  const renderedText = meta.children.map((child) => child.textContent || "").join("");
  assert.match(renderedText, /Codex/);
  assert.doesNotMatch(renderedText, /Codex CLI/);
});

test("Dashboard folder click sends only id and exposes open failure", async () => {
  const { root, openCalls } = await loadDashboard([session("local")], { status: "error", message: "denied" });
  await byClass(root, "open-folder-button")[0].dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);
  const feedback = byClass(root, "session-action-feedback")[0];
  assert.ok(feedback);
  assert.strictEqual(feedback.attributes["aria-live"], "polite");
  assert.strictEqual(feedback.textContent, "Could not open folder: denied");
});

test("Dashboard preserves folder pending and failure state across interval renders", async () => {
  let resolveOpen;
  const pendingResult = new Promise((resolve) => { resolveOpen = resolve; });
  const { root, openCalls, tickRender } = await loadDashboard(
    [session("local")],
    () => pendingResult
  );

  const clickPromise = byClass(root, "open-folder-button")[0].dispatch("click");
  await flush();
  tickRender();

  const replacementButton = byClass(root, "open-folder-button")[0];
  assert.strictEqual(replacementButton.disabled, true);
  await replacementButton.dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);

  resolveOpen({ status: "error", message: "slow denial" });
  await clickPromise;
  tickRender();
  assert.strictEqual(
    byClass(root, "session-action-feedback")[0].textContent,
    "Could not open folder: slow denial"
  );
  assert.strictEqual(byClass(root, "open-folder-button")[0].disabled, false);
});

test("Dashboard session automation sends only sessionId/mode and exact grantId", async () => {
  const configurable = session("configurable", {
    canConfigureSessionAutomation: true,
    sessionAutomationMode: "inherit",
  });
  const activeButIneligible = session("active", {
    canConfigureSessionAutomation: false,
    sessionAutomationMode: "auto-tools",
    sessionAutomationGrantId: "grant-current",
  });
  const inactiveIneligible = session("inactive", {
    canConfigureSessionAutomation: false,
    sessionAutomationMode: "inherit",
  });
  const { root, automationCalls } = await loadDashboard([configurable, activeButIneligible, inactiveIneligible]);
  const selects = byClass(root, "session-automation-select");
  assert.strictEqual(selects.length, 2);

  selects[0].value = "off";
  await selects[0].dispatch("change");
  selects[1].value = "inherit";
  await selects[1].dispatch("change");

  assert.deepStrictEqual(JSON.parse(JSON.stringify(automationCalls)), [
    ["set", { sessionId: "configurable", mode: "off" }],
    ["clear", { grantId: "grant-current" }],
  ]);
});

test("Dashboard renders and revokes an orphan grant by exact grantId", async () => {
  const { root, automationCalls } = await loadDashboard([], { status: "ok" }, {
    sessionAutomationOrphans: [{
      agentId: "claude-code",
      sessionId: "ended",
      mode: "auto-tools",
      displayLabel: "Ended project",
      sessionAutomationGrantId: "grant-orphan",
    }],
  });

  assert.strictEqual(byClass(root, "automation-orphan-card").length, 1);
  assert.strictEqual(byClass(root, "automation-orphan-title")[0].textContent, "Ended project");
  const revoke = byClass(root, "automation-orphan-card")[0].children[1];
  await revoke.dispatch("click");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(automationCalls)), [
    ["clear", { grantId: "grant-orphan" }],
  ]);
});

test("Dashboard keeps session automation failure feedback visible after rerender", async () => {
  const { root } = await loadDashboard([
    session("configurable", {
      canConfigureSessionAutomation: true,
      sessionAutomationMode: "inherit",
    }),
  ], { status: "ok" }, {}, { status: "full" });
  const select = byClass(root, "session-automation-select")[0];
  select.value = "auto-tools";
  await select.dispatch("change");

  assert.strictEqual(byClass(root, "session-automation-select")[0].value, "inherit");
  assert.strictEqual(
    byClass(root, "session-automation-feedback")[0].textContent,
    "Could not update session automation."
  );
});

test("HUD unfocusable single-click explains why and offers folder only for local non-webui", async () => {
  const { root } = await loadHud([
    session("local"),
    session("remote", { sourceType: "ssh", host: "host" }),
    session("webui", { platform: "webui" }),
  ]);
  const rows = byClass(root, "row-unfocusable");
  assert.deepStrictEqual(rows.map((row) => row.title), [
    "This session did not provide terminal window information.",
    "Remote sessions cannot focus a terminal on this computer.",
    "WebUI sessions do not have a local terminal window.",
  ]);
  // Official single-click semantics: an unfocusable row explains itself
  // inline instead of jumping.
  await rows[0].dispatch("click");
  assert.strictEqual(
    byClass(root, "session-inline-feedback")[0].textContent,
    "This session did not provide terminal window information."
  );
  assert.strictEqual(byClass(root, "open-folder-button").length, 1);
});

test("HUD folder click sends only id and exposes open failure", async () => {
  const { root, openCalls } = await loadHud([session("local")], { status: "not-available" });
  await byClass(root, "open-folder-button")[0].dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);
  assert.strictEqual(byClass(root, "session-inline-feedback")[0].textContent, "This folder is no longer available.");
});

test("HUD preserves folder pending state across snapshot renders", async () => {
  let resolveOpen;
  const pendingResult = new Promise((resolve) => { resolveOpen = resolve; });
  const harness = await loadHud([session("local")], () => pendingResult);

  const clickPromise = byClass(harness.root, "open-folder-button")[0].dispatch("click");
  await flush();
  harness.pushSnapshot();

  const replacementButton = byClass(harness.root, "open-folder-button")[0];
  assert.strictEqual(replacementButton.disabled, true);
  await replacementButton.dispatch("click");
  assert.deepStrictEqual(harness.openCalls, [["local"]]);

  resolveOpen({ status: "ok" });
  await clickPromise;
  assert.strictEqual(byClass(harness.root, "open-folder-button")[0].disabled, false);
});

test("HUD feedback survives snapshot renders and clears on its timeout", async () => {
  const harness = await loadHud([session("local")]);
  await byClass(harness.root, "row-unfocusable")[0].dispatch("click");
  harness.pushSnapshot();
  assert.strictEqual(
    byClass(harness.root, "session-inline-feedback")[0].textContent,
    "This session did not provide terminal window information."
  );

  await harness.expireFeedback();
  assert.strictEqual(byClass(harness.root, "session-inline-feedback").length, 0);
  assert.strictEqual(byClass(harness.root, "title")[0].textContent, "local");
});

test("unfocusable and folder feedback copy exists in all supported languages", () => {
  const keys = [
    "dashboardOpenFolder",
    "sessionOpenFolderFailed",
    "sessionOpenFolderUnavailable",
    "sessionFocusUnavailableRemote",
    "sessionFocusUnavailableWebui",
    "sessionFocusUnavailableMissingTerminalInfo",
  ];
  for (const lang of SUPPORTED_LANGS) {
    for (const key of keys) assert.ok(i18n[lang][key], `${lang}.${key} is required`);
  }
});

test("Dashboard shows a model row only for sessions that report one", async () => {
  const { root } = await loadDashboard([
    session("with-model", { model: "claude-opus-5" }),
    session("without-model"),
  ]);

  const rows = byClass(root, "model-row");
  assert.strictEqual(rows.length, 1, "only the session reporting a model gets a row");
  assert.strictEqual(rows[0].textContent, "Model: claude-opus-5");
  // Long ids are ellipsized by CSS, so the full value must stay reachable.
  assert.strictEqual(rows[0].title, "claude-opus-5");
});

test("model row is its own line, not a chip inside the clipped meta row", async () => {
  // Regression guard: `.meta` is a single nowrap+overflow-hidden line, so a
  // model appended there is invisible at the dashboard's default 480px width.
  const { root } = await loadDashboard([session("with-model", { model: "claude-opus-5" })]);

  const meta = byClass(root, "meta")[0];
  assert.ok(meta, "meta row must still render");
  assert.ok(
    !descendants(meta).some((el) => String(el.textContent || "").includes("claude-opus-5")),
    "the model must not live inside the clipped meta row"
  );
  assert.strictEqual(byClass(root, "model-row").length, 1);
});

test("model copy exists in all supported languages", () => {
  for (const lang of SUPPORTED_LANGS) {
    assert.ok(i18n[lang].dashboardModel, `${lang}.dashboardModel is required`);
  }
});


test("HUD trellis icon button is the sole panel entry; panel rows jump to the dashboard", async () => {
  const { root, openCalls } = await loadHud([
    { id: "s1", agentId: "claude-code", cwd: "/proj", state: "working", trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: { done: 1, total: 2 }, parallelCount: 1 } },
  ]);
  // vm DOM: find elements via class walk
  const byCls = (el, cls) => {
    const out = [];
    if (el.classList && el.classList.contains(cls)) out.push(el);
    for (const child of (el.children || [])) out.push(...byCls(child, cls));
    return out;
  };
  const btn = byCls(root, "trellis-btn")[0];
  assert.ok(btn, "the trellis toggle button renders beside the pin");
  assert.strictEqual(btn.title, "Trellis tasks");
  assert.ok(!btn.classList.contains("active"), "closed panel leaves the button unlit");
  await btn.dispatch("click");
  await flush();
  const panel = byCls(root, "trellis-task-panel");
  assert.equal(panel.length, 1, "the icon click opens the panel below the rows");
  assert.ok(byCls(root, "trellis-panel-row").length >= 2, "active + archived rows render");
  assert.ok(byCls(panel[0], "trellis-panel-summary-title").some((el) => el.textContent.includes("Current")),
    "panel header keeps the owner task as its first summary row");
  assert.ok(byCls(root, "trellis-btn")[0].classList.contains("active"),
    "an open panel highlights the button");
  assert.equal(byCls(root, "trellis-panel-hint").length, 0,
    "the dblclick footer hint is gone (double-click has no separate semantics)");
  const rows = byCls(root, "trellis-panel-row");
  rows[0].dispatch ? rows[0].dispatch("click") : rows[0].click();
  assert.ok(openCalls.some((c) => c[0] === "openTrellisTask" && c[1] && c[1].taskPath === ".trellis/tasks/09-27-x"),
    "row click sends the jump payload");
  byCls(root, "trellis-panel-all")[0].dispatch("click");
  assert.ok(openCalls.some((c) => c[0] === "openTrellisTask" && c[1] && c[1].taskPath === ""),
    "view-all click sends the dashboard-only payload");
  // The icon again closes the panel.
  await byCls(root, "trellis-btn")[0].dispatch("click");
  await flush();
  assert.equal(byCls(root, "trellis-task-panel").length, 0, "second icon click closes");
  assert.ok(!byCls(root, "trellis-btn")[0].classList.contains("active"),
    "closing the panel drops the highlight");
});

test("panel header lists every session's trellis task, not just the owner's (09-29)", async () => {
  const { root } = await loadHud([
    { id: "s1", agentId: "claude-code", cwd: "/proj", state: "working", trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: { done: 1, total: 2 }, parallelCount: 1, command: "trellis-check" } },
    { id: "s2", agentId: "claude-code", cwd: "/proj2", state: "working", trellis:
      { taskPath: ".trellis/tasks/09-28-sec", title: "Second", phase: "plan", progress: { done: 3, total: 7 }, parallelCount: 1 } },
  ]);
  const byCls = (el, cls) => {
    const out = [];
    if (el.classList && el.classList.contains(cls)) out.push(el);
    for (const child of (el.children || [])) out.push(...byCls(child, cls));
    return out;
  };
  await byCls(root, "trellis-btn")[0].dispatch("click");
  await flush();
  const panel = byCls(root, "trellis-task-panel")[0];
  assert.ok(panel, "the icon click opens the panel");
  const names = byCls(panel, "trellis-panel-summary-title").map((el) => el.textContent);
  assert.ok(names.some((s) => s.includes("Current")), "owner task heads the panel");
  assert.ok(names.some((s) => s.includes("Second")),
    "the other session's task gets its own header row");
  const sides = byCls(panel, "trellis-panel-summary-side").map((el) => el.textContent);
  assert.ok(sides.includes("trellis-check"), "side slot prefers the running command");
  assert.ok(sides.includes("3/7"), "side slot falls back to the step count without a command");
});
test("HUD trellis panel polls fresh disk state; closing clears its timer (09-28 trellis-freshness-time)", async () => {
  let panel = { status: "ok", projects: [
    { cwd: "/proj", name: "proj", active: [
      { taskPath: ".trellis/tasks/09-27-x", title: "Task X", phase: "execute", progress: { done: 1, total: 3 } },
    ], archived: [] },
  ] };
  const h = await loadHud([
    { id: "s1", agentId: "claude-code", cwd: "/proj", state: "working" },
  ], { status: "ok" }, () => panel);
  const byCls = (el, cls) => {
    const out = [];
    if (el.classList && el.classList.contains(cls)) out.push(el);
    for (const child of (el.children || [])) out.push(...byCls(child, cls));
    return out;
  };
  const part = (row, cls) => (row.children || []).find((child) => child.classList && child.classList.contains(cls));
  const rowsFor = (title) => byCls(h.root, "trellis-panel-row").filter((row) => {
    const label = part(row, "trellis-panel-row-title");
    return label && label.textContent === title;
  });

  const btn = byCls(h.root, "trellis-btn")[0];
  await btn.dispatch("click");
  await flush();
  const coldRows = rowsFor("Task X");
  assert.equal(coldRows.length, 1, "the cold open renders the active task");
  assert.ok(part(coldRows[0], "trellis-dot-execute"), "it renders as in-progress");
  assert.equal(part(coldRows[0], "trellis-panel-row-side").textContent, "1/3");
  const coldCalls = h.openCalls.filter((c2) => c2[0] === "getTrellisPanel").length;
  assert.ok(coldCalls >= 1, "the cold open fetched the panel");

  // Meanwhile the task archived on disk — a poll tick must show it.
  panel = { status: "ok", projects: [
    { cwd: "/proj", name: "proj", active: [], archived: [
      { taskPath: ".trellis/tasks/archive/2026-09/09-27-x", title: "Task X", completedAt: "2026-09-28T10:00:00.000Z" },
    ] },
  ] };
  h.fireIntervals();
  await flush();
  assert.ok(h.openCalls.filter((c2) => c2[0] === "getTrellisPanel").length > coldCalls,
    "the poll re-fetched the panel");
  const freshRows = rowsFor("Task X");
  assert.equal(freshRows.length, 1, "the fresh result re-rendered the row");
  assert.ok(part(freshRows[0], "trellis-dot-done"), "the archived task shows the done dot");
  assert.equal(part(freshRows[0], "trellis-panel-row-side").textContent, "09-28",
    "the archived row shows the completion date");

  // Closing the panel clears its poll timer — no more fetches.
  await btn.dispatch("click");
  await flush();
  assert.ok(h.clearedIntervals.length >= 1, "closing the panel cleared an interval");
  const afterClose = h.openCalls.filter((c2) => c2[0] === "getTrellisPanel").length;
  h.fireIntervals();
  await flush();
  assert.equal(h.openCalls.filter((c2) => c2[0] === "getTrellisPanel").length, afterClose,
    "no fetch after the poll timer is cleared");
});

test("HUD trellis panel renders one section per project; rows jump with their own cwd", async () => {
  const { root, openCalls } = await loadHud([
    { id: "s1", agentId: "claude-code", cwd: "/proj", state: "working", trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: { done: 1, total: 2 }, parallelCount: 1 } },
  ], { status: "ok" }, { status: "ok", projects: [
    { cwd: "/proj", name: "proj", active: [
      { taskPath: ".trellis/tasks/09-27-x", title: "Task X", phase: "execute", progress: { done: 1, total: 3 } },
    ], archived: [] },
    { cwd: "/other/app", name: "app", active: [], archived: [
      { taskPath: ".trellis/tasks/archive/2026-09/09-20-old", title: "Old", completedAt: "2026-09-20T10:00:00.000Z" },
    ] },
  ] });
  const byCls = (el, cls) => {
    const out = [];
    if (el.classList && el.classList.contains(cls)) out.push(el);
    for (const child of (el.children || [])) out.push(...byCls(child, cls));
    return out;
  };
  const btn = byCls(root, "trellis-btn")[0];
  await btn.dispatch("click");
  await flush();
  const heads = byCls(root, "trellis-panel-project");
  assert.deepEqual(heads.map((el) => el.textContent), ["proj", "app"],
    "one project section header per project, anchor first");
  assert.strictEqual(heads[1].title, "/other/app", "the full cwd rides the section header tooltip");
  const rows = byCls(root, "trellis-panel-row");
  assert.strictEqual(rows.length, 2);
  (rows[1].dispatch ? rows[1].dispatch("click") : rows[1].click());
  assert.ok(openCalls.some((c) => c[0] === "openTrellisTask"
    && c[1] && c[1].taskPath === ".trellis/tasks/archive/2026-09/09-20-old"
    && c[1].cwd === "/other/app"),
    "a row from the second project's section jumps with THAT project's cwd, not the anchor's");
});

test("HUD trellis panel header renders the workflow-state line when no command exists (09-28)", async () => {
  const { root } = await loadHud([
    { id: "s1", agentId: "claude-code", cwd: "/proj", state: "working", trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: { done: 1, total: 2 }, parallelCount: 1,
        workflowStatus: "planning", workflowNextAction: "Load `trellis-brainstorm`; stay in planning" } },
  ]);
  const byCls = (el, cls) => {
    const out = [];
    if (el.classList && el.classList.contains(cls)) out.push(el);
    for (const child of (el.children || [])) out.push(...byCls(child, cls));
    return out;
  };
  await byCls(root, "trellis-btn")[0].dispatch("click");
  await flush();
  const rows = byCls(byCls(root, "trellis-task-panel")[0], "trellis-panel-summary");
  assert.strictEqual(rows.length, 1, "one header summary row for the owner");
  assert.ok(String(rows[0].title).includes("step 1/2"), "the step hint lives on in the row tooltip");
  assert.ok(String(rows[0].title).includes("planning — Load `trellis-brainstorm`; stay in planning"),
    "ws-only 'Status — Next-Action' passthrough keeps its tooltip slot (no command, no i18n key)");
  assert.strictEqual(byCls(rows[0], "trellis-panel-summary-side")[0].textContent,
    "Load `trellis-brainstorm`; stay in planning",
    "the side slot shows the live skill, not the phase word");
});

test("HUD trellis panel outlives its binding; closes when the owner session goes", async () => {
  const h = await loadHud([
    { id: "s1", agentId: "claude-code", cwd: "/proj", state: "working", trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: null, parallelCount: 1 } },
  ]);
  const byCls = (el, cls) => {
    const out = [];
    if (el.classList && el.classList.contains(cls)) out.push(el);
    for (const child of (el.children || [])) out.push(...byCls(child, cls));
    return out;
  };
  await byCls(h.root, "trellis-btn")[0].dispatch("click");
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 1);
  // The binding vanishes (task archived → pointer cleared) while the session
  // row stays on screen: the panel keeps serving from disk — hud-panel-entry.
  await h.pushSnapshot([
    { id: "s1", agentId: "claude-code", cwd: "/proj", state: "working" },
  ]);
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 1,
    "binding gone but owner row alive → panel stays");
  // The owner session itself disappears → panel closes.
  await h.pushSnapshot([session("other")]);
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 0,
    "owner row gone → panel closes");
});

test("HUD icon click without a cwd-bearing session is a no-op", async () => {
  const h = await loadHud([session("nowhere", { cwd: null })]);
  await byClass(h.root, "trellis-btn")[0].dispatch("click");
  await flush();
  assert.ok(!h.openCalls.some((c) => c[0] === "getTrellisPanel"),
    "no cwd anchor → no fetch, no panel");
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0);
});

test("HUD row single-click is the official jump: bell dismiss, focus, ack — never a panel", async () => {
  const h = await loadHud([
    { id: "bound", agentId: "claude-code", cwd: "/proj", state: "working", badge: "done",
      updatedAt: Date.now(), canFocus: true, trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: null, parallelCount: 1 } },
    session("unbound", { badge: "done" }),
  ]);

  // Fresh done badges render unread bells so the dismissal below is
  // falsifiable (a broken unread pipeline must not pass vacuously).
  assert.equal(byClass(h.root, "unread-bell").length, 2, "fresh done badges render unread bells");
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  assert.deepStrictEqual(h.focusCalls, ["bound"], "single click jumps to the terminal");
  assert.deepStrictEqual(h.ackCalls, ["bound"], "ack rides the single click");
  assert.equal(byClass(h.root, "unread-bell").length, 1,
    "the click repaints its own dismissed bell away");
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0,
    "the row click never opens the panel");
  assert.ok(!h.openCalls.some((c) => c[0] === "getTrellisPanel"),
    "the row click never fetches the panel");

  // An unfocusable row shows the inline reason instead of jumping.
  await byClass(h.root, "row")[1].dispatch("click");
  await flush();
  assert.equal(h.focusCalls.length, 1, "the unfocusable row adds no focus call");
});

test("HUD row single-click on a cwd without .trellis still leaves no panel behind", async () => {
  // The row click is the official jump now — the fetch-based "missing"
  // cleanup only runs through the icon button, and the row path never
  // opens a panel in the first place.
  const h = await loadHud(
    [session("plain", { canFocus: true })],
    { status: "ok" },
    { status: "missing" }
  );
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  assert.ok(!h.openCalls.some((c) => c[0] === "getTrellisPanel"),
    "a row click triggers no panel fetch at all");
  assert.deepStrictEqual(h.focusCalls, ["plain"], "the row click jumps");
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0,
    "no panel residue");
});

test("HUD icon click on a cwd without .trellis leaves no panel behind", async () => {
  // The icon entry trusts the fetch, not the binding: a cwd that answers
  // "missing" opens nothing and leaves nothing on screen.
  const h = await loadHud(
    [session("plain")],
    { status: "ok" },
    { status: "missing" }
  );
  await byClass(h.root, "trellis-btn")[0].dispatch("click");
  await flush();
  assert.ok(h.openCalls.some((c) => c[0] === "getTrellisPanel" && c[1] && c[1].cwd === "/safe/project"),
    "the icon click still fetches — the fetch decides, not the binding");
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0,
    "a missing answer closes the panel before it ever shows");
});

test("HUD row single-click jump keeps an open panel alive", async () => {
  const h = await loadHud([
    { id: "bound", agentId: "claude-code", cwd: "/proj", state: "working", badge: "done",
      updatedAt: Date.now(), canFocus: true, trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: null, parallelCount: 1 } },
  ]);

  await byClass(h.root, "trellis-btn")[0].dispatch("click");
  await flush();
  assert.equal(byClass(h.root, "trellis-task-panel").length, 1, "the icon opens the panel");
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  assert.deepStrictEqual(h.focusCalls, ["bound"], "the row click jumps to the terminal");
  assert.equal(byClass(h.root, "trellis-task-panel").length, 1,
    "the jump keeps the panel open — the owner row stays expanded");
  assert.ok(byClass(h.root, "trellis-btn")[0].classList.contains("active"),
    "the button highlight stays with the panel");
});

test("two row single clicks are two jumps — double-click has no separate semantics", async () => {
  const h = await loadHud([
    { id: "bound", agentId: "claude-code", cwd: "/proj", state: "working", badge: "done",
      updatedAt: Date.now(), canFocus: true, trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: null, parallelCount: 1 } },
  ]);

  // A physical double-click is click, click, dblclick on the same spot;
  // with no dblclick handler that is just two official single clicks. Every
  // click re-renders, so re-query the row the way a fresh hit-test would.
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  assert.deepStrictEqual(h.focusCalls, ["bound", "bound"], "each physical click jumps");
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0, "no panel ever opens");
  // One ack per physical click. Main's ackSessionCompletion is idempotent
  // (second ack = noop), so two acks for one double-click are safe.
  assert.deepStrictEqual(h.ackCalls, ["bound", "bound"], "ack rides each click");
});

test("trellis toggle tooltip exists in all supported languages and the dblclick hint key is gone", () => {
  for (const lang of SUPPORTED_LANGS) {
    assert.ok(i18n[lang].sessionHudTrellisToggleTooltip, `${lang}.sessionHudTrellisToggleTooltip is required`);
    assert.ok(!i18n[lang].sessionHudTrellisPanelDblclickHint, `${lang}.sessionHudTrellisPanelDblclickHint must be gone`);
  }
});
