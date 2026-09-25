"use strict";

// Boundary tests for the Trellis IPC layer: channel registration, the
// controller-only roots write, the platform-id whitelist, and the
// "only a real .trellis project may be upgraded" admission rule.
//
// The real runtime is wired to a fake cli, so nothing spawns and every
// assertion about "no process ran" is a call counter, not a mock of the layer
// under test.

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { registerTrellisIpc, PROGRESS_CHANNEL } = require("../src/trellis-ipc");
const scanner = require("../src/trellis-scanner");
const prefs = require("../src/prefs");

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-ipc-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeProject(root, name, version = "0.6.17") {
  const projectPath = path.join(root, name);
  fs.mkdirSync(path.join(projectPath, ".trellis"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, ".trellis", ".version"), `${version}\n`);
  fs.writeFileSync(
    path.join(projectPath, ".trellis", ".template-hashes.json"),
    JSON.stringify({ __version: 2, hashes: { ".claude/x": "h" } })
  );
  return projectPath;
}

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
  }

  handle(channel, listener) {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  invoke(channel, payload, event = { sender: "settings" }) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener(event, payload);
  }
}

function makeFakeCli(overrides = {}) {
  const calls = { fetchRemoteChannels: 0, readGlobalVersion: 0, updateProject: 0, upgradeGlobal: 0, addPlatforms: 0 };
  const cli = {
    calls,
    async fetchRemoteChannels() {
      calls.fetchRemoteChannels += 1;
      return { channels: { latest: "0.6.17", beta: "0.7.0-beta.4" }, error: null };
    },
    async readGlobalVersion() {
      calls.readGlobalVersion += 1;
      return { installed: true, version: "0.6.17", error: null };
    },
    async updateProject(projectPath) {
      calls.updateProject += 1;
      return { ok: true, reason: null, from: "0.6.17", to: "0.7.0-beta.4", output: "updated", error: null };
    },
    async upgradeGlobal() {
      calls.upgradeGlobal += 1;
      return { ok: true, reason: null, from: "0.6.17", to: "0.6.18", output: "upgraded", error: null };
    },
    async addPlatforms(projectPath, platformIds) {
      calls.addPlatforms += 1;
      return { ok: true, reason: null, added: platformIds.slice(), output: "added", error: null };
    },
  };
  return Object.assign(cli, overrides);
}

function createHarness(options = {}) {
  const ipcMain = new FakeIpcMain();
  const cli = options.cli || makeFakeCli();
  const snapshot = { trellisScanRoots: options.roots || [] };
  const updates = [];
  const settingsController = options.settingsController || {
    getSnapshot: () => ({ ...snapshot }),
    applyUpdate(key, value) {
      updates.push([key, value]);
      if (options.updateResult) return options.updateResult;
      snapshot[key] = value;
      return { status: "ok" };
    },
  };
  const progress = [];
  const runtimeHandle = registerTrellisIpc({
    ipcMain,
    settingsController,
    scanner,
    cli,
    dialog: options.dialog || null,
    getSettingsWindow: () => null,
    sendToSettings: (channel, payload) => progress.push([channel, payload]),
    // Phase-5 digest source for the scan payload (see withActiveTasks).
    ...("getActivityByProject" in options ? { getActivityByProject: options.getActivityByProject } : {}),
    // The trust gate is fail-closed in production; these tests exercise the
    // handler bodies, so they opt in with a permissionless guard. Passing
    // `isTrustedEvent: null` explicitly keeps the guard absent.
    isTrustedEvent: "isTrustedEvent" in options ? options.isTrustedEvent : (() => true),
  });
  return { ipcMain, cli, settingsController, updates, progress, runtimeHandle };
}

const CHANNELS = [
  "settings:trellis-scan",
  "settings:trellis-pick-root",
  "settings:trellis-set-roots",
  "settings:trellis-preview",
  "settings:trellis-upgrade-project",
  "settings:trellis-upgrade-all",
  "settings:trellis-cancel-batch",
  "settings:trellis-add-platform",
  "settings:trellis-upgrade-global",
];

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

