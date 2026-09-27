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
    sessionHudTrellisPanelDblclickHint: "Double-click a session row to open its terminal",
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

async function loadHud(sessions, openResult = { status: "ok" }) {
  const document = createDocument(["hud"]);
  const openCalls = [];
  const focusCalls = [];
  const ackCalls = [];
  let snapshotListener = null;
  let feedbackTimeout = null;
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
      return { status: "ok", active: [
        { taskPath: ".trellis/tasks/09-27-x", title: "Task X", phase: "execute", progress: { done: 1, total: 3 } },
      ], archived: [
        { taskPath: ".trellis/tasks/archive/2026-09/09-20-old", title: "Old", completedAt: "2026-09-20T10:00:00.000Z" },
      ] };
    },
    openTrellisTask: (payload) => { openCalls.push(["openTrellisTask", payload]); },
  };
  const context = vm.createContext({
    window: { sessionHudAPI: api }, document, console, Date,
    setInterval: () => 0,
    setTimeout: (callback) => { feedbackTimeout = callback; return 1; },
    clearTimeout: () => { feedbackTimeout = null; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8"), context);
  await flush();
  snapshotListener({ sessions, orderedIds: sessions.map((entry) => entry.id) });
  return {
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

test("HUD unfocusable double-click explains why and offers folder only for local non-webui", async () => {
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
  // Unbound single click is a strict no-op (no feedback either).
  await rows[0].dispatch("click");
  assert.strictEqual(byClass(root, "session-inline-feedback").length, 0);
  await rows[0].dispatch("dblclick");
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
  await byClass(harness.root, "row-unfocusable")[0].dispatch("dblclick");
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


test("HUD trellis panel: chip opens the project panel, rows jump to the dashboard", async () => {
  const { root, openCalls, pushSnapshot } = await loadHud([
    { id: "s1", agentId: "claude-code", cwd: "/proj", state: "working", trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: { done: 1, total: 2 }, parallelCount: 1 } },
  ]);
  const chip = root.querySelector ? null : null;
  // vm DOM: find the chip via class walk
  const byCls = (el, cls) => {
    const out = [];
    if (el.classList && el.classList.contains(cls)) out.push(el);
    for (const child of (el.children || [])) out.push(...byCls(child, cls));
    return out;
  };
  const chips = byCls(root, "trellis-chip");
  assert.ok(chips.length === 1, "one chip on the bound session");
  await chips[0].dispatch ? chips[0].dispatch("click") : chips[0].click();
  await flush();
  const panel = byCls(root, "trellis-task-panel");
  assert.equal(panel.length, 1, "panel renders below the rows");
  assert.ok(byCls(root, "trellis-panel-row").length >= 2, "active + archived rows render");
  assert.ok(byCls(panel[0], "trellis-detail-title").some((el) => el.textContent.includes("Current")),
    "panel header keeps the old detail-row task title (tooltip template)");
  const rows = byCls(root, "trellis-panel-row");
  rows[0].dispatch ? rows[0].dispatch("click") : rows[0].click();
  assert.ok(openCalls.some((c) => c[0] === "openTrellisTask" && c[1] && c[1].taskPath === ".trellis/tasks/09-27-x"),
    "row click sends the jump payload");
  // Chip again closes the panel.
  chips[0].dispatch ? chips[0].dispatch("click") : chips[0].click();
  await flush();
  assert.equal(byCls(root, "trellis-task-panel").length, 0, "second click closes");
});

test("HUD trellis panel auto-closes when the binding disappears", async () => {
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
  const chips = byCls(h.root, "trellis-chip");
  chips[0].dispatch ? chips[0].dispatch("click") : chips[0].click();
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 1);
  // Binding gone on the next snapshot → panel closes itself.
  await h.pushSnapshot([
    { id: "s1", agentId: "claude-code", cwd: "/proj", state: "working" },
  ]);
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 0, "no trellis anchor → closed");
});

test("HUD blank-space click toggles the panel anchored to the most recently active bound session", async () => {
  const h = await loadHud([
    { id: "s1", agentId: "claude-code", cwd: "/proj-a", state: "working", trellis:
      { taskPath: ".trellis/tasks/09-27-a", title: "Task A", phase: "plan", progress: null, parallelCount: 1 } },
    { id: "s2", agentId: "claude-code", cwd: "/proj-b", state: "working", trellis:
      { taskPath: ".trellis/tasks/09-27-b", title: "Task B", phase: "execute", progress: null, parallelCount: 1 } },
  ]);
  const byCls = (el, cls) => {
    const out = [];
    if (el.classList && el.classList.contains(cls)) out.push(el);
    for (const child of (el.children || [])) out.push(...byCls(child, cls));
    return out;
  };

  // Blank click (target = the hud container itself) opens the panel on the
  // FIRST bound expanded session — orderedIds is newest-first, so that is
  // the most recently active project. No chip aiming needed.
  await h.root.dispatch("click", { target: h.root });
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 1, "blank click opens the panel");
  assert.ok(
    byCls(h.root, "trellis-detail-title").some((el) => el.textContent.includes("Task A")),
    "the panel anchors to the most recently active bound session"
  );
  assert.ok(h.openCalls.some((c) => c[0] === "getTrellisPanel" && c[1] && c[1].cwd === "/proj-a"));
  assert.ok(!h.openCalls.some((c) => c[0] === "getTrellisPanel" && c[1] && c[1].cwd === "/proj-b"),
    "the older bound session is not fetched");

  // The open panel is content, not blank space — a click on its heading or
  // padding must NOT close it.
  const panelTitle = byCls(h.root, "trellis-detail-title")[0];
  await h.root.dispatch("click", { target: panelTitle });
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 1, "clicks inside the panel never toggle it");
  const panel = byCls(h.root, "trellis-task-panel")[0];
  await h.root.dispatch("click", { target: panel });
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 1, "the panel's own padding never toggles it");

  // Blank click again closes it.
  await h.root.dispatch("click", { target: h.root });
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 0, "second blank click closes the panel");

  // A click landing inside a session row must NOT toggle — the row keeps its
  // focus-terminal meaning. Target is a row's inner title; the handler must
  // find the .row ancestor via the parentNode walk.
  const title = byCls(byCls(h.root, "row")[0], "title")[0];
  await h.root.dispatch("click", { target: title });
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 0, "row clicks never toggle the panel");
});

