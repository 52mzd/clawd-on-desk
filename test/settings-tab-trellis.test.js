"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TAB_SOURCE = path.join(__dirname, "..", "src", "settings-tab-trellis.js");

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toUpperCase();
    this.children = [];
    this.eventListeners = {};
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.type = "";
    this.checked = false;
    this.value = "";
    this.title = "";
    this.attributes = {};
    this.parentNode = null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(listener);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  dispatch(type) {
    const event = { type, target: this };
    for (const listener of [...(this.eventListeners[type] || [])]) listener(event);
  }
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function texts(node) {
  const out = [];
  walk(node, (element) => {
    if (element.children.length === 0 && typeof element.textContent === "string") out.push(element.textContent);
  });
  return out;
}

function findButton(root, label) {
  let found = null;
  walk(root, (element) => {
    if (!found && element.tagName === "BUTTON" && element.buttonLabel === label) found = element;
  });
  return found;
}

function findSelect(root, predicate) {
  let found = null;
  walk(root, (element) => {
    if (found || element.tagName !== "SELECT") return;
    if (predicate && !predicate(element)) return;
    found = element;
  });
  return found;
}

// The global CLI picker and the platform picker are both `<select>`s; only the
// global one carries this class marker.
function isGlobalChannelSelect(element) {
  return String(element.className || "").includes("trellis-global-channel");
}

function findPlatformCheckbox(root, label) {
  let found = null;
  walk(root, (element) => {
    if (found || element.tagName !== "INPUT" || element.type !== "checkbox") return;
    const parent = element.parentNode;
    const text = parent && parent.children.find((child) => child.tagName === "SPAN");
    if (text && text.textContent === label) found = element;
  });
  return found;
}

function optionValues(select) {
  return select.children
    .filter((child) => child.tagName === "OPTION")
    .map((child) => child.value);
}

function makeStrings() {
  const keys = [
    "trellisTitle", "trellisSubtitle", "trellisRootsTitle", "trellisRootsEmpty", "trellisAddRoot",
    "trellisRemove", "trellisRefresh", "trellisScanFailed", "trellisScanHint", "trellisNoProjects",
    "trellisProjectsTitle", "trellisColumnVersion", "trellisStatusLatest", "trellisStatusUpgradable",
    "trellisStatusUnknown", "trellisStatusNotInstalled", "trellisStatusFailed", "trellisStatusVersionUnknown",
    "trellisStatusQueued", "trellisStatusRunning", "trellisStatusCancelled", "trellisStatusOk",
    "trellisStaleRecord", "trellisUpgrade", "trellisGlobalUpgrade",
    "trellisUpgradeConfirmTitle", "trellisUpgradeConfirmDetail", "trellisUpgradeConfirmAction",
    "trellisUpgradeDone", "trellisBatchSummary", "trellisPreview", "trellisPreviewTitle",
    "trellisPreviewCommand", "trellisPreviewCwd", "trellisPreviewEmpty", "trellisClose", "trellisCopy",
    "trellisCopied", "trellisFilterTitle", "trellisFilterClear", "trellisFilterEmpty",
    "trellisAddPlatform", "trellisAddPlatformTitle", "trellisAddPlatformSelect", "trellisAddPlatformNone",
    "trellisAddPlatformRun", "trellisAddPlatformAction", "trellisAddPlatformDone", "trellisAddPlatformFailed",
    "trellisRemoteTitle", "trellisRemoteUnavailable", "trellisRetry", "trellisGlobalTitle",
    "trellisGlobalCurrent", "trellisGlobalNotInstalled", "trellisGlobalInstallGuide",
    "trellisGlobalUpgrade", "trellisGlobalUpgraded", "trellisUnknownPlatform",
    "trellisGlobalUpgradeTarget",
    "trellisRootUnreadable", "trellisNoProjectsUnreadable", "trellisChannelAuto",
    "trellisUpgradeAllCount",
    "trellisActiveTasks", "trellisPhasePlan", "trellisPhaseExecute", "trellisPhaseFinish", "trellisPhaseDone",
  ];
  const strings = {};
  for (const key of keys) strings[key] = key;
  // Placeholder-bearing keys are templated so a test can see which platforms
  // actually reached the copy.
  strings.trellisStaleRecord = "stale:{platforms}";
  strings.trellisStaleFix = "fix:{platform}";
  strings.trellisActiveTasks = "active:{tasks}";
  strings.trellisPhasePlan = "P-plan";
  strings.trellisPhaseExecute = "P-execute";
  strings.trellisPhaseFinish = "P-finish";
  strings.trellisPhaseDone = "P-done";
  return strings;
}

