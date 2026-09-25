"use strict";

// Orchestration layer for the Settings → Trellis tab.
//
// This is the only stateful Trellis module: the remote dist-tag cache, the
// single in-flight batch, its concurrency limit and its cancellation flag all
// live here so nothing else has to coordinate them.
//
// Two invariants are enforced at this layer:
//
//   1. Nothing writes without a user click. There is no timer, watcher or
//      startup hook in this file — `startBatch`, `upgradeProject`,
//      `upgradeGlobal` and `addPlatforms` are only reachable from an IPC
//      handler that a button triggers.
//   2. Preview is pure computation. It reads the already-fetched channel cache
//      and the project's own files; it never touches `cli`, so it can neither
//      spawn a process nor write a byte. (`trellis update --dry-run` is not an
//      option here: it rewrites `.trellis/.version`.)

const path = require("path");

const { evaluate, inferChannel } = require("./trellis-version");
const { flagsFor, platformById } = require("./trellis-platforms");
const { TRELLIS_BIN, UPDATE_ARGS, INIT_ARGS, INIT_ARGS_SUFFIX } = require("./trellis-cli");

const MAX_CONCURRENCY = 3;
const REMOTE_CACHE_TTL_MS = 60_000;

// The channels a scan may be forced to compare against. Anything else (an
// unknown string, a number, null) means "no override": the per-project
// inference from the installed version stays in charge, which is the default.
const CHANNEL_VALUES = Object.freeze(["latest", "beta", "rc"]);

function normalizeChannel(value) {
  return typeof value === "string" && CHANNEL_VALUES.includes(value) ? value : null;
}

function clampConcurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return MAX_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(numeric)));
}