test("HUD blank-space click without a bound session opens nothing", async () => {
  const h = await loadHud([session("plain")]);
  const byCls = (el, cls) => {
    const out = [];
    if (el.classList && el.classList.contains(cls)) out.push(el);
    for (const child of (el.children || [])) out.push(...byCls(child, cls));
    return out;
  };
  await h.root.dispatch("click", { target: h.root });
  await flush();
  assert.equal(byCls(h.root, "trellis-task-panel").length, 0);
  assert.ok(!h.openCalls.some((c) => c[0] === "getTrellisPanel"), "no anchor → no panel fetch");
});

test("HUD single-click toggles the panel per row; unbound rows open nothing", async () => {
  const h = await loadHud([
    { id: "bound", agentId: "claude-code", cwd: "/proj", state: "working", canFocus: true, trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: null, parallelCount: 1 } },
    session("unbound", { badge: "done" }),
  ]);

  // Single click on the bound row opens the panel anchored to that row.
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  assert.equal(byClass(h.root, "trellis-task-panel").length, 1);
  assert.ok(h.openCalls.some((c) => c[0] === "getTrellisPanel" && c[1] && c[1].cwd === "/proj"),
    "the fetch anchors to the clicked row's cwd");
  assert.equal(h.focusCalls.length, 0, "single click never focuses");
  assert.deepStrictEqual(h.ackCalls, ["bound"], "a click means noticed — ack rides the single click");
  // The panel footer advertises the double-click jump.
  const hint = byClass(h.root, "trellis-panel-hint")[0];
  assert.ok(hint, "panel renders the dblclick hint");
  assert.strictEqual(hint.textContent, "Double-click a session row to open its terminal");

  // Second single click on the same row closes it.
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0);

  // Unbound row: no panel, no fetch, no feedback — but its own unread bell
  // still dismisses (and repaints away) on click.
  assert.equal(byClass(h.root, "unread-bell").length, 1, "the unbound done row carries its bell");
  await byClass(h.root, "row")[1].dispatch("click");
  await flush();
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0);
  assert.equal(byClass(h.root, "unread-bell").length, 0, "the unbound click repaints the dismissed bell away");
  assert.ok(!h.openCalls.some((c) => c[0] === "getTrellisPanel" && c[1] && c[1].cwd === "/safe/project"),
    "unbound row click fetches nothing");
  assert.equal(byClass(h.root, "session-inline-feedback").length, 0, "unbound row click shows no feedback");
  assert.equal(h.focusCalls.length, 0);
  assert.deepStrictEqual(h.ackCalls, ["bound", "bound", "unbound"],
    "every click acks (bell-dismiss per click); unbound clicks still dismiss their own bell");
});