function loadTab({ snapshot = { trellisScanRoots: [] }, settingsAPI = {} } = {}) {
  const disposables = [];
  const toasts = [];
  const progressSubscriptions = [];
  let subscribeCount = 0;
  const source = fs.readFileSync(TAB_SOURCE, "utf8");
  const strings = makeStrings();
  const calls = [];
  const api = {
    trellisScan: () => { calls.push("scan"); return Promise.resolve({ status: "ok", roots: [], projects: [], remote: { channels: null, error: "offline" }, global: { installed: false } }); },
    trellisPickRoot: () => { calls.push("pickRoot"); return Promise.resolve({ status: "cancel" }); },
    trellisSetRoots: () => { calls.push("setRoots"); return Promise.resolve({ status: "ok" }); },
    trellisPreview: () => { calls.push("preview"); return Promise.resolve({ status: "ok", plan: [] }); },
    trellisUpgradeProject: () => { calls.push("upgradeProject"); return Promise.resolve({ status: "ok" }); },
    trellisUpgradeAll: () => { calls.push("upgradeAll"); return Promise.resolve({ status: "ok", batchId: "b1" }); },
    trellisCancelBatch: () => { calls.push("cancelBatch"); return Promise.resolve({ status: "ok" }); },
    trellisAddPlatform: () => { calls.push("addPlatform"); return Promise.resolve({ status: "ok", added: [] }); },
    trellisUpgradeGlobal: () => { calls.push("upgradeGlobal"); return Promise.resolve({ status: "ok" }); },
    onTrellisProgress: (cb) => {
      subscribeCount += 1;
      progressSubscriptions.push(cb);
      return () => {
        const index = progressSubscriptions.indexOf(cb);
        if (index >= 0) progressSubscriptions.splice(index, 1);
      };
    },
    ...settingsAPI,
  };

  const context = { console };
  context.globalThis = context;
  context.document = {
    createElement: (tagName) => new FakeElement(tagName),
  };
  context.navigator = { clipboard: { writeText: () => Promise.resolve() } };
  context.window = { settingsAPI: api };
  vm.runInNewContext(source, context);

  const helpers = {
    t: (key) => strings[key] || key,
    buildButton: (config = {}) => {
      const button = new FakeElement("button");
      button.buttonLabel = config.label == null ? "" : String(config.label);
      button.textContent = button.buttonLabel;
      button.disabled = config.disabled === true;
      if (typeof config.onClick === "function") button.addEventListener("click", config.onClick);
      return button;
    },
    setButtonState: (button, patch = {}) => {
      if (typeof patch.disabled === "boolean") button.disabled = patch.disabled;
      return button;
    },
    registerMountedDisposable: (disposable) => {
      disposables.push(disposable);
      return disposable;
    },
    showSettingsConfirmModal: () => Promise.resolve("cancel"),
    buildSection: (title, rows) => {
      const section = new FakeElement("section");
      if (title) {
        const heading = new FakeElement("h2");
        heading.textContent = String(title);
        section.appendChild(heading);
      }
      const wrap = new FakeElement("div");
      for (const row of rows) wrap.appendChild(row);
      section.appendChild(wrap);
      return section;
    },
  };
  const core = {
    state: { snapshot },
    helpers,
    ops: { requestRender: () => {}, showToast: (message) => toasts.push(message) },
    tabs: {},
  };
  context.ClawdSettingsTabTrellis.init(core);
  return {
    core, helpers, api, calls, disposables, toasts, progressSubscriptions,
    get subscribeCount() { return subscribeCount; },
  };
}

// Mirrors the real renderer: `renderContent` disposes mounted controls (which
// unsubscribes the progress listener) before the tab renders again.
function renderPanel(core, session) {
  if (session) {
    for (const disposable of session.disposables.splice(0)) {
      try { disposable.dispose(); } catch {}
    }
  }
  const parent = new FakeElement("div");
  core.tabs.trellis.render(parent);
  return parent;
}

function makeScanResult(overrides = {}) {
  return {
    status: "ok",
    roots: [],
    scans: [],
    projects: [],
    remote: { channels: { latest: "0.6.17" }, error: null },
    global: { installed: true, version: "0.6.17" },
    platformCatalog: [],
    channelCatalog: ["latest", "beta", "rc"],
    ...overrides,
  };
}