describe("trellis IPC registration", () => {
  it("registers every design §4.2 channel and removes them on dispose", () => {
    const h = createHarness();
    for (const channel of CHANNELS) assert.ok(h.ipcMain.handlers.has(channel), channel);
    h.runtimeHandle.dispose();
    for (const channel of CHANNELS) assert.ok(!h.ipcMain.handlers.has(channel), channel);
  });

  it("set-roots normalizes and writes through settings-controller only", async () => {
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-set-roots", {
      roots: [" /projects/a ", "/projects/a", "/projects/b"],
    });
    assert.deepStrictEqual(result, { status: "ok", roots: ["/projects/a", "/projects/b"] });
    assert.deepStrictEqual(h.updates, [["trellisScanRoots", ["/projects/a", "/projects/b"]]]);

    const bad = await h.ipcMain.invoke("settings:trellis-set-roots", { roots: "/projects/a" });
    assert.strictEqual(bad.status, "error");
    assert.strictEqual(h.updates.length, 1, "a rejected payload must not reach the controller");
  });

  it("surfaces a controller refusal as an error envelope", async () => {
    const h = createHarness({ updateResult: { status: "error", message: "nope" } });
    const result = await h.ipcMain.invoke("settings:trellis-set-roots", { roots: ["/projects/a"] });
    assert.deepStrictEqual(result, { status: "error", message: "nope" });
  });

  it("pick-root reports cancel and passes the picked directory through", async () => {
    const dialog = {
      async showOpenDialog() { return { canceled: true, filePaths: [] }; },
    };
    const cancelled = createHarness({ dialog });
    assert.deepStrictEqual(await cancelled.ipcMain.invoke("settings:trellis-pick-root"), { status: "cancel" });

    const picked = { async showOpenDialog() { return { canceled: false, filePaths: ["/projects/a"] }; } };
    const ok = createHarness({ dialog: picked });
    assert.deepStrictEqual(await ok.ipcMain.invoke("settings:trellis-pick-root"), {
      status: "ok",
      path: "/projects/a",
    });
  });

  it("scan forwards the roots snapshot and asks for remote channels once", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha");
    const h = createHarness({ roots: [root] });
    const result = await h.ipcMain.invoke("settings:trellis-scan");
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.roots, [root]);
    assert.deepStrictEqual(result.projects.map((p) => p.path), [projectPath]);
    assert.strictEqual(h.cli.calls.fetchRemoteChannels, 1);
    assert.strictEqual(result.projects[0].platforms[0], "claude-code");
  });

  it("ships the platform catalog so the renderer needs no local copy", async () => {
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-scan");
    assert.strictEqual(result.status, "ok");

    const catalog = result.platformCatalog;
    assert.ok(Array.isArray(catalog));
    // Projected straight from trellis-platforms PLATFORMS - the table the
    // main process also whitelists add-platform ids against.
    const { PLATFORMS } = require("../src/trellis-platforms");
    assert.deepStrictEqual(
      catalog.map((entry) => entry.id),
      PLATFORMS.map((entry) => entry.id),
    );
    for (const entry of catalog) {
      assert.strictEqual(typeof entry.label, "string");
      assert.ok(entry.label.length > 0, entry.id);
    }
  });
  it("ships the channel catalog so the renderer needs no local copy", async () => {
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-scan");
    assert.strictEqual(result.status, "ok");
    const { REMOTE_CHANNELS } = require("../src/trellis-cli");
    assert.deepStrictEqual(result.channelCatalog, Array.from(REMOTE_CHANNELS));
  });

  it("honours a whitelisted channel and treats anything else as auto", async () => {
    const root = makeTmpDir();
    makeProject(root, "alpha", "0.6.17");

    // Auto: the installed version (0.6.17, no prerelease) routes to `latest`.
    const auto = createHarness({ roots: [root] });
    const autoResult = await auto.ipcMain.invoke("settings:trellis-scan", {});
    assert.strictEqual(autoResult.projects[0].channel, "latest");
    assert.strictEqual(autoResult.projects[0].upgradable, false);

    const beta = createHarness({ roots: [root] });
    const betaResult = await beta.ipcMain.invoke("settings:trellis-scan", { channel: "beta" });
    assert.strictEqual(betaResult.projects[0].channel, "beta");
    assert.strictEqual(betaResult.projects[0].target, "0.7.0-beta.4");
    assert.strictEqual(betaResult.projects[0].upgradable, true);

    // An unknown value is not an error and not an override: the default wins.
    const bogus = createHarness({ roots: [root] });
    const bogusResult = await bogus.ipcMain.invoke("settings:trellis-scan", { channel: "--evil" });
    assert.strictEqual(bogusResult.status, "ok");
    assert.strictEqual(bogusResult.projects[0].channel, "latest");
  });

  it("attaches the read-only active-task digest to scanned projects", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "digest");
    const digestCalls = [];
    const h = createHarness({
      roots: [root],
      getActivityByProject: (p) => {
        digestCalls.push(p);
        if (p === projectPath) return [{ title: "A", phase: "execute" }, { title: "B", phase: "plan" }];
        return null;
      },
    });

    const result = await h.ipcMain.invoke("settings:trellis-scan");
    assert.strictEqual(result.status, "ok");
    const row = result.projects.find((p) => p.path === projectPath);
    assert.ok(row, "scanned row present");
    assert.deepStrictEqual(row.activeTasks, [{ title: "A", phase: "execute" }, { title: "B", phase: "plan" }]);
    assert.deepStrictEqual(digestCalls, [projectPath]);
  });

  it("leaves rows untouched when the digest is absent, null, or malformed", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "nodigest");
    // A throwing getter must degrade exactly like a null one.
    const h = createHarness({
      roots: [root],
      getActivityByProject: () => { throw new Error("cache missing"); },
    });
    const result = await h.ipcMain.invoke("settings:trellis-scan");
    const row = result.projects.find((p) => p.path === projectPath);
    assert.ok(row);
    assert.strictEqual("activeTasks" in row, false);

    // Malformed entries are dropped; if nothing survives, no field at all.
    const junk = createHarness({
      roots: [root],
      getActivityByProject: () => [{ title: "A", phase: 42 }, { title: "", phase: "plan" }, "junk"],
    });
    const junkResult = await junk.ipcMain.invoke("settings:trellis-scan");
    const junkRow = junkResult.projects.find((p) => p.path === projectPath);
    assert.strictEqual("activeTasks" in junkRow, false);
  });

  it("gives every stale platform its own read-only repair command", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha");
    // The record names .claude but the directory is absent -> stale.
    const h = createHarness({ roots: [root] });
    const result = await h.ipcMain.invoke("settings:trellis-scan");
    const project = result.projects[0];
    assert.deepStrictEqual(project.staleIds, ["claude-code"]);
    assert.deepStrictEqual(project.staleFixes.map((fix) => fix.id), ["claude-code"]);
    assert.deepStrictEqual(project.staleFixes[0].command, {
      bin: "trellis",
      // 09-25: -u <folder-name> rides init (fresh repairs abort without it).
      args: ["init", "-u", "alpha", "--claude", "-y"],
      cwd: projectPath,
    });
    assert.strictEqual(h.cli.calls.addPlatforms, 0, "the repair command is displayed, never executed");
  });

  it("reports only the missing platform in the stale fix list", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha");
    fs.writeFileSync(
      path.join(projectPath, ".trellis", ".template-hashes.json"),
      JSON.stringify({ __version: 2, hashes: { ".claude/x": "h", ".gemini/y": "h" } })
    );
    fs.mkdirSync(path.join(projectPath, ".claude"));
    const h = createHarness({ roots: [root] });
    const result = await h.ipcMain.invoke("settings:trellis-scan");
    const project = result.projects[0];
    assert.deepStrictEqual(project.platforms, ["claude-code", "gemini"]);
    assert.deepStrictEqual(project.staleIds, ["gemini"]);
    assert.deepStrictEqual(project.staleFixes.map((fix) => fix.id), ["gemini"]);
    assert.deepStrictEqual(project.staleFixes[0].command.args, ["init", "-u", "alpha", "--gemini", "-y"]);
  });
});

