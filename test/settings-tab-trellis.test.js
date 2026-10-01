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
    "trellisCliInstallsTitle", "trellisCliInstallExtra", "trellisCliInstallLatest",
    "trellisCliVersionLabel", "trellisCliPathLabel", "trellisCopyCleanup",
  ];
  const strings = {};
  for (const key of keys) strings[key] = key;
  // Placeholder-bearing keys are templated so a test can see which platforms
  // actually reached the copy.
  strings.trellisStaleRecord = "stale:{platforms}";
  strings.trellisStaleFix = "fix:{platform}";
  strings.trellisActiveTasks = "active:{tasks}";
  strings.trellisCliInstallsTitle = "installs:{count}";
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
  const clipboardWrites = [];
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
  context.navigator = {
    clipboard: { writeText: (text) => { clipboardWrites.push(text); return Promise.resolve(); } },
  };
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
      // Mirror the real helper (settings-ui-core's resolveButtonLabel): both
      // `label` and `labelKey` replace the visible text.
      if (
        Object.prototype.hasOwnProperty.call(patch, "label")
        || Object.prototype.hasOwnProperty.call(patch, "labelKey")
      ) {
        const next = patch.label != null ? String(patch.label) : String(patch.labelKey || "");
        button.buttonLabel = next;
        button.textContent = next;
      }
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
    core, helpers, api, calls, disposables, toasts, progressSubscriptions, clipboardWrites,
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
  // 10-01 trellis-cli-roots-unify: the resolved binary path is the one clue
  // that makes a stale duplicate CLI install visible next to the version.
  it("shows the resolved CLI path next to the global version when the scan reports one", async () => {
    const session = loadTab();
    session.api.trellisScan = () => Promise.resolve(makeScanResult({
      global: { installed: true, version: "0.3.10", path: "/usr/local/bin/trellis" },
    }));
    findButton(renderPanel(session.core, session), "trellisRefresh").dispatch("click");
    await flushPromises();

    const panel = renderPanel(session.core, session);
    assert.ok(
      texts(panel).some((text) => text.includes("/usr/local/bin/trellis")),
      "the duplicate-install clue must be visible",
    );
  });

  it("renders no CLI path node when the scan cannot resolve one", async () => {
    const session = loadTab();
    session.api.trellisScan = () => Promise.resolve(makeScanResult({
      global: { installed: true, version: "0.6.17" },
    }));
    findButton(renderPanel(session.core, session), "trellisRefresh").dispatch("click");
    await flushPromises();

    const panel = renderPanel(session.core, session);
    let sawPathNode = false;
    walk(panel, (element) => {
      const cls = typeof element.className === "string" ? element.className : "";
      if (/\btrellis-cli-path\b/.test(cls)) sawPathNode = true;
    });
    assert.strictEqual(sawPathNode, false, "no path, no node — nothing to guess");
  });

  // 10-01 multi-detect (revised): two installs render as a list — version age
  // (outdated) decides "safe to remove", the in-use badge marks what Clawd
  // itself resolves, and the cleanup command is displayed as text so the copy
  // button is never a mystery box.
  it("lists every discovered install with version-rank badges and a visible copy-only cleanup", async () => {
    const session = loadTab();
    const cleanup = "sudo npm uninstall -g @mindfoldhq/trellis --prefix /usr/local";
    session.api.trellisScan = () => Promise.resolve(makeScanResult({
      global: {
        installed: true,
        version: "0.7.0-beta.4",
        path: "/h/.npm-global/bin/trellis",
        installs: [
          { path: "/h/.npm-global/bin/trellis", version: "0.7.0-beta.4", active: true, cleanup: null, outdated: false },
          { path: "/usr/local/bin/trellis", version: "0.3.10", active: false, cleanup, outdated: true },
        ],
      },
    }));
    findButton(renderPanel(session.core, session), "trellisRefresh").dispatch("click");
    await flushPromises();

    const panel = renderPanel(session.core, session);
    const rendered = texts(panel);
    assert.ok(rendered.includes("installs:2"), "the count reaches the copy");
    assert.ok(rendered.some((text) => text.includes("/h/.npm-global/bin/trellis")));
    assert.ok(rendered.some((text) => text.includes("/usr/local/bin/trellis")));
    assert.ok(!rendered.includes("trellisCliInstallActive"), "the spec'd format has no in-use badge");
    assert.ok(rendered.includes("trellisCliInstallLatest"), "the newest install is labelled Latest");
    assert.ok(rendered.includes("trellisCliInstallExtra"), "the older install is labelled removable");
    assert.ok(
      rendered.some((text) => text.includes("0.7.0-beta.4"))
        && rendered.some((text) => text.includes("0.3.10")),
      "versions render per row",
    );
    assert.ok(rendered.includes(cleanup), "the cleanup command is displayed, not just copied blind");

    // One inline flow per install (ui-flow field spec): "N. <rank badge>
    // Version: v Install path: p" — numbered entries newest-first, every
    // line at the same left edge as the heading above it.
    const installRows = [];
    walk(panel, (element) => {
      const cls = typeof element.className === "string" ? element.className : "";
      if (cls.split(/\s+/).includes("trellis-cli-install-row")) installRows.push(element);
    });
    assert.deepStrictEqual(
      installRows.map((row) => row.children.map((child) => child.textContent)),
      [
        ["1.", "trellisCliInstallLatest", "trellisCliVersionLabel 0.7.0-beta.4", "trellisCliPathLabel", "/h/.npm-global/bin/trellis"],
        ["2.", "trellisCliInstallExtra", "trellisCliVersionLabel 0.3.10", "trellisCliPathLabel", "/usr/local/bin/trellis"],
      ],
      "N. <rank badge> Version: v Install path: p — one inline flow per install",
    );

    // The command line (with its copy button) rides the outdated install only.
    // Exact-class match: a `\b` regex would also hit `-cmd-text` (the hyphen
    // counts as a boundary).
    const cmdRows = [];
    walk(panel, (element) => {
      const cls = typeof element.className === "string" ? element.className : "";
      if (cls.split(/\s+/).includes("trellis-cli-install-cmd")) cmdRows.push(element);
    });
    assert.strictEqual(cmdRows.length, 1);
    const copyButton = findButton(cmdRows[0], "trellisCopyCleanup");
    assert.ok(copyButton, "the command line carries a copy button");
    copyButton.dispatch("click");
    await flushPromises();
    assert.deepStrictEqual(session.clipboardWrites, [cleanup]);
    assert.ok(session.toasts.includes("trellisCopied"));
  });

  it("renders a legacy installs payload without outdated fields and without command rows", async () => {
    // A payload shaped like the pre-revision build must degrade to the
    // "latest" badge branch — no crash, no cleanup command line.
    const session = loadTab();
    session.api.trellisScan = () => Promise.resolve(makeScanResult({
      global: {
        installed: true,
        version: "0.6.17",
        path: "/a/trellis",
        installs: [
          { path: "/a/trellis", version: "0.6.17", active: true, cleanup: "rm -f /a/trellis" },
          { path: "/b/trellis", version: "0.6.17", active: false, cleanup: "rm -f /b/trellis" },
        ],
      },
    }));
    findButton(renderPanel(session.core, session), "trellisRefresh").dispatch("click");
    await flushPromises();

    const panel = renderPanel(session.core, session);
    const rendered = texts(panel);
    assert.ok(rendered.includes("installs:2"));
    assert.ok(rendered.filter((text) => text === "trellisCliInstallLatest").length >= 2, "every row degrades to Latest");
    assert.ok(!rendered.some((text) => text.includes("rm -f")), "no outdated verdict, no cleanup line");
    let sawCmdRow = false;
    walk(panel, (element) => {
      const cls = typeof element.className === "string" ? element.className : "";
      if (cls.split(/\s+/).includes("trellis-cli-install-cmd")) sawCmdRow = true;
    });
    assert.ok(!sawCmdRow);
  });

  it("renders no install list for a single install or a payload without installs", async () => {
    const session = loadTab();
    session.api.trellisScan = () => Promise.resolve(makeScanResult({
      global: {
        installed: true,
        version: "0.6.17",
        path: "/usr/local/bin/trellis",
        installs: [{ path: "/usr/local/bin/trellis", version: "0.6.17", active: true, cleanup: null }],
      },
    }));
    findButton(renderPanel(session.core, session), "trellisRefresh").dispatch("click");
    await flushPromises();
    assert.ok(!hasInstallRows(renderPanel(session.core, session)), "one install is the status quo, not a list");

    // Old payload shape (no installs key at all) stays silent too.
    session.api.trellisScan = () => Promise.resolve(makeScanResult({
      global: { installed: true, version: "0.6.17", path: "/usr/local/bin/trellis" },
    }));
    findButton(renderPanel(session.core, session), "trellisRefresh").dispatch("click");
    await flushPromises();
    assert.ok(!hasInstallRows(renderPanel(session.core, session)), "missing installs renders nothing");
  });

  function hasInstallRows(root) {
    let saw = false;
    walk(root, (element) => {
      const cls = typeof element.className === "string" ? element.className : "";
      if (/\btrellis-cli-install-row\b/.test(cls)) saw = true;
    });
    return saw;
  }

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

  it("disables the upgrade button while in flight, refuses re-entry, and restores it on failure", async () => {
    const session = loadTab();
    const calls = [];
    let settle = null;
    session.api.trellisUpgradeGlobal = (payload) => {
      calls.push(payload);
      return new Promise((resolve) => { settle = resolve; });
    };
    await scanWith(session, makeScanResult());

    const button = findButton(renderPanel(session.core, session), "trellisGlobalUpgrade");
    assert.ok(button, "the global upgrade button renders");
    assert.strictEqual(button.disabled, false, "it starts enabled");

    button.dispatch("click");
    await flushPromises();

    assert.strictEqual(button.disabled, true, "must be disabled while the install runs");
    assert.strictEqual(
      button.buttonLabel,
      "trellisStatusRunning",
      "and relabelled to the running state",
    );

    button.dispatch("click");
    await flushPromises();
    assert.strictEqual(calls.length, 1, "a second click must not spawn a concurrent install");

    settle({ status: "error", message: "boom" });
    await flushPromises();
    assert.strictEqual(button.disabled, false, "a failed upgrade restores the button");
    assert.strictEqual(button.buttonLabel, "trellisGlobalUpgrade", "and its label");
  });

  it("keeps the upgrade button disabled when the card is rebuilt mid-flight", async () => {
    const session = loadTab();
    let settle = null;
    session.api.trellisUpgradeGlobal = () => new Promise((resolve) => { settle = resolve; });
    await scanWith(session, makeScanResult());

    const button = findButton(renderPanel(session.core, session), "trellisGlobalUpgrade");
    button.dispatch("click");
    await flushPromises();
    assert.strictEqual(button.disabled, true, "disabled while in flight");

    // A rebuild (e.g. the user hits refresh mid-upgrade) must RENDER the
    // in-flight state rather than clear it — otherwise the button comes back
    // enabled and a second install can be spawned concurrently.
    const rebuilt = findButton(renderPanel(session.core, session), "trellisStatusRunning");
    assert.ok(rebuilt, "the rebuilt card still shows the running label");
    assert.strictEqual(rebuilt.disabled, true, "and the button stays disabled across the rebuild");

    settle({ status: "ok", from: "0.6.17", to: "0.7.0-beta.4" });
    await flushPromises();
  });
});
