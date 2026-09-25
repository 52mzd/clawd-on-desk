"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createTrellisRuntime, MAX_CONCURRENCY } = require("../src/trellis-runtime");
const scanner = require("../src/trellis-scanner");

const tmpRoots = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-runtime-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const CHANNELS = { latest: "0.6.17", beta: "0.7.0-beta.4", rc: "0.6.0-rc.0" };

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

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

// Fake cli. `hang` makes updateProject resolve only when its signal aborts,
// which is how the cancel test observes the kill.
function makeFakeCli(options = {}) {
  const calls = {
    fetchRemoteChannels: 0,
    readGlobalVersion: 0,
    updateProject: 0,
    upgradeGlobal: 0,
    addPlatforms: 0,
  };
  const started = [];
  const aborted = [];
  const globalChannels = [];
  let inflight = 0;
  let peak = 0;

  const cli = {
    calls,
    started,
    aborted,
    globalChannels,
    get peak() { return peak; },
    get inflight() { return inflight; },
    async fetchRemoteChannels() {
      calls.fetchRemoteChannels += 1;
      if (options.remoteError) return { channels: null, error: options.remoteError };
      return { channels: options.channels || CHANNELS, error: null };
    },
    async readGlobalVersion() {
      calls.readGlobalVersion += 1;
      return { installed: true, version: "0.6.17", error: null };
    },
    updateProject(projectPath, runOptions = {}) {
      calls.updateProject += 1;
      started.push(projectPath);
      inflight += 1;
      peak = Math.max(peak, inflight);
      const signal = runOptions.signal;
      return new Promise((resolve) => {
        let done = false;
        const settle = (value) => {
          if (done) return;
          done = true;
          inflight -= 1;
          resolve(value);
        };
        const onAbort = () => {
          aborted.push(projectPath);
          settle({ ok: false, reason: "aborted", from: "0.6.17", to: null });
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
        if (options.hang) return;
        const failure = options.failPaths && options.failPaths.includes(projectPath);
        setTimeout(() => {
          if (signal) signal.removeEventListener("abort", onAbort);
          settle(
            failure
              ? { ok: false, reason: "error", from: "0.6.17", to: "0.6.17", error: "boom", output: "boom" }
              : { ok: true, from: "0.6.17", to: "0.7.0-beta.4", error: null, output: "done" }
          );
        }, options.delayMs || 1);
      });
    },
    async upgradeGlobal(channel) {
      calls.upgradeGlobal += 1;
      globalChannels.push(channel);
      return { ok: true, from: "0.6.17", to: "0.7.0-beta.4", output: "ok", error: null };
    },
    async addPlatforms(projectPath, platformIds) {
      calls.addPlatforms += 1;
      return { ok: true, added: platformIds, output: "ok", error: null };
    },
  };
  return cli;
}

function makeRuntime(cli, overrides = {}) {
  const events = [];
  const runtime = createTrellisRuntime({
    cli,
    scanner: overrides.scanner || scanner,
    prefsSnapshot: overrides.prefsSnapshot || { trellisScanRoots: [] },
    emit: (payload) => events.push(payload),
    now: overrides.now || (() => 1_000_000),
    ...overrides.options,
  });
  return { runtime, events };
}

describe("scan", () => {
  it("queries the remote channels once per refresh, not per project", async () => {
    const root = makeTmpDir();
    makeProject(root, "one");
    makeProject(root, "two");
    makeProject(root, "three");
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    const snapshot = await runtime.scan();
    assert.strictEqual(cli.calls.fetchRemoteChannels, 1);
    assert.strictEqual(cli.calls.readGlobalVersion, 1);
    assert.strictEqual(snapshot.projects.length, 3);
    assert.deepStrictEqual(snapshot.projects.map((p) => p.upgradable), [false, false, false]);
  });

  it("serves a second refresh from the TTL cache", async () => {
    const root = makeTmpDir();
    makeProject(root, "one");
    const cli = makeFakeCli();
    let clock = 1_000_000;
    const { runtime } = makeRuntime(cli, {
      prefsSnapshot: { trellisScanRoots: [root] },
      now: () => clock,
    });

    await runtime.scan();
    clock += 5_000;
    await runtime.scan();
    assert.strictEqual(cli.calls.fetchRemoteChannels, 1);

    // Past the TTL the next refresh re-queries.
    clock += 120_000;
    await runtime.scan();
    assert.strictEqual(cli.calls.fetchRemoteChannels, 2);
  });

  it("re-queries after invalidateRemoteCache", async () => {
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli);
    await runtime.scan();
    runtime.invalidateRemoteCache();
    await runtime.scan();
    assert.strictEqual(cli.calls.fetchRemoteChannels, 2);
  });

  it("marks every upgradable as unknown (null) when the remote lookup fails", async () => {
    const root = makeTmpDir();
    makeProject(root, "behind", "0.5.0");
    const cli = makeFakeCli({ remoteError: "offline" });
    const { runtime } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    const snapshot = await runtime.scan();
    assert.strictEqual(snapshot.remote.error, "offline");
    assert.strictEqual(snapshot.remote.channels, null);
    assert.deepStrictEqual(snapshot.projects.map((p) => p.upgradable), [null]);
    assert.deepStrictEqual(snapshot.projects.map((p) => p.target), [null]);
    // null must never be reported as the boolean false.
    assert.notStrictEqual(snapshot.projects[0].upgradable, false);
  });

  it("offers an upgrade only when the target is strictly newer", async () => {
    const root = makeTmpDir();
    makeProject(root, "behind", "0.7.0-beta.3");
    makeProject(root, "ahead", "0.9.0");
    makeProject(root, "equal", "0.6.17");
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    const snapshot = await runtime.scan();
    const byName = new Map(snapshot.projects.map((p) => [p.name, p]));
    assert.strictEqual(byName.get("behind").channel, "beta");
    assert.strictEqual(byName.get("behind").target, "0.7.0-beta.4");
    assert.strictEqual(byName.get("behind").upgradable, true);
    assert.strictEqual(byName.get("ahead").upgradable, false);
    assert.strictEqual(byName.get("equal").upgradable, false);
  });

  it("lets a scan override the per-project channel while keeping auto as the default", async () => {
    const root = makeTmpDir();
    makeProject(root, "plain", "0.6.17");
    makeProject(root, "behind-beta", "0.7.0-beta.3");
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    const auto = await runtime.scan();
    const autoByName = new Map(auto.projects.map((p) => [p.name, p]));
    assert.strictEqual(autoByName.get("plain").channel, "latest");
    assert.strictEqual(autoByName.get("behind-beta").channel, "beta");

    // Forcing a channel applies to every row, including ones whose version
    // would have inferred a different channel.
    const forced = await runtime.scan({ channel: "beta" });
    const forcedByName = new Map(forced.projects.map((p) => [p.name, p]));
    assert.strictEqual(forcedByName.get("plain").channel, "beta");
    assert.strictEqual(forcedByName.get("plain").target, "0.7.0-beta.4");
    assert.strictEqual(forcedByName.get("plain").upgradable, true);

    // An unknown value is "no override", never an error.
    const bogus = await runtime.scan({ channel: "--evil" });
    assert.strictEqual(bogus.projects.find((p) => p.name === "plain").channel, "latest");
    assert.strictEqual(cli.calls.fetchRemoteChannels, 1, "channel choice still rides the TTL cache");
  });

  it("preview accepts the same channel override without spawning", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "plain", "0.6.17");
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });
    await runtime.scan();
    const before = { ...cli.calls };

    const plan = runtime.preview([projectPath], { channel: "beta" });
    assert.strictEqual(plan[0].channel, "beta");
    assert.strictEqual(plan[0].to, "0.7.0-beta.4");
    assert.deepStrictEqual(cli.calls, before);
  });

  it("does not offer an upgrade for a project without Trellis", async () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "plain"));
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    const snapshot = await runtime.scan();
    assert.strictEqual(snapshot.projects[0].installed, false);
    assert.strictEqual(snapshot.projects[0].target, null);
    assert.strictEqual(snapshot.projects[0].upgradable, null);
  });

  it("surfaces unreadable roots and an empty root list without throwing", async () => {
    const cli = makeFakeCli();
    const missing = path.join(os.tmpdir(), "trellis-runtime-missing-root");
    const { runtime } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [missing] } });
    const snapshot = await runtime.scan();
    assert.strictEqual(snapshot.scans[0].readable, false);
    assert.deepStrictEqual(snapshot.projects, []);

    const empty = makeRuntime(makeFakeCli());
    const emptySnapshot = await empty.runtime.scan();
    assert.deepStrictEqual(emptySnapshot.roots, []);
    assert.deepStrictEqual(emptySnapshot.projects, []);
  });

  it("reads roots through a getter so a newly added root is picked up", async () => {
    const rootA = makeTmpDir();
    const rootB = makeTmpDir();
    makeProject(rootA, "one");
    makeProject(rootB, "two");
    let roots = [rootA];
    const { runtime } = makeRuntime(makeFakeCli(), { prefsSnapshot: () => ({ trellisScanRoots: roots }) });

    assert.strictEqual((await runtime.scan()).projects.length, 1);
    roots = [rootA, rootB];
    assert.strictEqual((await runtime.scan()).projects.length, 2);
  });
});

