"use strict";

// External-command layer for the Settings → Trellis tab.
//
// Exactly two write commands exist, and both are user-click initiated:
//
//   trellis update --force              upgrade a project in place
//   trellis init --<flag> -y            add a platform to a project
//
// The two argv tails are deliberately separate constants. `trellis update` is
// interactive without `--force` and would hang forever with no TTY. `trellis
// init` must carry `-y` and *nothing else*: `-s`/`-f` make the CLI skip its
// "already initialized" incremental branch, fall back to a full init, and
// rebuild `.template-hashes.json` from scratch — which drops every previously
// recorded platform from the record.
//
// There is intentionally no `--dry-run` wrapper: `trellis update --dry-run` is
// not read-only (it rewrites `.trellis/.version` when it differs from the CLI
// version), so preview is computed in the runtime instead of shelled out here.
//
// Paths are only ever passed as `cwd`. They never enter argv and never reach a
// shell string, so a directory named `a & b` cannot inject anything.

const { execFile: defaultExecFile } = require("child_process");

const { mergedExecutionEnv } = require("./codex-queue-delivery");
const { flagsFor } = require("./trellis-platforms");
const { readPlatforms, readProjectVersion } = require("./trellis-scanner");

const TRELLIS_BIN = "trellis";
const NPM_BIN = "npm";
const REMOTE_PACKAGE = "@mindfoldhq/trellis";
const REMOTE_CHANNELS = Object.freeze(["latest", "beta", "rc"]);

// Kept apart on purpose — see the file header.
const UPDATE_ARGS = Object.freeze(["update", "--force"]);
const INIT_ARGS = Object.freeze(["init"]);
const INIT_ARGS_SUFFIX = Object.freeze(["-y"]);
const GLOBAL_UPGRADE_ARGS = Object.freeze(["upgrade"]);
const VERSION_ARGS = Object.freeze(["--version"]);
const REMOTE_ARGS = Object.freeze(["view", REMOTE_PACKAGE, "dist-tags", "--json"]);

const DEFAULT_TIMEOUT_MS = 120000;
const VERSION_TIMEOUT_MS = 15000;
const REMOTE_TIMEOUT_MS = 30000;
const GLOBAL_UPGRADE_TIMEOUT_MS = 300000;

const VERSION_OUTPUT_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
// `trellis --version` writes to stdout, but on stdout the version line is not
// necessarily first. The CLI prepends a startup banner for every command when
// its *cwd* contains a `.trellis/` directory:
//
//   ⚠️  Trellis update available: 0.7.0-beta.3 → 0.7.0-beta.4
//      Run: trellis update
//
//   0.7.0-beta.4
//
// The left side is `<cwd>/.trellis/.version`, the right side the CLI's own
// version. Measured while the CLI was 0.7.0-beta.4: run from a project stamped
// 0.7.0-beta.3 it prints exactly the above; run with cwd=/tmp (no project) it
// prints only "0.7.0-beta.4". So the first version-shaped token in the output is
// a project version, not the installed CLI version - and that left-hand value
// moves whenever a project is upgraded, independently of the CLI.
//
// These are human-facing strings, so the parse anchors on the one shape that is
// unambiguous rather than on position: a line that is nothing but a version.
const VERSION_LINE_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function errorMessage(err, stderrText = "") {
  const stderr = typeof stderrText === "string" ? stderrText.trim() : "";
  if (stderr) return stderr;
  if (!err) return "";
  // Some callers surface stderr on the error object instead of the callback.
  const ownStderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
  if (ownStderr) return ownStderr;
  if (typeof err.message === "string" && err.message) return err.message;
  return String(err);
}

// Coarse buckets the UI can act on. Anything we cannot classify stays "error"
// so the raw output is what the user sees.
function classifyFailure(err) {
  const code = String((err && err.code) || "").toUpperCase();
  if (code === "ABORT_ERR" || (err && err.name === "AbortError")) return "aborted";
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ERR_TIMED_OUT"].includes(code)) return "timeout";
  if (err && err.killed) return "timeout";
  if (code === "ENOENT") return "not-found";
  return "error";
}

function combineOutput(result) {
  const stdout = result && typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = result && typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stdout && stderr) return `${stdout}\n${stderr}`;
  return stdout || stderr;
}

function parseVersionOutput(text) {
  const lines = String(text || "").split(/\r?\n/);
  // Last match wins. The banner is a prefix and its lines never consist of a
  // bare version, so this holds for both banner directions (a project older
  // than the CLI, or a project newer than it).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (VERSION_LINE_RE.test(trimmed)) return trimmed.replace(/^v/, "");
  }
  // Fallback for shapes we have not seen, e.g. a single line "trellis v0.7.0".
  const match = lines.join("\n").match(VERSION_OUTPUT_RE);
  return match ? match[0] : null;
}