describe("trellis IPC write boundaries", () => {
  it("refuses to upgrade a directory without .trellis and never spawns", async () => {
    const root = makeTmpDir();
    const fake = path.join(root, "not-a-project");
    fs.mkdirSync(fake);
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-upgrade-project", { path: fake });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(h.cli.calls.updateProject, 0);
  });

  it("upgrades a real project and returns the before/after versions", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha");
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-upgrade-project", { path: projectPath });
    assert.deepStrictEqual(result, {
      status: "ok",
      from: "0.6.17",
      to: "0.7.0-beta.4",
      message: "",
      output: "updated",
    });
    assert.strictEqual(h.cli.calls.updateProject, 1);
  });

  it("batch upgrade skips non-Trellis paths and streams progress to the settings window", async () => {
    const root = makeTmpDir();
    const a = makeProject(root, "a");
    const b = makeProject(root, "b");
    const notTrellis = path.join(root, "plain");
    fs.mkdirSync(notTrellis);

    const h = createHarness();
    const started = await h.ipcMain.invoke("settings:trellis-upgrade-all", { paths: [a, notTrellis, b] });
    assert.strictEqual(started.status, "ok");
    assert.strictEqual(started.skipped, 1);

    assert.ok(await waitFor(() => h.progress.some(([, p]) => p.phase === "done")), "batch should finish");
    const phases = h.progress.map(([, p]) => p.phase);
    assert.deepStrictEqual(phases.filter((phase) => phase === "queued").length, 2);
    assert.deepStrictEqual(phases.filter((phase) => phase === "ok").length, 2);
    assert.strictEqual(h.progress.every(([channel]) => channel === PROGRESS_CHANNEL), true);
    assert.deepStrictEqual(
      h.progress.find(([, p]) => p.phase === "done")[1].summary,
      { total: 2, ok: 2, failed: 0, cancelled: 0 }
    );
  });

  it("add-platform fails closed on anything outside the platform-id whitelist", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha");
    const h = createHarness();

    for (const bad of [["--evil"], ["pi; rm -rf /"], ["nope"], "gemini", []]) {
      const result = await h.ipcMain.invoke("settings:trellis-add-platform", { path: projectPath, platforms: bad });
      assert.strictEqual(result.status, "error", JSON.stringify(bad));
      assert.deepStrictEqual(result.added, []);
    }
    assert.strictEqual(h.cli.calls.addPlatforms, 0, "renderer input must never reach the CLI layer");
  });

  it("add-platform passes known ids through for a real project", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha");
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-add-platform", {
      path: projectPath,
      platforms: ["gemini", "pi"],
    });
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.added, ["gemini", "pi"]);
    assert.strictEqual(h.cli.calls.addPlatforms, 1);
  });
});