describe("preview", () => {
  it("is pure computation: the cli is never touched", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "one", "0.7.0-beta.3");
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    const plan = runtime.preview([projectPath]);

    for (const [name, count] of Object.entries(cli.calls)) {
      assert.strictEqual(count, 0, `preview must not call cli.${name}`);
    }
    assert.strictEqual(cli.calls.updateProject, 0);
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].name, "one");
    assert.strictEqual(plan[0].from, "0.7.0-beta.3");
    assert.deepStrictEqual(plan[0].platforms, ["claude-code"]);
    assert.deepStrictEqual(plan[0].command, {
      bin: "trellis",
      args: ["update", "--force", "--migrate"],
      cwd: projectPath,
    });
  });

  it("computes from/to without a prior scan and without network access", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "one", "0.6.17");
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli);

    // No scan yet => no channel snapshot => unknown, not "already latest".
    const beforeScan = runtime.preview([projectPath]);
    assert.strictEqual(beforeScan[0].to, null);
    assert.strictEqual(beforeScan[0].upgradable, null);
    assert.strictEqual(cli.calls.fetchRemoteChannels, 0);
    assert.strictEqual(cli.calls.updateProject, 0);
  });

  it("writes nothing to the project", () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "one", "0.6.17");
    const before = fs.readFileSync(path.join(projectPath, ".trellis", ".version"), "utf8");
    const { runtime } = makeRuntime(makeFakeCli());
    runtime.preview([projectPath]);
    runtime.preview([projectPath, projectPath]);
    const after = fs.readFileSync(path.join(projectPath, ".trellis", ".version"), "utf8");
    assert.strictEqual(after, before);
  });

  it("previews an added platform with the exact init command, and fails closed on unknown ids", () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "one");
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli);

    const plan = runtime.previewAddPlatforms(projectPath, ["gemini", "pi"]);
    assert.deepStrictEqual(plan.platforms, ["claude-code"]);
    assert.deepStrictEqual(plan.added, ["gemini", "pi"]);
    assert.deepStrictEqual(plan.command, {
      bin: "trellis",
      args: ["init", "-u", path.basename(projectPath), "--gemini", "--pi", "-y"],
      cwd: projectPath,
    });
    assert.strictEqual(cli.calls.addPlatforms, 0);

    const rejected = runtime.previewAddPlatforms(projectPath, ["--evil"]);
    assert.strictEqual(rejected.command, null);
    assert.deepStrictEqual(rejected.added, []);
    assert.strictEqual(cli.calls.addPlatforms, 0);
  });
});