async function scanWith(session, result) {
  session.api.trellisScan = () => Promise.resolve(result);
  findButton(renderPanel(session.core, session), "trellisRefresh").dispatch("click");
  await flushPromises();
}

describe("settings-tab-trellis", () => {
  it("renders the empty-state guidance before anything is scanned", () => {
    const { core } = loadTab();
    const panel = renderPanel(core);
    const rendered = texts(panel);
    assert.ok(rendered.includes("trellisRootsEmpty"), "should guide the user to add a folder");
    assert.ok(rendered.includes("trellisScanHint"), "should prompt an explicit refresh");
    assert.ok(rendered.includes("trellisGlobalNotInstalled") === false, "global state is unknown before a scan");
  });

  it("adds a picked folder through the prefs-writing channel only", async () => {
    const { core, calls, api } = loadTab();
    // 09-25 auto-scan on first render: silence the default scan stub so the
    // calls array stays about the pickRoot flow only.
    api.trellisScan = () => Promise.resolve({ status: "error" });
    api.trellisPickRoot = () => { calls.push("pickRoot"); return Promise.resolve({ status: "ok", path: "/tmp/projects" }); };
    api.trellisSetRoots = (roots) => { calls.push(["setRoots", roots]); return Promise.resolve({ status: "ok" }); };
    const panel = renderPanel(core);
    findButton(panel, "trellisAddRoot").dispatch("click");
    await flushPromises();
    assert.deepStrictEqual(calls[0], "pickRoot");
    assert.strictEqual(calls[1][0], "setRoots");
    assert.deepStrictEqual(Array.from(calls[1][1]), ["/tmp/projects"]);
  });

  it("does not write anything when the folder picker is cancelled", async () => {
    const { core, calls, api } = loadTab();
    // 09-25 auto-scan on first render: silence the default scan stub.
    api.trellisScan = () => Promise.resolve({ status: "error" });
    const panel = renderPanel(core);
    findButton(panel, "trellisAddRoot").dispatch("click");
    await flushPromises();
    assert.deepStrictEqual(calls, ["pickRoot"]);
  });

  it("scans once per refresh click and the retired preview button is gone", async () => {
    const { core, calls, api } = loadTab();
    api.trellisScan = () => {
      calls.push("scan");
      return Promise.resolve({
        status: "ok",
        roots: [],
        projects: [{ path: "/tmp/a", name: "a", installed: true, current: "0.6.0", target: "0.7.0", upgradable: true, platforms: ["claude-code"], staleRecord: false }],
        remote: { channels: { latest: "0.7.0" }, error: null },
        global: { installed: true, version: "0.6.0" },
      });
    };
    const panel = renderPanel(core);
    findButton(panel, "trellisRefresh").dispatch("click");
    await flushPromises();

    // 09-25: the standalone preview button/panel is retired — the wizard
    // owns previews. The button must not render at all.
    const afterScan = renderPanel(core);
    assert.strictEqual(findButton(afterScan, "trellisPreview"), null,
      "preview button removed from the toolbar");
    assert.deepStrictEqual(calls, ["scan"]);
    for (const write of ["upgradeProject", "upgradeAll", "addPlatform", "upgradeGlobal", "setRoots"]) {
      assert.ok(!calls.includes(write), `scan must not call ${write}`);
    }
  });

  it("builds the platform picker from the scanned catalog, not a local copy", async () => {
    const session = loadTab();
    session.api.trellisScan = () => Promise.resolve({
      status: "ok",
      roots: [],
      projects: [{
        path: "/tmp/a", name: "a", installed: true, current: "0.6.0", target: "0.6.0",
        upgradable: false, platforms: ["claude-code"], staleRecord: false,
      }],
      remote: { channels: null, error: "offline" },
      global: { installed: true, version: "0.6.0" },
      // The catalog is the only source of picker options; a local table would
      // drift from src/trellis-platforms.js and silently offer stale platforms.
      // 09-25: the inline panel is gone — the catalog feeds the wizard chips;
      // the project row renders registered/unregistered chips from it.
      platformCatalog: [
        { id: "claude-code", label: "Claude Code" },
        { id: "gemini", label: "Gemini CLI" },
      ],
    });

    findButton(renderPanel(session.core, session), "trellisRefresh").dispatch("click");
    await flushPromises();

    const panel = renderPanel(session.core, session);
    const chips = [];
    walk(panel, (element) => {
      const cls = element.className || "";
      if (typeof cls === "string" && /\btrellis-platform-chip(?!-row)\b/.test(cls)) {
        chips.push({ cls, label: element.textContent, tag: element.tagName });
      }
    });
    // registered claude-code chip only (09-25 feedback): unregistered
    // platforms no longer render in the row — they live in the wizard.
    assert.strictEqual(chips.length, 1);
    assert.ok(chips.some((c) => c.cls.includes("is-registered") && c.label.includes("Claude Code")));
    assert.ok(!chips.some((c) => c.cls.includes("is-unregistered")), "no unregistered chips in the row");
  });

  it("offers no picker options before a scan has supplied the catalog", () => {
    const { core } = loadTab();
    const panel = renderPanel(core);
    assert.strictEqual(findSelect(panel), null);
  });

  it("keeps unknown (null) versions out of the upgrade path", async () => {
    const { core, api } = loadTab();
    api.trellisScan = () => Promise.resolve({
      status: "ok",
      roots: [],
      projects: [
        { path: "/tmp/known", name: "known", installed: true, current: "0.6.0", target: "0.7.0", upgradable: true, platforms: [], staleRecord: false },
        { path: "/tmp/unknown", name: "unknown", installed: true, current: "0.7.0", target: null, upgradable: null, platforms: [], staleRecord: false },
      ],
      remote: { channels: null, error: "offline" },
      global: { installed: true, version: "0.6.0" },
    });
    const panel = renderPanel(core);
    findButton(panel, "trellisRefresh").dispatch("click");
    await flushPromises();

    const rendered = renderPanel(core);
    const upgradeButtons = [];
    walk(rendered, (element) => {
      if (element.tagName === "BUTTON" && element.buttonLabel === "trellisUpgradePreview") upgradeButtons.push(element);
    });
    assert.strictEqual(upgradeButtons.length, 2);
    assert.strictEqual(upgradeButtons[0].disabled, false, "upgradable project keeps its action");
    assert.strictEqual(upgradeButtons[1].disabled, true, "unknown target must not offer an upgrade");
    assert.ok(texts(rendered).includes("trellisStatusUnknown"), "unknown renders as unknown, never as up to date");
    assert.ok(!texts(rendered).includes("trellisStatusLatest"), "null must not collapse into latest");
  });

  it("keeps exactly one live progress subscription across renders", () => {
    const session = loadTab();
    renderPanel(session.core, session);
    renderPanel(session.core, session);
    renderPanel(session.core, session);
    assert.strictEqual(session.progressSubscriptions.length, 1, "no leaked listeners");
    assert.strictEqual(session.subscribeCount, 3, "one subscription per mount");
  });
});

