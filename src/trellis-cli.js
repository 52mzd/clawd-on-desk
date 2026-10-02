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
// Paths are only ever passed as `cwd`. The one path-derived token that does
// reach argv is the folder-name fallback of `-u`, and it is run through the
// same whitelist as a typed developer name (`normalizeUserName`), so a
// directory named `a & b` cannot inject anything either.

const { execFile: defaultExecFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const { mergedExecutionEnv } = require("./codex-queue-delivery");
const { flagsFor } = require("./trellis-platforms");
const { readPlatforms, readProjectVersion } = require("./trellis-scanner");

const TRELLIS_BIN = "trellis";
const NPM_BIN = "npm";
const REMOTE_PACKAGE = "@mindfoldhq/trellis";
const REMOTE_CHANNELS = Object.freeze(["latest", "beta", "rc"]);
const GIT_BIN = "git";

// `-u` is the *developer identity* (`trellis init -u <name>`), not the project
// name: the CLI writes `.trellis/workspace/<name>/` and records the name in
// `.trellis/.developer`.
//
// Measured on 0.6.17: `trellis init --gemini -y` WITHOUT `-u` exits 0 and does
// not hang (stdin=ignore) — but it creates neither `.trellis/.developer` nor
// the personal workspace. So the reason `-u` must be non-empty is not "the CLI
// aborts": it is that the user would be told the install succeeded while their
// developer identity was silently never created.
const USER_NAME_MAX_LENGTH = 64;

// Whitelist, not a blacklist. Every shell metacharacter is ASCII, so a name
// made of Unicode letters/digits/marks/other-symbols plus `_`, `.` and `-`
// cannot be spliced into a command string when Node runs `shell: true`
// (Windows) — it only ever concatenates argv, it never escapes it.
//
// Covers CJK and emoji (`\p{L}` / `\p{So}`); refuses spaces, quotes, `;`, `&`,
// `|`, `<`, `>`, `^`, `%`, `$`, backticks, parentheses and control characters
// (all of them ASCII). The leading char class excludes `.` and `-`, so `.` /
// `..` can never be a whole segment and `-rf` can never be read as a flag,
// while `my..project` remains valid.
const USER_NAME_RE = /^[\p{L}\p{N}\p{M}\p{So}_][\p{L}\p{N}\p{M}\p{So}_.\-]*$/u;
const GIT_USER_ARGS = Object.freeze(["config", "user.name"]);
const GIT_USER_TIMEOUT_MS = 3000;

// Kept apart on purpose — see the file header.
// 09-25: --migrate added (user request, docs.trytrellis.app/zh/advanced/
// appendix-f) — it re-runs init hooks so migrated platforms pick up new
// files instead of only updating existing ones. --force stays (skips the
// interactive confirmation; without it a TTY-less spawn hangs).
const UPDATE_ARGS = Object.freeze(["update", "--force", "--migrate"]);
const INIT_ARGS = Object.freeze(["init"]);
const INIT_ARGS_SUFFIX = Object.freeze(["-y"]);
const GLOBAL_UPGRADE_ARGS = Object.freeze(["upgrade"]);
const VERSION_ARGS = Object.freeze(["--version"]);
const REMOTE_ARGS = Object.freeze(["view", REMOTE_PACKAGE, "dist-tags", "--json"]);
// Read-only dry run for the upgrade-preview wizard (09-25). Measured on
// this machine: leaves .trellis/.version and the worktree untouched when
// the installed version matches the template version (the older CLI
// caveat does not apply to 0.7.0-beta.3).
const DRY_RUN_ARGS = Object.freeze(["update", "--dry-run"]);
const DRY_RUN_TIMEOUT_MS = 45000;

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

// Developer-name sanitation shared by every caller — typed wizard values AND
// the folder-name fallback (H1b: a directory name is just as untrusted as
// renderer input). Returns "" for anything unusable so the caller falls
// through to the next fallback. The length cap counts code points, so a name
// of emoji is not cut in half.
function normalizeUserName(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // A lone surrogate (half of a pair) would surface in argv as U+FFFD. Refuse
  // the value rather than silently mangling it (M2: `maxlength` counts UTF-16
  // code units, the CLI cap counts code points).
  if (typeof trimmed.isWellFormed === "function" && !trimmed.isWellFormed()) return "";
  // Whitelist first: it is what keeps shell metacharacters out of argv. A
  // lone surrogate fails here too — it is not in any allowed category — so
  // this holds even on runtimes without `String.prototype.isWellFormed`.
  if (!USER_NAME_RE.test(trimmed)) return "";
  // Path escapes, at segment granularity only (M1: `my..project` is a fine
  // folder name). The whitelist above already refuses separators and a leading
  // dot; this keeps the intent explicit for the next reader.
  if (trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) return "";
  const codePoints = Array.from(trimmed);
  return codePoints.length > USER_NAME_MAX_LENGTH
    ? codePoints.slice(0, USER_NAME_MAX_LENGTH).join("")
    : trimmed;
}

// Single implementation of the `-u` fallback chain: the caller's value, then
// the project folder name, then "clawd". Never returns "". The three call
// sites (CLI, IPC stale-fix command, runtime preview/install) share it so the
// fallback semantics cannot drift apart.
function resolveUserName(projectPath, candidate) {
  const explicit = normalizeUserName(candidate);
  if (explicit) return explicit;
  const folder = projectPath ? path.basename(String(projectPath)) : "";
  const fromFolder = normalizeUserName(folder);
  if (fromFolder) return fromFolder;
  return "clawd";
}

// `trellis init` 的 argv 构造。`-u` **只在调用方显式提供 userName 时**才加入：
// 加平台场景 CLI 会忽略它（`.developer` 已存在），而把目录名显示在预览命令里
// 会让用户以为「身份被设成了目录名」；官方文档给加平台的命令本就不带 `-u`。
// `undefined` → 完全不加；`""` → 首次 init 但用户没填，走回退链。
function buildInitArgs(projectPath, flags, options = {}) {
  if (options.userName === undefined || options.userName === null) {
    return [...INIT_ARGS, ...flags, ...INIT_ARGS_SUFFIX];
  }
  return [...INIT_ARGS, "-u", resolveUserName(projectPath, options.userName), ...flags, ...INIT_ARGS_SUFFIX];
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

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseSemver(value) {
  const match = String(value || "").match(SEMVER_RE);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] == null ? null : match[4] };
}

