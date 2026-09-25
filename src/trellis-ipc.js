"use strict";

// ── Trellis IPC ──
//
// Thin adapter between `window.settingsAPI.trellis*` and `trellis-runtime`.
// Every handler validates its payload, delegates, and answers with the shared
// `{ status: "ok" | "cancel" | "error", ... }` envelope.
//
// Two rules are enforced here because they are capability boundaries:
//
//   1. The renderer may only send platform *ids*. They are checked against the
//      PLATFORMS table before anything reaches `trellis-cli`, so a compromised
//      renderer cannot widen the argv surface with `"--evil"` or shell text.
//   2. `trellis update --force` only ever runs against a directory that
//      `.trellis/` proves is a Trellis project (never a guess, never a parent).
//
//   3. Every channel is gated on the Settings-window trust test shared with
//      `settings-ipc.js` (`isTrustedEvent`, injected by `main.js`). When it is
//      absent or throws, this surface refuses every call instead of guessing.
//      Without that gate any renderer — pet, bubble, dashboard — could spawn a
//      CLI write.
//
// Nothing in this file schedules work: no timer, no watcher, no startup task.
// A write happens only because a Settings button invoked one of these channels.

const defaultPrefs = require("./prefs");
const path = require("path");
const defaultScanner = require("./trellis-scanner");
const { createTrellisCli, TRELLIS_BIN, INIT_ARGS, INIT_ARGS_SUFFIX, REMOTE_CHANNELS } = require("./trellis-cli");
const { createTrellisRuntime, normalizeChannel } = require("./trellis-runtime");
const { PLATFORMS, isKnownPlatformId, flagsFor, platformLabel } = require("./trellis-platforms");

// Single source of truth for the platform picker. The renderer cannot require
// main-process modules, so the list travels over IPC instead of being copied
// there, where the two tables would drift apart unnoticed. `cliFlag` is display
// only: the renderer can show it in a copyable repair command, but add-platform
// still accepts ids alone and re-maps them here.
const PLATFORM_CATALOG = PLATFORMS.map(({ id, label, cliFlag }) => ({ id, label, cliFlag }));

// Same reasoning for the channel picker.
const CHANNEL_CATALOG = Array.from(REMOTE_CHANNELS);

const PROGRESS_CHANNEL = "settings:trellis-progress";

function requireDependency(value, name) {
  if (!value) throw new Error(`registerTrellisIpc requires ${name}`);
  return value;
}

function errorResult(err) {
  const message = (err && err.message) || String(err || "error");
  return { status: "error", message };
}

// Roots travel to prefs, so they pass through the same normalizer the schema
// uses. A non-array or a non-string entry fails closed instead of being
// silently dropped.
function normalizeRoots(value, prefs = defaultPrefs) {
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string")) return null;
  return prefs.normalizePathList(value);
}

function validPaths(value) {
  return (Array.isArray(value) ? value : []).filter((entry) => typeof entry === "string" && entry);
}

// The stale-record repair command, built here and rendered read-only by the
// Settings tab. A platform whose config directory is missing is already in
// `platforms`, so the add-platform picker cannot offer it; without this the
// user would see the warning but have no way to get the command. Clawd never
// runs it — only the copy button consumes it.
function withStaleFixes(projects) {
  if (!Array.isArray(projects)) return [];
  return projects.map((project) => {
    const staleIds = Array.isArray(project.staleIds) ? project.staleIds : [];
    if (staleIds.length === 0) return project;
    const staleFixes = staleIds.map((id) => {
      const flags = flagsFor([id]);
      return {
        id,
        label: platformLabel(id),
        command: flags && flags.length > 0
          ? { bin: TRELLIS_BIN, args: [...INIT_ARGS, "-u", path.basename(String(project.path)) || "clawd", ...flags, ...INIT_ARGS_SUFFIX], cwd: project.path }
          : null,
      };
    });
    return { ...project, staleFixes };
  });
}