describe("settings-tab-trellis degradation and scoping", () => {
  it("distinguishes an unreadable scan folder from an empty one", async () => {
    const session = loadTab();
    await scanWith(session, makeScanResult({
      roots: ["/tmp/missing"],
      scans: [{ root: "/tmp/missing", readable: false, projects: [] }],
    }));

    const rendered = texts(renderPanel(session.core, session));
    assert.ok(rendered.includes("trellisRootUnreadable"), "the root is marked unreadable");
    assert.ok(rendered.includes("trellisNoProjectsUnreadable"), "the empty table explains why");
    assert.ok(!rendered.includes("trellisNoProjects"), "must not claim the folder simply has no subfolders");
  });

  it("still reports an empty folder as empty, not unreadable", async () => {
    const session = loadTab();
    await scanWith(session, makeScanResult({
      roots: ["/tmp/emptied"],
      scans: [{ root: "/tmp/emptied", readable: true, projects: [] }],
    }));

    const rendered = texts(renderPanel(session.core, session));
    assert.ok(rendered.includes("trellisNoProjects"));
    assert.ok(!rendered.includes("trellisRootUnreadable"));
    assert.ok(!rendered.includes("trellisNoProjectsUnreadable"));
  });

  it("names only the missing platform in the stale warning and shows its repair command", async () => {
    const session = loadTab();
    await scanWith(session, makeScanResult({
      platformCatalog: [{ id: "gemini", label: "Gemini CLI" }],
      projects: [{
        path: "/tmp/root/p", name: "p", installed: true, current: "0.6.17", target: "0.6.17",
        upgradable: false, platforms: ["claude-code", "gemini"], staleIds: ["gemini"], staleRecord: true,
        staleFixes: [{
          id: "gemini",
          label: "Gemini CLI",
          command: { bin: "trellis", args: ["init", "--gemini", "-y"], cwd: "/tmp/root/p" },
        }],
      }],
    }));

    const rendered = renderPanel(session.core, session);
    const titles = [];
    walk(rendered, (element) => { if (element.title) titles.push(element.title); });
    assert.ok(titles.includes("stale:Gemini CLI"), `stale warning names only the missing platform: ${titles}`);
    assert.ok(!titles.some((title) => title.includes("Claude Code")), "a present platform is not accused");
    assert.ok(texts(rendered).includes("trellis init --gemini -y"), "the repair command is visible");
  });

  it("re-scans via the global card refresh and sends no channel by default (09-25: the duplicate project-channel picker is removed)", async () => {
    const session = loadTab();
    const requests = [];
    session.api.trellisScan = (payload) => {
      requests.push(payload);
      return Promise.resolve(makeScanResult());
    };

    findButton(renderPanel(session.core, session), "trellisRefresh").dispatch("click");
    await flushPromises();
    assert.deepStrictEqual(Object.keys(requests[0]), [], "auto sends no channel at all");

    // The project-channel filter select no longer exists (merged into the
    // single global channel select); auto stays the only default.
    const dupes = [];
    walk(renderPanel(session.core, session), (el) => {
      if (el.tagName === "SELECT" && !isGlobalChannelSelect(el)) dupes.push(el);
    });
    assert.deepStrictEqual(dupes, [], "no second channel picker anywhere");
  });

  it("renders no digest when the project has no active tasks", async () => {
    const session = loadTab();
    await scanWith(session, makeScanResult({
      projects: [{
        path: "/tmp/root/q", name: "q", installed: true, current: "0.6.17", target: "0.6.17",
        upgradable: false, platforms: [], staleIds: [], staleRecord: false,
      }],
    }));

    const rendered = texts(renderPanel(session.core, session));
    assert.ok(rendered.some((text) => typeof text === "string" && text.includes("/tmp/root/q")), "row renders");
    assert.ok(!rendered.some((text) => typeof text === "string" && text.includes("active:")), "no digest");
  });
});