test("HUD double-click is the only jump entry and closes an open panel with it", async () => {
  const h = await loadHud([
    { id: "bound", agentId: "claude-code", cwd: "/proj", state: "working", badge: "done",
      updatedAt: Date.now(), canFocus: true, trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: null, parallelCount: 1 } },
  ]);

  // Precondition: a fresh done badge renders the unread bell, so the
  // dismissal below is falsifiable (a broken unread pipeline must not pass
  // vacuously).
  assert.equal(byClass(h.root, "unread-bell").length, 1, "a fresh done badge renders the unread bell");
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  assert.equal(byClass(h.root, "trellis-task-panel").length, 1);
  assert.equal(byClass(h.root, "unread-bell").length, 0,
    "the single click dismisses the unread bell — noticing is enough");
  assert.deepStrictEqual(h.ackCalls, ["bound"], "ackCompletion rides the single click");

  await byClass(h.root, "row")[0].dispatch("dblclick");
  await flush();
  assert.deepStrictEqual(h.focusCalls, ["bound"], "double click focuses the terminal");
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0, "jumping closes an open panel");
  assert.equal(h.ackCalls.length, 1, "double click does not re-ack — the click already did");
});

test("HUD real-browser double-click (click, click, dblclick) still lands closed and focused", async () => {
  const h = await loadHud([
    { id: "bound", agentId: "claude-code", cwd: "/proj", state: "working", badge: "done",
      updatedAt: Date.now(), canFocus: true, trellis:
      { taskPath: ".trellis/tasks/09-27-cur", title: "Current", phase: "execute", progress: null, parallelCount: 1 } },
  ]);

  // A physical double-click is click, click, dblclick on the same spot:
  // click #1 opens the panel, click #2 toggles it shut, dblclick jumps.
  // Every click re-renders, so re-query the row the way a fresh hit-test
  // would — the final state must still be panel-closed + focused.
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  assert.equal(byClass(h.root, "trellis-task-panel").length, 1, "first click opens the panel");
  await byClass(h.root, "row")[0].dispatch("click");
  await flush();
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0, "second click toggles it shut");
  await byClass(h.root, "row")[0].dispatch("dblclick");
  await flush();
  assert.deepStrictEqual(h.focusCalls, ["bound"], "the full sequence still jumps once");
  assert.equal(byClass(h.root, "trellis-task-panel").length, 0, "final state: panel closed");
  // One ack per physical click; the dblclick itself adds none. Main's
  // ackSessionCompletion is idempotent (second ack = noop), so two acks
  // for one double-click are safe by contract.
  assert.deepStrictEqual(h.ackCalls, ["bound", "bound"], "ack rides each click, none on dblclick");
});