// Phase 5 (R5): attach each project's active-task digest (title + phase) to
// the scan payload. The data comes from the read-only trellis-activity
// polling cache (main injects the getter); a null digest leaves the row
// untouched so the tab renders exactly as before. Only the {title, phase}
// projection crosses the boundary — the digest carries no extra paths.
function withActiveTasks(projects, getActivityByProject) {
  if (typeof getActivityByProject !== "function" || !Array.isArray(projects)) return projects;
  return projects.map((project) => {
    if (!project || typeof project.path !== "string") return project;
    let digest = null;
    try {
      digest = getActivityByProject(project.path);
    } catch {
      digest = null;
    }
    if (!Array.isArray(digest) || digest.length === 0) return project;
    const activeTasks = digest
      .filter((task) => task && typeof task.title === "string" && task.title && typeof task.phase === "string")
      .map((task) => ({ title: task.title, phase: task.phase }));
    if (activeTasks.length === 0) return project;
    return { ...project, activeTasks };
  });
}

function registerTrellisIpc(options = {}) {
  const ipcMain = requireDependency(options.ipcMain, "ipcMain");
  const settingsController = requireDependency(options.settingsController, "settingsController");
  const dialog = options.dialog || null;
  const prefs = options.prefs || defaultPrefs;
  const scanner = options.scanner || defaultScanner;
  const getSettingsWindow = typeof options.getSettingsWindow === "function"
    ? options.getSettingsWindow
    : () => null;
  const sendToSettings = typeof options.sendToSettings === "function"
    ? options.sendToSettings
    : () => {};
  // Optional read-only digest source for withActiveTasks (phase 5). Absent
  // (e.g. in tests that only exercise the CLI surface) the scan payload is
  // left untouched.
  const getActivityByProject = typeof options.getActivityByProject === "function"
    ? options.getActivityByProject
    : null;
  // Fail closed: a missing guard and a throwing guard both deny every call. A
  // permissive default here would silently turn any renderer into a write
  // surface, and a leaked exception message would hand the renderer internals.
  const isTrustedEvent = (event) => {
    try {
      return typeof options.isTrustedEvent === "function" && options.isTrustedEvent(event) === true;
    } catch {
      return false;
    }
  };
  const cli = options.cli || createTrellisCli({ platform: options.platform, env: options.env });

  const runtime = options.runtime || createTrellisRuntime({
    cli,
    scanner,
    prefsSnapshot: () => settingsController.getSnapshot(),
    emit: (payload) => sendToSettings(PROGRESS_CHANNEL, payload),
  });

  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (!isTrustedEvent(event)) return { status: "error", message: "untrusted-sender" };
        return await listener(event, ...args);
      } catch (err) {
        return errorResult(err);
      }
    });
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  // The only admission test for a write: `.trellis/.version` or
  // `.trellis/scripts`. Never "does the directory exist".
  function isTrellisProject(projectPath) {
    if (typeof projectPath !== "string" || !projectPath) return false;
    return scanner.readInstallState(projectPath).installed === true;
  }

  handle("settings:trellis-scan", async (_event, payload) => {
    // An unknown channel string means "no override" rather than an error: the
    // default stays the per-project inference from the installed version.
    const channel = normalizeChannel(payload && payload.channel);
    const result = await runtime.scan(channel ? { channel } : {});
    return {
      ...result,
      projects: withActiveTasks(withStaleFixes(result.projects), getActivityByProject),
      platformCatalog: PLATFORM_CATALOG,
      channelCatalog: CHANNEL_CATALOG,
    };
  });

  handle("settings:trellis-pick-root", async () => {
    if (!dialog || typeof dialog.showOpenDialog !== "function") {
      return { status: "error", message: "directory picker unavailable" };
    }
    const parent = getSettingsWindow();
    const dialogOptions = { properties: ["openDirectory"] };
    const result = parent && typeof parent.isDestroyed === "function" && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
      return { status: "cancel" };
    }
    return { status: "ok", path: result.filePaths[0] };
  });

  // settings-controller is the only writer — this handler never touches disk.
  handle("settings:trellis-set-roots", async (_event, payload) => {
    const roots = normalizeRoots(payload && payload.roots, prefs);
    if (!roots) return { status: "error", message: "roots must be an array of strings" };
    const result = await settingsController.applyUpdate("trellisScanRoots", roots);
    if (!result || result.status !== "ok") {
      return result || { status: "error", message: "trellisScanRoots update returned no result" };
    }
    return { status: "ok", roots };
  });

  // Pure read: the runtime's preview never spawns. `platforms` (optional) adds
  // the "what would adding these platforms do" plan for installed projects.
  handle("settings:trellis-dry-run", async (_event, payload) => {
    // Real `trellis update --dry-run` output (09-25 wizard). Read-only;
    // guarded by the same trust gate as every other channel.
    const projectPath = payload && payload.path;
    if (!validPaths([projectPath]).length) {
      return { status: "error", message: "path must be a non-empty string" };
    }
    if (!isTrellisProject(projectPath)) {
      return { status: "error", message: "path is not a registered trellis project" };
    }
    const result = await runtime.dryRunPreview(projectPath);
    return { status: result && result.ok ? "ok" : "error", result };
  });

  handle("settings:trellis-preview", (_event, payload) => {
    const channel = normalizeChannel(payload && payload.channel);
    const paths = validPaths(payload && payload.paths);
    const plan = runtime.preview(paths, channel ? { channel } : {});
    const requestedIds = payload && payload.platforms;
    if (requestedIds === undefined || requestedIds === null) return { status: "ok", plan };
    if (!Array.isArray(requestedIds) || requestedIds.length === 0 || requestedIds.some((id) => !isKnownPlatformId(id))) {
      return { status: "error", message: "platforms must be a non-empty array of known platform ids" };
    }
    const addPlan = paths
      // Not filtered on isTrellisProject (09-25): first-time installs
      // preview through this branch too — `trellis init` IS the previewed
      // command for them. Platform ids were whitelist-checked above.
      .map((projectPath) => runtime.previewAddPlatforms(projectPath, requestedIds));
    return { status: "ok", plan, addPlan };
  });

  handle("settings:trellis-upgrade-project", (_event, payload) => {
    const projectPath = payload && payload.path;
    if (!isTrellisProject(projectPath)) {
      return { status: "error", message: "not a Trellis project" };
    }
    return runtime.upgradeProject(projectPath);
  });

  handle("settings:trellis-upgrade-all", (_event, payload) => {
    if (!payload || !Array.isArray(payload.paths)) {
      return { status: "error", message: "paths must be an array" };
    }
    const eligible = validPaths(payload.paths).filter((projectPath) => isTrellisProject(projectPath));
    if (eligible.length === 0) {
      return { status: "error", message: "no Trellis projects to upgrade" };
    }
    const started = runtime.startBatch(eligible);
    return {
      status: "ok",
      batchId: started.batchId,
      alreadyRunning: started.alreadyRunning === true,
      skipped: payload.paths.length - eligible.length,
    };
  });

  handle("settings:trellis-cancel-batch", () => runtime.cancelBatch());

  // `platforms` is an id whitelist only; the flag mapping happens in
  // trellis-cli. No renderer string ever reaches argv.
  handle("settings:trellis-add-platform", (_event, payload) => {
    const projectPath = payload && payload.path;
    const platformIds = payload && payload.platforms;
    if (!Array.isArray(platformIds) || platformIds.length === 0) {
      return { status: "error", message: "platforms must be a non-empty array", added: [] };
    }
    if (platformIds.some((id) => !isKnownPlatformId(id))) {
      return { status: "error", message: "unknown platform id", added: [] };
    }
    // NOT gated on isTrellisProject (09-25): this channel spawns
    // `trellis init --<platform> -y`, which is exactly how a NOT-yet-
    // installed project gets installed — the old gate made first-time
    // install impossible ("not a Trellis project" on a fresh dir).
    // The platform whitelist above is the real security boundary.
    if (typeof projectPath !== "string" || !projectPath) {
      return { status: "error", message: "path must be a non-empty string", added: [] };
    }
    return runtime.addPlatforms(projectPath, platformIds);
  });

  // `channel` is a dist-tag whitelist, exactly like `platforms` above: the
  // renderer may pick one of the known tags or leave it empty (= auto), but it
  // can never widen the argv with a token of its own.
  handle("settings:trellis-upgrade-global", (_event, payload) => {
    const raw = payload && payload.channel;
    if (raw === undefined || raw === null || raw === "") return runtime.upgradeGlobal({ channel: undefined });
    if (!REMOTE_CHANNELS.includes(raw)) {
      return { status: "error", message: "unknown-channel" };
    }
    return runtime.upgradeGlobal({ channel: raw });
  });

  return {
    runtime,
    dispose() {
      // A quit must not leave upgrade children running.
      try {
        runtime.cancelBatch();
      } catch {
        // Best effort — handler removal below is what matters for a restart.
      }
      while (disposers.length) {
        const dispose = disposers.pop();
        try {
          dispose();
        } catch {}
      }
    },
  };
}

module.exports = {
  registerTrellisIpc,
  PROGRESS_CHANNEL,
};