// Simplified semver ordering for the "which install is older" call: numeric
// segments compare numerically, a release outranks its prereleases, and two
// prereleases compare by dot-separated identifier (numeric identifiers
// numerically, ranking below alphanumeric; fewer identifiers rank lower).
// Anything unparsable is "not comparable" → 0, so an unreadable version can
// never be flagged outdated — never tell the user to delete what we can't read.
function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const idsA = pa.pre.split(".");
  const idsB = pb.pre.split(".");
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i += 1) {
    const ia = idsA[i];
    const ib = idsB[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) {
      if (ia !== ib) return Number(ia) < Number(ib) ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return 0;
}

// A GUI-launched app inherits launchd's default PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), which contains none of the locations
// `trellis` is normally installed into. `createTrellisCli` deliberately does
// not repair the child's PATH on its own — callers pass the extra lookup paths
// in `env` — so they build that overlay with this helper. Mirrors the explicit
// candidates focus.js already uses for the orca CLI. Windows resolves the npm
// `.cmd` shim through the shell and needs no augmentation.
const GUI_PATH_EXTRA_DIRS = Object.freeze([
  "/opt/homebrew/bin", // Homebrew, Apple Silicon
  "/usr/local/bin", // Homebrew Intel and manual installs
]);

// User-scoped global-bin roots of the JS package managers, relative to $HOME.
// None of them is in launchd's PATH, and only ~/.local/bin was covered before,
// so a trellis installed through any of them was invisible to the GUI. The
// order after GUI_PATH_EXTRA_DIRS + ~/.local/bin keeps every environment that
// already resolves a CLI resolving the same one.
const USER_PATH_EXTRA_DIRS = Object.freeze([
  ".npm-global/bin", // npm with the sudo-free prefix its own docs recommend
  ".bun/bin", // bun
  "Library/pnpm", // pnpm global bin (macOS default location)
  ".volta/bin", // volta
]);

// nvm keeps one prefix per installed node version under
// ~/.nvm/versions/node/<v>, so every version's bin is enumerated — newest
// version first, matching the nvm use order users expect. Read errors mean
// "no nvm here" and stay silent.
function listNvmVersionBins(homeDir, options = {}) {
  const fsImpl = options.fs || fs;
  const versionsRoot = path.posix.join(homeDir, ".nvm", "versions", "node");
  let names;
  try {
    names = fsImpl.readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return names.map((name) => path.posix.join(versionsRoot, name, "bin"));
}

function augmentedCliPath(basePath, options = {}) {
  const platform = options.platform || process.platform;
  const delimiter = platform === "win32" ? ";" : ":";
  const parts = String(basePath || "").split(delimiter).filter(Boolean);
  if (platform !== "win32") {
    const push = (dir) => {
      if (dir && !parts.includes(dir)) parts.push(dir);
    };
    for (const dir of GUI_PATH_EXTRA_DIRS) push(dir);
    let home = typeof options.home === "string" ? options.home : "";
    if (!home) {
      try {
        home = require("os").homedir();
      } catch {
        home = "";
      }
    }
    if (home) {
      const homeDir = home.replace(/\\/g, "/");
      push(path.posix.join(homeDir, ".local", "bin"));
      for (const dir of USER_PATH_EXTRA_DIRS) push(path.posix.join(homeDir, dir));
      for (const dir of listNvmVersionBins(homeDir, options)) push(dir);
    }
  }
  return parts.join(delimiter);
}

// Every absolute `trellis` the spawn PATH would find, in PATH order — the
// duplicate-install detector needs them all, not just the first hit. Pure fs —
// never spawns — and [] on win32, where the spawn goes through a shell that
// resolves `.cmd` shims this lookup cannot model.
function scanTrellisBinPaths(basePath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") return [];
  const fsImpl = options.fs || fs;
  const found = [];
  for (const dir of String(basePath || "").split(":").filter(Boolean)) {
    const candidate = path.join(dir, TRELLIS_BIN);
    try {
      // statSync follows npm's bin symlink; accessSync proves executability.
      if (!fsImpl.statSync(candidate).isFile()) continue;
      fsImpl.accessSync(candidate, fsImpl.constants.X_OK);
      found.push(candidate);
    } catch {
      // absent or not executable — keep scanning the remaining entries
    }
  }
  return found;
}

// The first PATH hit — the one a bare `trellis` spawn resolves to — or null.
function resolveTrellisBinPath(basePath, options = {}) {
  return scanTrellisBinPaths(basePath, options)[0] ?? null;
}

// An npm prefix layout: <prefix>/lib/node_modules/@mindfoldhq/trellis/… — the
// prefix is what `npm uninstall --prefix` needs.
const NPM_LAYOUT_RE = new RegExp(`^(.+)/lib/node_modules/${REMOTE_PACKAGE.replaceAll("/", "\\/")}/`);

// Quotes a shell word only when it needs it (whitespace or quotes inside).
function shellQuote(value) {
  return /[\s'"]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}

// Builds the copy-to-terminal cleanup command for a redundant install.
// Display/copy ONLY — nothing in this codebase ever executes the result.
function buildCleanupCommand(binPath, options = {}) {
  if (typeof binPath !== "string" || !binPath) return null;
  const fsImpl = options.fs || fs;
  let real;
  try {
    real = fsImpl.realpathSync(binPath);
  } catch {
    return null;
  }
  let command;
  let probeDir;
  const match = real.match(NPM_LAYOUT_RE);
  if (match) {
    // npm owns the layout: uninstall through npm, not raw rm.
    command = `npm uninstall -g ${REMOTE_PACKAGE} --prefix ${shellQuote(match[1])}`;
    probeDir = match[1];
  } else {
    command = `rm -f ${shellQuote(binPath)}`;
    probeDir = path.dirname(binPath);
  }
  // Directories the user cannot write (system prefixes like /usr/local) need
  // sudo; a probe failure reads as "not writable" so the command stays honest.
  let writable = true;
  try {
    fsImpl.accessSync(probeDir, fsImpl.constants.W_OK);
  } catch {
    writable = false;
  }
  return writable ? command : `sudo ${command}`;
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
    // Every executable trellis on the SAME PATH a spawn would use, so the UI
    // can show duplicate installs — not just the first hit (10-01 multi-detect).
    const paths = scanTrellisBinPaths(executionEnv.PATH, { platform });
    const installs = [];
    let headline = null; // first hit — what a bare `trellis` spawn resolves to
    for (const binPath of paths) {
      const result = await run(binPath, VERSION_ARGS, { timeoutMs: versionTimeoutMs });
      const entry = {
        path: binPath,
        version: result.ok ? parseVersionOutput(result.stdout) : null,
        active: installs.length === 0,
        // Copy-to-terminal cleanup hint for redundant installs; never executed.
        cleanup: buildCleanupCommand(binPath),
      };
      installs.push(entry);
      if (entry.active) {
        headline = {
          ok: result.ok,
          version: entry.version,
          error: result.ok ? null : result.message,
        };
      }
    }
    if (!headline) {
      // The fs scan is [] on win32 by design: npm installs a `trellis.cmd`
      // shim whose shell resolution fs cannot model. Fall back to letting the
      // shell itself resolve a bare `trellis` — the same resolution a real
      // spawn uses (run() sets shell:true on win32). Everywhere else an empty
      // scan genuinely means absent, so only win32 spawns here (10-03).
      if (platform === "win32") {
        const result = await run(TRELLIS_BIN, VERSION_ARGS, { timeoutMs: versionTimeoutMs });
        if (result.ok) {
          return { installed: true, version: parseVersionOutput(result.stdout), error: null, path: null, installs: [] };
        }
        if (result.reason === "not-found") {
          // The shell could not resolve `trellis` → genuinely not installed;
          // a state, not an error, matching the POSIX empty-PATH branch.
          return { installed: false, version: null, error: null, path: null, installs: [] };
        }
        return { installed: false, version: null, error: result.message, path: null, installs: [] };
      }
      // No trellis anywhere on the PATH: "not installed" is a state, not an
      // error — there was no spawn to fail.
      return { installed: false, version: null, error: null, path: null, installs: [] };
    }
    // "Redundant" must mean OLDER, not "not first on PATH" (10-01 revise):
    // the GUI's augmented PATH order can differ from the user's shell PATH, so
    // PATH rank would flag the install they actually use. Flag an install only
    // when a strictly newer parsable version exists elsewhere; unparsable
    // versions and version ties are never flagged.
    let newest = null;
    for (const entry of installs) {
      if (entry.version === null) continue;
      if (newest === null || compareVersions(entry.version, newest) > 0) newest = entry.version;
    }
    for (const entry of installs) {
      entry.outdated = newest !== null && entry.version !== null
        && compareVersions(entry.version, newest) < 0;
    }
    // Newest first (10-01 ui-flow): the renderer runs in a sandbox without
    // compareVersions, so the display order is decided here. Stable sort —
    // unparsable versions compare 0 and keep their scan order; `active` was
    // stamped before the sort and travels with its entry.
    installs.sort((a, b) => compareVersions(b.version || "0", a.version || "0"));
    return {
      installed: headline.ok,
      version: headline.version,
      error: headline.error,
      path: paths[0],
      installs,
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

  // `channel` is an npm dist-tag and MUST ride the `--tag` flag (measured on
  // 0.6.17: `trellis upgrade beta` — a bare positional — is silently IGNORED and
  // falls back to `latest`, so the user's beta/rc choice was lost).
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
    const args = wanted === "" ? GLOBAL_UPGRADE_ARGS : [...GLOBAL_UPGRADE_ARGS, "--tag", wanted];
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

  // Best-effort read of `git config user.name` for the install wizard's
  // developer-name default. A missing git, an unset value or a timeout all
  // return an empty name so the wizard falls back to the folder name instead
  // of blocking. Runs from the home directory so a cwd inside some other
  // repository cannot lend its local `user.name` to the answer.
  async function readGitUserName(runOptions = {}) {
    let cwd = "";
    try {
      cwd = require("os").homedir();
    } catch {
      cwd = "";
    }
    const result = await run(GIT_BIN, GIT_USER_ARGS, {
      cwd: cwd || undefined,
      timeoutMs: (runOptions && runOptions.timeoutMs) || GIT_USER_TIMEOUT_MS,
    });
    if (!result.ok) return { name: "" };
    return { name: normalizeUserName(result.stdout) };
  }

  // `platformIds` must come from the PLATFORMS table. A single unknown id
  // rejects the whole call before any process is spawned, so renderer input can
  // never widen the argv surface.
  async function addPlatforms(projectPath, platformIds, options = {}) {
    const flags = flagsFor(platformIds);
    if (!flags) return { ok: false, reason: "unknown-platform", added: [], output: "", error: "unknown-platform" };
    if (flags.length === 0) return { ok: false, reason: "no-platforms", added: [], output: "", error: "no-platforms" };

    // `-u` is the developer identity trellis records in `.trellis/.developer`;
    // it defaults to the folder name. Measured on 0.6.17: without `-u` the CLI
    // still exits 0 on a fresh project, but creates no `.developer` and no
    // personal workspace — so a first install must send one. Platform-only adds
    // pass no userName at all, and then the argv carries no `-u` (buildInitArgs).
    const before = readPlatforms(projectPath);
    const result = await run(TRELLIS_BIN, buildInitArgs(projectPath, flags, options || {}), { cwd: projectPath });
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

  // Read-only dry run for the upgrade-preview wizard (09-25). Runs
  // `trellis update --dry-run` in the project cwd and returns the raw
  // combined output; the wizard renders it verbatim. Measured on this
  // machine (0.7.0-beta.3): leaves .trellis/.version and the worktree
  // untouched. Failures still return output so the wizard can show WHY.
  async function dryRunUpdate(projectPath, runOptions = {}) {
    // `trellis update --dry-run` has ONE documented side effect: when the
    // project version differs from the CLI version it rewrites
    // .trellis/.version (AGENTS gotcha). Guard: snapshot before, restore
    // after if the CLI touched it — the preview stays read-only.
    const versionPath = path.join(projectPath, ".trellis", ".version");
    let before = null;
    try { before = fs.readFileSync(versionPath, "utf8"); } catch { /* absent */ }
    let result;
    try {
      result = await run(TRELLIS_BIN, DRY_RUN_ARGS, {
        cwd: projectPath,
        timeoutMs: DRY_RUN_TIMEOUT_MS,
        signal: runOptions.signal,
      });
    } finally {
      try {
        const after = fs.readFileSync(versionPath, "utf8");
        if (before !== null && after !== before) fs.writeFileSync(versionPath, before);
      } catch { /* nothing to restore */ }
    }
    return {
      ok: result.ok,
      reason: result.reason,
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
    dryRunUpdate,
    readGitUserName,
  };
}

module.exports = {
  createTrellisCli,
  augmentedCliPath,
  resolveTrellisBinPath,
  scanTrellisBinPaths,
  buildCleanupCommand,
  compareVersions,
  resolveUserName,
  buildInitArgs,
  normalizeUserName,
  USER_NAME_MAX_LENGTH,
  GIT_USER_ARGS,
  GIT_USER_TIMEOUT_MS,
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
  DRY_RUN_ARGS,
  DEFAULT_TIMEOUT_MS,
  classifyFailure,
  parseVersionOutput,
};