describe("trellis roots through the real settings-controller", () => {
  it("commits the normalized list and rejects un-normalized input", async () => {
    const { createSettingsController } = require("../src/settings-controller");
    const controller = createSettingsController({
      loadResult: { snapshot: prefs.getDefaults(), locked: false },
    });
    const h = createHarness({ settingsController: controller });

    const result = await h.ipcMain.invoke("settings:trellis-set-roots", {
      roots: [" /projects/a ", "/projects/a", "/projects/b"],
    });
    assert.deepStrictEqual(result, { status: "ok", roots: ["/projects/a", "/projects/b"] });
    assert.deepStrictEqual(controller.get("trellisScanRoots"), ["/projects/a", "/projects/b"]);

    // The validator is the second line of defence: a caller that skips the
    // IPC normalizer still cannot persist a dirty list.
    const dirty = await controller.applyUpdate("trellisScanRoots", [" /projects/c "]);
    assert.strictEqual(dirty.status, "error");
    assert.deepStrictEqual(controller.get("trellisScanRoots"), ["/projects/a", "/projects/b"]);
  });
});

describe("trellis IPC preview and global upgrade", () => {
  it("preview spawns nothing and reports the command that would run", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha");
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-preview", { paths: [projectPath] });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.plan.length, 1);
    assert.deepStrictEqual(result.plan[0].command, {
      bin: "trellis",
      args: ["update", "--force", "--migrate"],
      cwd: projectPath,
    });
    assert.deepStrictEqual(Object.values(h.cli.calls), [0, 0, 0, 0, 0]);
  });

  it("preview with platforms returns the add-platform plan for every whitelisted path", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha");
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-preview", {
      paths: [plain, projectPath],
      platforms: ["gemini"],
    });
    assert.strictEqual(result.status, "ok");
    // 09-25: NOT filtered on isTrellisProject anymore — first-time install
    // previews flow through the same branch (the init command IS the plan).
    assert.strictEqual(result.addPlan.length, 2);
    for (const entry of result.addPlan) {
      assert.deepStrictEqual(entry.added, ["gemini"]);
      assert.deepStrictEqual(entry.command.args, ["init", "-u", path.basename(entry.path), "--gemini", "-y"]);
    }
    assert.deepStrictEqual(Object.values(h.cli.calls), [0, 0, 0, 0, 0]);
  });

  it("preview rejects unknown platform ids without spawning", async () => {
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-preview", { paths: ["/p"], platforms: ["--evil"] });
    assert.strictEqual(result.status, "error");
    assert.deepStrictEqual(Object.values(h.cli.calls), [0, 0, 0, 0, 0]);
  });

  it("preview honours the channel override without spawning", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha", "0.6.17");
    const h = createHarness();
    // The channel cache is filled by a scan; preview itself stays pure.
    await h.ipcMain.invoke("settings:trellis-scan", { channel: "beta" });
    const callsAfterScan = { ...h.cli.calls };
    const result = await h.ipcMain.invoke("settings:trellis-preview", {
      paths: [projectPath],
      channel: "beta",
    });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.plan[0].channel, "beta");
    assert.strictEqual(result.plan[0].to, "0.7.0-beta.4");
    assert.deepStrictEqual(result.plan[0].command, {
      bin: "trellis",
      args: ["update", "--force", "--migrate"],
      cwd: projectPath,
    });
    assert.deepStrictEqual(h.cli.calls, callsAfterScan, "preview spawns nothing");
  });

  it("forwards a chosen channel and rejects an unknown one before the cli", async () => {
    const seen = [];
    const cli = makeFakeCli({
      async upgradeGlobal(channel) {
        seen.push(channel);
        return { ok: true, reason: null, from: "0.6.17", to: "0.6.18", output: "upgraded", error: null };
      },
    });
    const h = createHarness({ cli });

    const beta = await h.ipcMain.invoke("settings:trellis-upgrade-global", { channel: "beta" });
    assert.strictEqual(beta.status, "ok");
    assert.deepStrictEqual(seen, ["beta"]);

    const auto = await h.ipcMain.invoke("settings:trellis-upgrade-global", {});
    assert.strictEqual(auto.status, "ok");
    assert.deepStrictEqual(seen, ["beta", undefined], "an empty channel keeps the cli's own default");

    for (const channel of ["next", "--force", "latest; rm -rf /"]) {
      const result = await h.ipcMain.invoke("settings:trellis-upgrade-global", { channel });
      assert.strictEqual(result.status, "error", channel);
      assert.strictEqual(result.message, "unknown-channel", channel);
    }
    assert.deepStrictEqual(seen, ["beta", undefined], "an unknown channel never reaches the cli");
  });

  it("upgrade-global wraps the cli result in the ok envelope", async () => {
    const h = createHarness();
    const result = await h.ipcMain.invoke("settings:trellis-upgrade-global");
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.from, "0.6.17");
    assert.strictEqual(result.to, "0.6.18");
    assert.strictEqual(h.cli.calls.upgradeGlobal, 1);
  });

  it("refuses every channel when no trust guard is wired", async () => {
    const h = createHarness({ isTrustedEvent: null });
    for (const channel of CHANNELS) {
      const result = await h.ipcMain.invoke(channel, {});
      assert.deepStrictEqual(result, { status: "error", message: "untrusted-sender" }, channel);
    }
    // No channel reached the cli, and nothing was written to prefs.
    assert.deepStrictEqual(Object.values(h.cli.calls), [0, 0, 0, 0, 0]);
    assert.strictEqual(h.updates.length, 0);
  });

  it("treats a throwing trust guard as untrusted instead of leaking the error", async () => {
    const h = createHarness({
      isTrustedEvent: () => { throw new Error("guard exploded: /secret/path"); },
    });
    for (const channel of CHANNELS) {
      const result = await h.ipcMain.invoke(channel, {});
      assert.deepStrictEqual(result, { status: "error", message: "untrusted-sender" }, channel);
      assert.strictEqual(String(result.message).includes("secret"), false, channel);
    }
    assert.deepStrictEqual(Object.values(h.cli.calls), [0, 0, 0, 0, 0]);
    assert.strictEqual(h.updates.length, 0);
  });

  it("refuses an untrusted sender while still serving a trusted one", async () => {
    const sawEvent = [];
    const h = createHarness({
      isTrustedEvent: (event) => {
        sawEvent.push(event);
        return Boolean(event && event.sender === "settings");
      },
    });

    const denied = await h.ipcMain.invoke(
      "settings:trellis-upgrade-project",
      { path: "/p" },
      { sender: "pet" },
    );
    assert.deepStrictEqual(denied, { status: "error", message: "untrusted-sender" });

    const allowed = await h.ipcMain.invoke("settings:trellis-scan", {}, { sender: "settings" });
    assert.strictEqual(allowed.status, "ok");

    assert.strictEqual(sawEvent.length, 2);
    // The denied call never reached the cli; the trusted scan still did.
    assert.strictEqual(h.cli.calls.updateProject, 0, "denied call must not reach the cli");
    assert.strictEqual(h.cli.calls.fetchRemoteChannels, 1, "trusted scan still runs");
  });
});