describe("batch upgrade", () => {
  it("keeps peak concurrency at or below the limit and completes every item", async () => {
    const root = makeTmpDir();
    const paths = [];
    for (let i = 0; i < 7; i += 1) paths.push(makeProject(root, `p${i}`, "0.5.0"));
    const cli = makeFakeCli({ delayMs: 5 });
    const { runtime, events } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    runtime.startBatch(paths);
    assert.strictEqual(await waitFor(() => runtime.batchStatus().running === false), true);

    assert.strictEqual(cli.calls.updateProject, 7);
    assert.ok(cli.peak <= MAX_CONCURRENCY, `peak concurrency ${cli.peak} exceeded ${MAX_CONCURRENCY}`);
    assert.ok(cli.peak > 1, "the batch should actually run in parallel");

    const done = events.find((e) => e.phase === "done");
    assert.deepStrictEqual(done.summary, { total: 7, ok: 7, failed: 0, cancelled: 0 });
  });

  it("does not let one failure interrupt the rest of the batch", async () => {
    const root = makeTmpDir();
    const paths = [];
    for (let i = 0; i < 4; i += 1) paths.push(makeProject(root, `p${i}`, "0.5.0"));
    const cli = makeFakeCli({ delayMs: 2, failPaths: [paths[1]] });
    const { runtime, events } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    runtime.startBatch(paths);
    assert.strictEqual(await waitFor(() => runtime.batchStatus().running === false), true);

    const done = events.find((e) => e.phase === "done");
    assert.deepStrictEqual(done.summary, { total: 4, ok: 3, failed: 1, cancelled: 0 });
    const failed = events.filter((e) => e.phase === "failed");
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].path, paths[1]);
    assert.strictEqual(failed[0].message, "boom");
  });

  it("emits queued then running then ok for each item", async () => {
    const root = makeTmpDir();
    const paths = [makeProject(root, "p0", "0.5.0"), makeProject(root, "p1", "0.5.0")];
    const cli = makeFakeCli({ delayMs: 2 });
    const { runtime, events } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    runtime.startBatch(paths);
    await waitFor(() => runtime.batchStatus().running === false);

    for (const projectPath of paths) {
      const phases = events.filter((e) => e.path === projectPath).map((e) => e.phase);
      assert.deepStrictEqual(phases, ["queued", "running", "ok"]);
    }
    const okEvent = events.find((e) => e.phase === "ok");
    assert.strictEqual(okEvent.from, "0.6.17");
    assert.strictEqual(okEvent.to, "0.7.0-beta.4");
  });

  it("aborts inflight work and never starts a queued item after cancel", async () => {
    const root = makeTmpDir();
    const paths = [];
    for (let i = 0; i < 6; i += 1) paths.push(makeProject(root, `p${i}`, "0.5.0"));
    const cli = makeFakeCli({ hang: true });
    const { runtime, events } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    runtime.startBatch(paths);
    assert.strictEqual(await waitFor(() => cli.started.length >= MAX_CONCURRENCY), true);
    assert.strictEqual(cli.started.length, MAX_CONCURRENCY);

    runtime.cancelBatch();
    assert.strictEqual(await waitFor(() => runtime.batchStatus().running === false), true);

    assert.strictEqual(cli.started.length, MAX_CONCURRENCY, "no new item may start after cancel");
    assert.strictEqual(cli.aborted.length, MAX_CONCURRENCY, "every inflight child must be aborted");
    assert.strictEqual(cli.inflight, 0);

    const done = events.find((e) => e.phase === "done");
    assert.deepStrictEqual(done.summary, { total: 6, ok: 0, failed: 0, cancelled: 6 });
    // Every queued row reaches a terminal phase — none is left showing "queued".
    const settled = new Set(
      events.filter((e) => ["ok", "failed", "cancelled"].includes(e.phase)).map((e) => e.path)
    );
    assert.strictEqual(settled.size, 6);
  });

  it("keeps completed items upgraded when a batch is cancelled", async () => {
    const root = makeTmpDir();
    const paths = [makeProject(root, "fast", "0.5.0"), makeProject(root, "slow", "0.5.0")];
    const cli = makeFakeCli({ hang: true });
    // "fast" completes immediately; "slow" only resolves on abort.
    const originalUpdate = cli.updateProject.bind(cli);
    cli.updateProject = (projectPath, runOptions) => {
      if (path.basename(projectPath) === "fast") {
        cli.calls.updateProject += 1;
        cli.started.push(projectPath);
        return Promise.resolve({ ok: true, from: "0.5.0", to: "0.7.0-beta.4", output: "", error: null });
      }
      return originalUpdate(projectPath, runOptions);
    };
    const { runtime, events } = makeRuntime(cli, {
      prefsSnapshot: { trellisScanRoots: [root] },
      options: { maxConcurrency: 2 },
    });

    runtime.startBatch(paths);
    assert.strictEqual(await waitFor(() => events.some((e) => e.phase === "ok")), true);
    runtime.cancelBatch();
    assert.strictEqual(await waitFor(() => runtime.batchStatus().running === false), true);

    const done = events.find((e) => e.phase === "done");
    assert.deepStrictEqual(done.summary, { total: 2, ok: 1, failed: 0, cancelled: 1 });
  });

  it("refuses to start a second batch while one is running", async () => {
    const root = makeTmpDir();
    const paths = [makeProject(root, "p0", "0.5.0")];
    const cli = makeFakeCli({ hang: true });
    const { runtime } = makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    const first = runtime.startBatch(paths);
    const second = runtime.startBatch(paths);
    assert.strictEqual(second.alreadyRunning, true);
    assert.strictEqual(second.batchId, first.batchId);

    runtime.cancelBatch();
    await waitFor(() => runtime.batchStatus().running === false);
  });

  it("clamps a concurrency override into the hard ceiling", () => {
    const { runtime } = makeRuntime(makeFakeCli(), { options: { maxConcurrency: 99 } });
    assert.strictEqual(runtime.concurrency, MAX_CONCURRENCY);
  });
});