describe("settings-tab-trellis global CLI", () => {
  it("leads the page with the global block, right under the subtitle", async () => {
    const session = loadTab();
    await scanWith(session, makeScanResult());

    const panel = renderPanel(session.core, session);
    assert.strictEqual(panel.children[0].tagName, "H1");
    assert.strictEqual(panel.children[1].className, "subtitle");
    assert.ok(
      texts(panel.children[2]).includes("trellisGlobalTitle"),
      "the global CLI block comes before the scan roots"
    );
  });

  it("offers auto plus every known channel, each labelled with its version", async () => {
    const session = loadTab();
    await scanWith(session, makeScanResult({
      remote: { channels: { latest: "0.6.17", beta: "0.7.0-beta.4", rc: "0.6.0-rc.0" }, error: null },
    }));

    const select = findSelect(renderPanel(session.core, session), isGlobalChannelSelect);
    assert.ok(select, "the global section exposes a channel picker");
    assert.deepStrictEqual(optionValues(select), ["", "latest", "beta", "rc"]);
    assert.deepStrictEqual(select.children.map((child) => child.textContent), [
      "trellisChannelAuto",
      "latest (0.6.17)",
      "beta (0.7.0-beta.4)",
      "rc (0.6.0-rc.0)",
    ]);
  });

  it("sends the chosen tag to the global upgrade and nothing for auto", async () => {
    const session = loadTab();
    const payloads = [];
    session.api.trellisUpgradeGlobal = (payload) => {
      payloads.push(payload);
      return Promise.resolve({ status: "ok", from: "0.6.17", to: "0.7.0-beta.4" });
    };
    await scanWith(session, makeScanResult({
      remote: { channels: { latest: "0.6.17", beta: "0.7.0-beta.4" }, error: null },
    }));

    const select = findSelect(renderPanel(session.core, session), isGlobalChannelSelect);
    select.value = "beta";
    select.dispatch("change");
    findButton(renderPanel(session.core, session), "trellisGlobalUpgrade").dispatch("click");
    await flushPromises();
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].channel, "beta");
  });

  it("falls back to auto alone when the remote versions are unknown", async () => {
    const session = loadTab();
    await scanWith(session, makeScanResult({ remote: { channels: null, error: "offline" } }));

    const select = findSelect(renderPanel(session.core, session), isGlobalChannelSelect);
    assert.ok(select, "the picker still renders");
    assert.deepStrictEqual(optionValues(select), [""], "only auto survives a failed remote lookup");
  });
});