function createTrellisCli(options = {}) {
  const {
    execFileImpl = defaultExecFile,
    env = {},
    platform = process.platform,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    versionTimeoutMs = VERSION_TIMEOUT_MS,
    remoteTimeoutMs = REMOTE_TIMEOUT_MS,
    globalUpgradeTimeoutMs = GLOBAL_UPGRADE_TIMEOUT_MS,
  } = options;

  // Mirrors `src/updater.js`: the child inherits `process.env` with any
  // caller-supplied overrides layered on top (case-insensitively on Windows).
  // It does not repair a GUI app's PATH — callers that need extra lookup paths
  // must pass them in `env` themselves.
  const executionEnv = mergedExecutionEnv(env, platform);

  // Never rejects: every outcome is a value the caller can render.
  function run(bin, args, runOptions = {}) {
    return new Promise((resolve) => {
      const execOptions = {
        cwd: runOptions.cwd,
        timeout: runOptions.timeoutMs || timeoutMs,
        windowsHide: true,
        env: executionEnv,
      };
      // Windows resolves `trellis`/`npm` through .cmd shims, which execFile
      // cannot launch without a shell. POSIX stays shell-free.
      if (platform === "win32") execOptions.shell = true;
      if (runOptions.signal) execOptions.signal = runOptions.signal;

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        execFileImpl(bin, args, execOptions, (err, stdout, stderr) => {
          const out = typeof stdout === "string" ? stdout : "";
          const errOut = typeof stderr === "string" ? stderr : "";
          if (err) {
            const reason = classifyFailure(err);
            finish({
              ok: false,
              reason,
              stdout: out,
              stderr: errOut,
              message: errorMessage(err, errOut) || reason,
            });
            return;
          }
          finish({ ok: true, reason: null, stdout: out, stderr: errOut, message: "" });
        });
      } catch (err) {
        finish({ ok: false, reason: classifyFailure(err), stdout: "", stderr: "", message: errorMessage(err) });
      }
    });
  }

  async function readGlobalVersion() {
    const result = await run(TRELLIS_BIN, VERSION_ARGS, { timeoutMs: versionTimeoutMs });
    const version = result.ok ? parseVersionOutput(result.stdout) : null;
    return {
      installed: result.ok,
      version,
      error: result.ok ? null : result.message,
    };
  }

  // One call returns every dist-tag, so a refresh never queries npm per project.
  async function fetchRemoteChannels() {
    const result = await run(NPM_BIN, REMOTE_ARGS, { timeoutMs: remoteTimeoutMs });
    if (!result.ok) return { channels: null, error: result.message || result.reason };
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { channels: null, error: "invalid-json" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { channels: null, error: "invalid-json" };
    }
    const channels = {};
    for (const name of REMOTE_CHANNELS) {
      const value = parsed[name];
      if (typeof value === "string" && value.trim()) channels[name] = value.trim();
    }
    if (Object.keys(channels).length === 0) return { channels: null, error: "no-channels" };
    return { channels, error: null };
  }

  async function updateProject(projectPath, runOptions = {}) {
    const from = readProjectVersion(projectPath);
    const result = await run(TRELLIS_BIN, UPDATE_ARGS, {
      cwd: projectPath,
      signal: runOptions.signal,
    });
    // Read the version back from disk rather than trusting the exit code: the
    // CLI is the only writer of this file.
    const to = readProjectVersion(projectPath);
    return {
      ok: result.ok,
      reason: result.reason,
      from,
      to,
      output: combineOutput(result),
      error: result.ok ? null : result.message || result.reason,
    };
  }

  // `channel` is an npm dist-tag the CLI understands (`trellis upgrade <tag>`).
  // Empty means auto: the CLI infers the channel from the prerelease marker of
  // the version it has installed (beta → beta, rc → rc, otherwise latest), so
  // Clawd must not compute a default here — it would pick a different channel
  // than the CLI would. Anything outside REMOTE_CHANNELS fails closed before a
  // process is spawned, exactly like an unknown platform id above.
  async function upgradeGlobal(channel) {
    const wanted = channel === undefined || channel === null ? "" : channel;
    if (wanted !== "" && !REMOTE_CHANNELS.includes(wanted)) {
      return {
        ok: false,
        reason: "unknown-channel",
        from: null,
        to: null,
        output: "",
        error: "unknown-channel",
      };
    }
    const args = wanted === "" ? GLOBAL_UPGRADE_ARGS : [...GLOBAL_UPGRADE_ARGS, wanted];
    const before = await readGlobalVersion();
    const result = await run(TRELLIS_BIN, args, { timeoutMs: globalUpgradeTimeoutMs });
    const after = await readGlobalVersion();
    return {
      ok: result.ok,
      reason: result.reason,
      from: before.version,
      to: after.version,
      output: combineOutput(result),
      error: result.ok ? null : result.message || result.reason,
    };
  }

  // `platformIds` must come from the PLATFORMS table. A single unknown id
  // rejects the whole call before any process is spawned, so renderer input can
  // never widen the argv surface.
  async function addPlatforms(projectPath, platformIds) {
    const flags = flagsFor(platformIds);
    if (!flags) return { ok: false, reason: "unknown-platform", added: [], output: "", error: "unknown-platform" };
    if (flags.length === 0) return { ok: false, reason: "no-platforms", added: [], output: "", error: "no-platforms" };

    const before = readPlatforms(projectPath);
    const result = await run(TRELLIS_BIN, [...INIT_ARGS, ...flags, ...INIT_ARGS_SUFFIX], { cwd: projectPath });
    const after = readPlatforms(projectPath);
    const added = after.filter((id) => !before.includes(id));
    return {
      ok: result.ok,
      reason: result.reason,
      added,
      output: combineOutput(result),
      error: result.ok ? null : result.message || result.reason,
    };
  }

  return {
    readGlobalVersion,
    fetchRemoteChannels,
    updateProject,
    upgradeGlobal,
    addPlatforms,
  };
}

module.exports = {
  createTrellisCli,
  TRELLIS_BIN,
  NPM_BIN,
  REMOTE_PACKAGE,
  REMOTE_CHANNELS,
  UPDATE_ARGS,
  INIT_ARGS,
  INIT_ARGS_SUFFIX,
  GLOBAL_UPGRADE_ARGS,
  VERSION_ARGS,
  REMOTE_ARGS,
  DEFAULT_TIMEOUT_MS,
  classifyFailure,
  parseVersionOutput,
};