describe("single-item actions", () => {
  it("upgrades one project and reports the version transition", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "one", "0.6.17");
    const cli = makeFakeCli({ delayMs: 1 });
    const { runtime } = makeRuntime(cli);

    const result = await runtime.upgradeProject(projectPath);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.from, "0.6.17");
    assert.strictEqual(result.to, "0.7.0-beta.4");
  });

  it("reports a failed single upgrade with its message instead of throwing", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "one", "0.6.17");
    const cli = makeFakeCli({ delayMs: 1, failPaths: [projectPath] });
    const { runtime } = makeRuntime(cli);

    const result = await runtime.upgradeProject(projectPath);
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.message, "boom");
  });

  it("rejects an invalid path before touching the cli", async () => {
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli);
    assert.strictEqual((await runtime.upgradeProject("")).status, "error");
    assert.strictEqual((await runtime.addPlatforms("", ["gemini"])).status, "error");
    assert.strictEqual(cli.calls.updateProject, 0);
    assert.strictEqual(cli.calls.addPlatforms, 0);
  });

  it("adds platforms only for whitelisted ids", async () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "one");
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli);

    const rejected = await runtime.addPlatforms(projectPath, ["--evil"]);
    assert.strictEqual(rejected.status, "error");
    assert.strictEqual(cli.calls.addPlatforms, 0);

    const accepted = await runtime.addPlatforms(projectPath, ["gemini"]);
    assert.strictEqual(accepted.status, "ok");
    assert.deepStrictEqual(accepted.added, ["gemini"]);
    assert.strictEqual(cli.calls.addPlatforms, 1);
  });

  it("upgrades the global cli and reports the new version", async () => {
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli);
    const result = await runtime.upgradeGlobal();
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.from, "0.6.17");
    assert.strictEqual(result.to, "0.7.0-beta.4");
  });

  it("passes an explicit channel down and leaves auto untouched", async () => {
    const cli = makeFakeCli();
    const { runtime } = makeRuntime(cli);
    await runtime.upgradeGlobal({ channel: "beta" });
    await runtime.upgradeGlobal({ channel: "" });
    await runtime.upgradeGlobal();
    assert.deepStrictEqual(cli.globalChannels, ["beta", undefined, undefined]);
  });
});

describe("no ambient automation", () => {
  it("performs no work until an explicit call is made", async () => {
    const root = makeTmpDir();
    makeProject(root, "one", "0.5.0");
    const cli = makeFakeCli();
    makeRuntime(cli, { prefsSnapshot: { trellisScanRoots: [root] } });

    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const [name, count] of Object.entries(cli.calls)) {
      assert.strictEqual(count, 0, `creating the runtime must not call cli.${name}`);
    }
    assert.strictEqual(fs.readFileSync(path.join(root, "one", ".trellis", ".version"), "utf8"), "0.5.0\n");
  });
});