function createTrellisRuntime(options = {}) {
  const {
    cli,
    scanner,
    // `prefsSnapshot` may be a plain object or a getter — the IPC layer passes
    // a getter so a root added in the UI is picked up by the next refresh
    // without rebuilding the runtime.
    prefsSnapshot,
    emit,
    now = Date.now,
    maxConcurrency = MAX_CONCURRENCY,
    remoteTtlMs = REMOTE_CACHE_TTL_MS,
    channelOverride = null,
  } = options;

  const concurrency = clampConcurrency(maxConcurrency);
  const remoteCache = { at: 0, channels: null, error: null };

  let batch = null;
  let nextBatchId = 1;

  function safeEmit(payload) {
    if (typeof emit !== "function") return;
    try {
      emit(payload);
    } catch {
      // A broken progress listener must never abort a running batch.
    }
  }

  function readRoots() {
    const snapshot = typeof prefsSnapshot === "function" ? prefsSnapshot() : prefsSnapshot;
    const roots = snapshot && Array.isArray(snapshot.trellisScanRoots) ? snapshot.trellisScanRoots : [];
    return roots.filter((root) => typeof root === "string" && root.trim());
  }

  function invalidateRemoteCache() {
    remoteCache.at = 0;
    remoteCache.channels = null;
    remoteCache.error = null;
  }

  // One npm call per TTL window, reused by every project in the snapshot.
  async function getRemoteChannels({ force = false } = {}) {
    const nowMs = now();
    const fresh = remoteCache.at > 0 && nowMs - remoteCache.at < remoteTtlMs;
    if (!force && fresh) return { channels: remoteCache.channels, error: remoteCache.error };

    let result;
    try {
      result = await cli.fetchRemoteChannels();
    } catch (err) {
      result = { channels: null, error: (err && err.message) || "error" };
    }
    remoteCache.at = nowMs;
    remoteCache.channels = (result && result.channels) || null;
    remoteCache.error = (result && result.error) || null;
    return { channels: remoteCache.channels, error: remoteCache.error };
  }

  function channelFor(current, override) {
    return normalizeChannel(override) || channelOverride || inferChannel(current);
  }

  // Row assembly. `upgradable` stays null whenever a comparison is impossible —
  // an uninstalled project, an unreadable version, or a failed remote lookup —
  // and the renderer must not collapse null into "已最新".
  function buildRow(project, override) {
    const channel = channelFor(project.current, override);
    if (!project.installed) {
      return { ...project, channel, target: null, upgradable: null };
    }
    const { target, upgradable } = evaluate({
      current: project.current,
      channels: remoteCache.channels,
      channel,
    });
    return { ...project, channel, target, upgradable };
  }

  async function scan(options = {}) {
    const override = normalizeChannel(options && options.channel);
    const roots = readRoots();
    const scans = scanner.scanRoots(roots);
    const [remote, global] = await Promise.all([
      getRemoteChannels(),
      cli.readGlobalVersion().catch((err) => ({
        installed: false,
        version: null,
        error: (err && err.message) || "error",
      })),
    ]);
    const projects = scans.flatMap((scan) => (scan.projects || []).map((project) => buildRow(project, override)));
    return {
      status: "ok",
      roots,
      scans,
      projects,
      remote: { channels: remote.channels, error: remote.error },
      global,
      channels: remote.channels,
    };
  }

  function previewTargets(paths) {
    return (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p);
  }

  // Pure: no cli call, no spawn, no write, no network. Version and platform
  // reads are `fs.readFile` only.
  function preview(paths, options = {}) {
    const override = normalizeChannel(options && options.channel);
    return previewTargets(paths).map((projectPath) => {
      const current = scanner.readProjectVersion(projectPath);
      const channel = channelFor(current, override);
      const { target, upgradable } = evaluate({
        current,
        channels: remoteCache.channels,
        channel,
      });
      return {
        path: projectPath,
        name: path.basename(projectPath),
        platforms: scanner.readPlatforms(projectPath),
        from: current,
        to: target,
        channel,
        upgradable,
        command: { bin: TRELLIS_BIN, args: Array.from(UPDATE_ARGS), cwd: projectPath },
      };
    });
  }

  // Real `trellis update --dry-run` output for the upgrade-preview wizard
  // (09-25). Unlike preview() this SPAWNS the CLI (read-only mode) so the
  // user sees the actual file-level plan the CLI would execute. Timed out
  // or failed runs still return partial output for diagnosis.
  async function dryRunPreview(projectPath, runOptions = {}) {
    return cli.dryRunUpdate(projectPath, runOptions);
  }

  // Preview for "add a platform": shows what would be added and the exact
  // command, without spawning anything. Unknown ids fail closed here too.
  function previewAddPlatforms(projectPath, platformIds) {
    const currentPlatforms = typeof projectPath === "string" && projectPath
      ? scanner.readPlatforms(projectPath)
      : [];
    const flags = flagsFor(platformIds);
    if (!flags || flags.length === 0) {
      return { path: projectPath, platforms: currentPlatforms, added: [], command: null, error: "unknown-platform" };
    }
    const requested = (Array.isArray(platformIds) ? platformIds : []).filter((id) => platformById(id));
    const added = requested.filter((id) => !currentPlatforms.includes(id));
    return {
      path: projectPath,
      name: typeof projectPath === "string" ? path.basename(projectPath) : "",
      platforms: currentPlatforms,
      added,
      error: null,
      command: {
        bin: TRELLIS_BIN,
        args: [...INIT_ARGS, "-u", path.basename(String(projectPath)) || "clawd", ...flags, ...INIT_ARGS_SUFFIX],
        cwd: projectPath,
      },
    };
  }

  function startBatch(paths) {
    if (batch && !batch.finished) return { status: "ok", batchId: batch.batchId, alreadyRunning: true };

    const queue = previewTargets(paths);
    const state = {
      batchId: `trellis-batch-${nextBatchId}`,
      queue,
      cancelled: false,
      finished: false,
      inflight: new Map(),
      results: [],
      summary: null,
    };
    nextBatchId += 1;
    batch = state;
    void runBatch(state);
    return { status: "ok", batchId: state.batchId, alreadyRunning: false };
  }

  async function runBatch(state) {
    const { batchId } = state;
    for (const projectPath of state.queue) safeEmit({ batchId, path: projectPath, phase: "queued" });

    let cursor = 0;
    let ok = 0;
    let failed = 0;
    let cancelled = 0;

    const worker = async () => {
      for (;;) {
        if (state.cancelled) return;
        const index = cursor;
        cursor += 1;
        if (index >= state.queue.length) return;

        const projectPath = state.queue[index];
        const controller = new AbortController();
        state.inflight.set(projectPath, controller);
        safeEmit({ batchId, path: projectPath, phase: "running" });

        let result;
        try {
          result = await cli.updateProject(projectPath, { signal: controller.signal });
        } catch (err) {
          result = { ok: false, error: (err && err.message) || "error" };
        } finally {
          state.inflight.delete(projectPath);
        }

        const aborted = controller.signal.aborted || state.cancelled;
        if (aborted && !(result && result.ok)) {
          cancelled += 1;
          const entry = {
            path: projectPath,
            ok: false,
            cancelled: true,
            from: (result && result.from) || null,
            to: null,
            message: "cancelled",
          };
          state.results.push(entry);
          safeEmit({ batchId, path: projectPath, phase: "cancelled", from: entry.from, message: entry.message });
          continue;
        }

        if (result && result.ok) {
          ok += 1;
          const entry = { path: projectPath, ok: true, cancelled: false, from: result.from, to: result.to, message: "" };
          state.results.push(entry);
          safeEmit({ batchId, path: projectPath, phase: "ok", from: entry.from, to: entry.to });
        } else {
          failed += 1;
          const entry = {
            path: projectPath,
            ok: false,
            cancelled: false,
            from: (result && result.from) || null,
            to: (result && result.to) || null,
            message: (result && (result.error || result.reason)) || "error",
          };
          state.results.push(entry);
          safeEmit({
            batchId,
            path: projectPath,
            phase: "failed",
            from: entry.from,
            to: entry.to,
            message: entry.message,
          });
        }
      }
    };

    const workers = [];
    const workerCount = Math.min(concurrency, state.queue.length);
    for (let i = 0; i < workerCount; i += 1) workers.push(worker());
    await Promise.all(workers);

    // Anything the queue never reached (cancel) is reported, so no row is left
    // showing a stale "queued" badge.
    const settled = new Set(state.results.map((entry) => entry.path));
    for (const projectPath of state.queue) {
      if (settled.has(projectPath)) continue;
      cancelled += 1;
      state.results.push({ path: projectPath, ok: false, cancelled: true, from: null, to: null, message: "cancelled" });
      safeEmit({ batchId, path: projectPath, phase: "cancelled", message: "cancelled" });
    }

    state.finished = true;
    state.summary = { total: state.queue.length, ok, failed, cancelled };
    safeEmit({ batchId, phase: "done", summary: state.summary });
  }

  function cancelBatch() {
    if (!batch || batch.finished) return { status: "ok", cancelled: false };
    batch.cancelled = true;
    for (const controller of batch.inflight.values()) {
      try {
        controller.abort();
      } catch {
        // A controller that refuses to abort still stops the queue below.
      }
    }
    return { status: "ok", cancelled: true, batchId: batch.batchId };
  }

  function batchStatus() {
    if (!batch) return { status: "ok", running: false, batchId: null, summary: null };
    return {
      status: "ok",
      running: !batch.finished,
      cancelled: batch.cancelled,
      batchId: batch.batchId,
      summary: batch.summary,
    };
  }

  async function upgradeProject(projectPath) {
    if (typeof projectPath !== "string" || !projectPath) {
      return { status: "error", message: "invalid-path" };
    }
    let result;
    try {
      result = await cli.updateProject(projectPath);
    } catch (err) {
      return { status: "error", message: (err && err.message) || "error" };
    }
    if (!result || !result.ok) {
      return {
        status: "error",
        from: (result && result.from) || null,
        to: (result && result.to) || null,
        message: (result && (result.error || result.reason)) || "error",
        output: (result && result.output) || "",
      };
    }
    return { status: "ok", from: result.from, to: result.to, message: "", output: result.output || "" };
  }

  // `channel` is optional: omitted (or empty) keeps the CLI's auto behaviour,
  // where it derives the channel from its own installed version.
  async function upgradeGlobal(options = {}) {
    const channel = options && options.channel;
    let result;
    try {
      result = await cli.upgradeGlobal(channel === "" ? undefined : channel);
    } catch (err) {
      return { status: "error", message: (err && err.message) || "error" };
    }
    if (!result || !result.ok) {
      return {
        status: "error",
        from: (result && result.from) || null,
        to: (result && result.to) || null,
        message: (result && (result.error || result.reason)) || "error",
        output: (result && result.output) || "",
      };
    }
    return { status: "ok", from: result.from, to: result.to, message: "", output: result.output || "" };
  }

  async function addPlatforms(projectPath, platformIds) {
    if (typeof projectPath !== "string" || !projectPath) {
      return { status: "error", message: "invalid-path", added: [] };
    }
    if (!flagsFor(platformIds)) {
      return { status: "error", message: "unknown-platform", added: [] };
    }
    let result;
    try {
      result = await cli.addPlatforms(projectPath, platformIds);
    } catch (err) {
      return { status: "error", message: (err && err.message) || "error", added: [] };
    }
    if (!result || !result.ok) {
      return {
        status: "error",
        added: (result && result.added) || [],
        message: (result && (result.error || result.reason)) || "error",
        output: (result && result.output) || "",
      };
    }
    return { status: "ok", added: result.added || [], message: "", output: result.output || "" };
  }

  return {
    scan,
    preview,
    previewAddPlatforms,
    dryRunPreview,
    startBatch,
    cancelBatch,
    batchStatus,
    upgradeProject,
    upgradeGlobal,
    addPlatforms,
    invalidateRemoteCache,
    concurrency,
  };
}

module.exports = {
  createTrellisRuntime,
  MAX_CONCURRENCY,
  REMOTE_CACHE_TTL_MS,
  CHANNEL_VALUES,
  normalizeChannel,
};
