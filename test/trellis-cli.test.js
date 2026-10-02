"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile: realExecFile } = require("node:child_process");

const {
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
  UPDATE_ARGS,
  INIT_ARGS_SUFFIX,
  REMOTE_PACKAGE,
  parseVersionOutput,
  classifyFailure,
} = require("../src/trellis-cli");

const tmpRoots = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-cli-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeProject(version = "0.6.17", hashes = null) {
  const dir = makeTmpDir();
  const trellisDir = path.join(dir, ".trellis");
  fs.mkdirSync(trellisDir, { recursive: true });
  if (version !== null) fs.writeFileSync(path.join(trellisDir, ".version"), `${version}\n`);
  if (hashes) {
    fs.writeFileSync(
      path.join(trellisDir, ".template-hashes.json"),
      JSON.stringify({ __version: 2, hashes })
    );
  }
  return dir;
}

// Records every invocation and replies from a scripted table keyed by bin.
function makeExecFileStub(handlers = {}) {
  const calls = [];
  const fn = (bin, args, options, cb) => {
    const call = { bin, args: Array.from(args), options };
    calls.push(call);
    const handler = handlers[bin] || handlers.default;
    const reply = typeof handler === "function" ? handler(call, calls.length) : handler;
    const result = reply || { err: null, stdout: "", stderr: "" };
    queueMicrotask(() => cb(result.err || null, result.stdout || "", result.stderr || ""));
    return { kill() {} };
  };
  fn.calls = calls;
  return fn;
}

function cliWith(stub, overrides = {}) {
  return createTrellisCli({ execFileImpl: stub, platform: "darwin", ...overrides });
}

// A tmp dir with a real executable `trellis`: readGlobalVersion resolves the
// spawn bin via fs, so tests point PATH at dirs that genuinely carry one.
function makeBinDir() {
  const dir = makeTmpDir();
  const bin = path.join(dir, "trellis");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  fs.chmodSync(bin, 0o755);
  return dir;
}

describe("argv contract", () => {
  it("upgrades with an array argv containing --force and cwd = project path", async () => {
    const projectPath = makeProject("0.6.17");
    const stub = makeExecFileStub({ trellis: { stdout: "done" } });
    const result = await cliWith(stub).updateProject(projectPath);

    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(stub.calls[0].bin, "trellis");
    assert.deepStrictEqual(stub.calls[0].args, ["update", "--force", "--migrate"]);
    assert.deepStrictEqual(stub.calls[0].args, Array.from(UPDATE_ARGS));
    assert.strictEqual(stub.calls[0].options.cwd, projectPath);
    assert.strictEqual(typeof stub.calls[0].options.timeout, "number");
    assert.ok(stub.calls[0].options.timeout > 0);
    assert.strictEqual(result.ok, true);
  });

  it("dry-run spawns exactly [update, --dry-run] and reports combined output", async () => {
    // 09-25 wizard contract: the upgrade preview shows the REAL CLI output.
    const projectPath = makeProject("0.6.17");
    const stub = makeExecFileStub({
      trellis: { stdout: "would update 3 files", stderr: "(dry run)" },
    });
    const result = await cliWith(stub).dryRunUpdate(projectPath);

    assert.deepStrictEqual(stub.calls[0].args, ["update", "--dry-run"]);
    assert.strictEqual(stub.calls[0].options.cwd, projectPath);
    assert.strictEqual(result.ok, true);
    assert.ok(result.output.includes("would update 3 files"));
    assert.ok(result.output.includes("(dry run)"), "stderr folds into output");
  });

  it("dry-run restores .trellis/.version when the CLI rewrites it", async () => {
    // AGENTS gotcha: older CLIs rewrite .version even on --dry-run when the
    // project version differs. The wrapper snapshots and restores — the
    // preview must stay read-only.
    const projectPath = makeProject("0.6.17");
    const versionPath = path.join(projectPath, ".trellis", ".version");
    const stub = makeExecFileStub({
      trellis: (call) => {
        fs.writeFileSync(versionPath, "0.7.0-beta.4\n");
        return { stdout: "plan" };
      },
    });
    const result = await cliWith(stub).dryRunUpdate(projectPath);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(fs.readFileSync(versionPath, "utf8"), "0.6.17\n",
      ".version must be restored after a mutating dry-run");
  });

  it("adds a platform with exactly [init, --gemini, -y] (no -u)", async () => {
    const projectPath = makeProject("0.6.17", { ".claude/x": "h" });
    const stub = makeExecFileStub({
      trellis: (call) => {
        if (call.args[0] === "init") {
          fs.writeFileSync(
            path.join(projectPath, ".trellis", ".template-hashes.json"),
            JSON.stringify({ __version: 2, hashes: { ".claude/x": "h", ".gemini/y": "h" } })
          );
        }
        return { stdout: "ok" };
      },
    });

    const result = await cliWith(stub).addPlatforms(projectPath, ["gemini"]);
    // 09-27: adding a platform to an already-init project carries NO `-u` —
    // the CLI ignores it (`.developer` exists) and showing the folder name in
    // the preview command only makes the user think the identity was renamed.
    assert.deepStrictEqual(stub.calls[0].args, ["init", "--gemini", "-y"]);
    assert.ok(!stub.calls[0].args.includes("-u"), "add-platform argv must not carry -u");
    assert.deepStrictEqual(Array.from(INIT_ARGS_SUFFIX), ["-y"]);
    assert.ok(!stub.calls[0].args.includes("-s"), "-s must never be passed to init");
    assert.ok(!stub.calls[0].args.includes("--skip-all"));
    assert.ok(!stub.calls[0].args.includes("-f"), "-f must never be passed to init");
    assert.ok(!stub.calls[0].args.includes("--force"));
    assert.strictEqual(stub.calls[0].options.cwd, projectPath);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.added, ["gemini"]);
  });

  it("buildInitArgs omits -u only when no userName was supplied (09-27)", () => {
    // undefined (or an options object without userName) == add-platform.
    assert.deepStrictEqual(buildInitArgs("/projects/alpha", ["--gemini"]), ["init", "--gemini", "-y"]);
    assert.deepStrictEqual(buildInitArgs("/projects/alpha", ["--gemini"], {}), ["init", "--gemini", "-y"]);
    // `null` must count as "not supplied" too — the IPC boundary can turn an
    // omitted value into null, and treating it as a first install would put the
    // folder name back into a platform-only add.
    assert.deepStrictEqual(
      buildInitArgs("/projects/alpha", ["--gemini"], { userName: null }),
      ["init", "--gemini", "-y"]
    );
    // A supplied name (even the empty string) == first init, so `-u` rides along
    // and an empty value falls back to the folder name.
    assert.deepStrictEqual(
      buildInitArgs("/projects/alpha", ["--gemini"], { userName: "alice" }),
      ["init", "-u", "alice", "--gemini", "-y"]
    );
    assert.deepStrictEqual(
      buildInitArgs("/projects/alpha", ["--gemini"], { userName: "" }),
      ["init", "-u", "alpha", "--gemini", "-y"]
    );
  });

  it("keeps the update and init argv constants separate", () => {
    assert.deepStrictEqual(Array.from(UPDATE_ARGS), ["update", "--force", "--migrate"]);
    assert.deepStrictEqual(Array.from(INIT_ARGS_SUFFIX), ["-y"]);
    assert.notStrictEqual(UPDATE_ARGS, INIT_ARGS_SUFFIX);
  });

  it("never lets the project path reach argv", async () => {
    const projectPath = makeProject("0.6.17");
    const stub = makeExecFileStub({ trellis: { stdout: "" } });
    await cliWith(stub).updateProject(projectPath);
    assert.ok(!stub.calls[0].args.some((arg) => arg.includes(projectPath)));
  });
});

describe("addPlatforms whitelist", () => {
  it("fails closed without spawning for unknown or malformed ids", async () => {
    const projectPath = makeProject("0.6.17");
    const stub = makeExecFileStub({ trellis: { stdout: "" } });
    const cli = cliWith(stub);

    for (const ids of [["--evil"], ["pi; rm -rf /"], ["gemini", "nope"], ["unknown:.future"], [null], "gemini", null]) {
      const result = await cli.addPlatforms(projectPath, ids);
      assert.strictEqual(result.ok, false, `expected fail-closed for ${JSON.stringify(ids)}`);
      assert.deepStrictEqual(result.added, []);
    }
    assert.strictEqual(stub.calls.length, 0, "no process may be spawned for rejected input");
  });

  it("fails closed on an empty platform list", async () => {
    const projectPath = makeProject("0.6.17");
    const stub = makeExecFileStub({ trellis: { stdout: "" } });
    const result = await cliWith(stub).addPlatforms(projectPath, []);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "no-platforms");
    assert.strictEqual(stub.calls.length, 0);
  });

  it("reports added platforms from disk, not from the exit code", async () => {
    const projectPath = makeProject("0.6.17", { ".claude/x": "h" });
    // Command "fails" but the record did change — disk is the authority.
    const stub = makeExecFileStub({
      trellis: (call) => {
        if (call.args[0] === "init") {
          fs.writeFileSync(
            path.join(projectPath, ".trellis", ".template-hashes.json"),
            JSON.stringify({ __version: 2, hashes: { ".claude/x": "h", ".pi/y": "h" } })
          );
        }
        return { err: Object.assign(new Error("exit 1"), { code: 1 }), stderr: "warn" };
      },
    });
    const result = await cliWith(stub).addPlatforms(projectPath, ["pi"]);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.added, ["pi"]);
  });
});

describe("resolveUserName fallback chain (09-27)", () => {
  it("prefers the explicit developer name", () => {
    assert.strictEqual(resolveUserName("/projects/alpha", "alice"), "alice");
  });

  it("falls back to the folder name, then to clawd", () => {
    assert.strictEqual(resolveUserName("/projects/alpha", "  "), "alpha");
    assert.strictEqual(resolveUserName("/projects/alpha", ""), "alpha");
    assert.strictEqual(resolveUserName("/", ""), "clawd");
    assert.strictEqual(resolveUserName("", ""), "clawd");
  });

  it("rejects names that would escape .trellis/workspace/ (M1: segment granularity)", () => {
    assert.strictEqual(resolveUserName("/projects/alpha", "a/b"), "alpha");
    assert.strictEqual(resolveUserName("/projects/alpha", "a\\b"), "alpha");
    assert.strictEqual(resolveUserName("/projects/alpha", ".."), "alpha");
    assert.strictEqual(resolveUserName("/projects/alpha", "../alpha"), "alpha");
    assert.strictEqual(resolveUserName("/projects/alpha", ".hidden"), "alpha");
    // M1: a `..` *substring* inside a segment is a perfectly valid folder name.
    assert.strictEqual(resolveUserName("/projects/alpha", "my..project"), "my..project");
  });

  it("refuses whitespace and every ASCII shell metacharacter (H1)", () => {
    // `run()` sets `shell: true` on win32 and Node then CONCATENATES argv
    // without escaping it (DEP0190) — any of these would execute.
    const hostile = [
      ";", "&", "|", "<", ">", "^", "%", '"', "'", "`", "$", "(", ")", "!",
      " ", "\r", "\n", "\t",
      "x; touch pwned; #", "x & touch pwned", "x | touch pwned",
      "$(touch pwned)", "`touch pwned`", "Tom & Jerry", "100%", "-rf", "--force",
      "a=b", "{a,b}", "*", "?", "~", "[a]", "name@host", "name+tag",
    ];
    for (const value of hostile) {
      assert.strictEqual(normalizeUserName(value), "", `normalize: ${JSON.stringify(value)}`);
      assert.strictEqual(resolveUserName("/projects/alpha", value), "alpha", `fallback: ${JSON.stringify(value)}`);
    }
  });

  it("still accepts CJK, combining marks and emoji names (H1 must not over-reach)", () => {
    assert.strictEqual(normalizeUserName("张三"), "张三");
    assert.strictEqual(normalizeUserName("\u305f\u308d\u3046"), "\u305f\u308d\u3046");
    assert.strictEqual(normalizeUserName("\ud64d\uae38\ub3d9"), "\ud64d\uae38\ub3d9");
    assert.strictEqual(normalizeUserName("cafe\u0301"), "cafe\u0301");
    assert.strictEqual(normalizeUserName("\u{1F388}"), "\u{1F388}");
    assert.strictEqual(normalizeUserName("\u{1F388}_alice-2"), "\u{1F388}_alice-2");
  });

  it("refuses a lone surrogate instead of letting argv render U+FFFD (M2)", () => {
    assert.strictEqual(normalizeUserName("a\uD83C"), "");
    assert.strictEqual(normalizeUserName("\uDE00b"), "");
    assert.strictEqual(resolveUserName("/projects/alpha", "alice\uD83C"), "alpha");
  });

  it("falls back to clawd when the FOLDER NAME is hostile (H1b)", () => {
    assert.strictEqual(resolveUserName("/projects/a & b", ""), "clawd");
    assert.strictEqual(resolveUserName("/projects/a;b", ""), "clawd");
    assert.strictEqual(resolveUserName("/projects/..", ""), "clawd");
    assert.strictEqual(resolveUserName("/projects/my..project", ""), "my..project");
  });

  it("caps the name at 64 code points without splitting a surrogate pair", () => {
    assert.strictEqual(resolveUserName("/projects/alpha", "x".repeat(120)).length, USER_NAME_MAX_LENGTH);
    const emoji = resolveUserName("/projects/alpha", "\u{1F388}".repeat(80));
    assert.strictEqual(Array.from(emoji).length, USER_NAME_MAX_LENGTH, "64 code points");
    assert.strictEqual(emoji.length, USER_NAME_MAX_LENGTH * 2, "a surrogate pair is never cut in half");
    assert.strictEqual(emoji.endsWith("\u{1F388}"), true, "no dangling surrogate half");
    assert.strictEqual(normalizeUserName("  bob  "), "bob");
  });

  it("threads options.userName into the init argv and keeps the folder fallback", async () => {
    const projectPath = makeProject("0.6.17");
    const stub = makeExecFileStub({ trellis: { stdout: "ok" } });
    const cli = cliWith(stub);

    // Add-platform (no userName): `-u` is absent on purpose.
    await cli.addPlatforms(projectPath, ["gemini"]);
    assert.deepStrictEqual(stub.calls[0].args, ["init", "--gemini", "-y"]);
    assert.ok(!stub.calls[0].args.includes("-u"), "add-platform argv must not carry -u");

    // First init (explicit name): `-u <name>` rides init.
    await cli.addPlatforms(projectPath, ["gemini"], { userName: "alice" });
    assert.deepStrictEqual(stub.calls[1].args, ["init", "-u", "alice", "--gemini", "-y"]);

    // First init with a blank name: still `-u`, falling back to the folder name.
    await cli.addPlatforms(projectPath, ["gemini"], { userName: "   " });
    assert.deepStrictEqual(stub.calls[2].args, ["init", "-u", path.basename(projectPath), "--gemini", "-y"]);

    // First init with an empty string is NOT the add-platform case: `-u` stays.
    await cli.addPlatforms(projectPath, ["gemini"], { userName: "" });
    assert.deepStrictEqual(stub.calls[3].args, ["init", "-u", path.basename(projectPath), "--gemini", "-y"]);

    // H1: a hostile value never reaches argv, even through addPlatforms.
    await cli.addPlatforms(projectPath, ["gemini"], { userName: "x; touch pwned; #" });
    assert.deepStrictEqual(stub.calls[4].args, ["init", "-u", path.basename(projectPath), "--gemini", "-y"]);
  });

  it("keeps a hostile value out of the real win32 shell concatenation (H1 regression)", async () => {
    const projectPath = makeProject("0.6.17");
    const markerDir = makeTmpDir();
    const marker = path.join(markerDir, "clawd-injected");
    const payload = `x; touch ${marker}; #`;

    // Sanity: the payload IS live — unescaped argv in a shell runs it. Without
    // this counter-check a green test could simply mean a dead payload.
    await new Promise((resolve) => {
      realExecFile("echo", ["-u", payload], { shell: true }, () => resolve());
    });
    assert.strictEqual(fs.existsSync(marker), true, "payload must be live or the regression proves nothing");
    fs.rmSync(marker, { force: true });

    // Same shell path, sanitized value. Only the binary is swapped for `echo`
    // so a developer machine with trellis installed is not mutated.
    const calls = [];
    const shellStub = (bin, args, options, cb) => {
      calls.push({ bin, args, options });
      return realExecFile("echo", args, options, cb);
    };
    const cli = createTrellisCli({ execFileImpl: shellStub, platform: "win32" });
    await cli.addPlatforms(projectPath, ["gemini"], { userName: payload });

    assert.strictEqual(calls[0].options.shell, true, "win32 branch still uses a shell");
    assert.strictEqual(calls[0].args[2], path.basename(projectPath), "fell back to the folder name");
    assert.strictEqual(calls[0].args.includes(payload), false);
    assert.strictEqual(calls[0].args.some((arg) => /[;&|$`\s()]/.test(arg)), false, "no metacharacter survives");
    assert.strictEqual(fs.existsSync(marker), false, "sanitized name must not execute");
  });
});

describe("readGitUserName (09-27)", () => {
  it("reads [config, user.name] and trims the answer", async () => {
    const stub = makeExecFileStub({ git: { stdout: "alice\n" } });
    const result = await cliWith(stub).readGitUserName();
    assert.deepStrictEqual(result, { name: "alice" });
    assert.deepStrictEqual(stub.calls[0].args, ["config", "user.name"]);
    assert.strictEqual(typeof stub.calls[0].options.timeout, "number");
    assert.ok(stub.calls[0].options.timeout <= 3000, "never blocks the wizard for long");
  });

  it("returns an empty name for a missing git, a timeout or an unsafe value", async () => {
    const missing = makeExecFileStub({
      git: { err: Object.assign(new Error("not found"), { code: "ENOENT" }) },
    });
    assert.deepStrictEqual(await cliWith(missing).readGitUserName(), { name: "" });

    const timedOut = makeExecFileStub({
      git: { err: Object.assign(new Error("timeout"), { killed: true }), stdout: "" },
    });
    assert.deepStrictEqual(await cliWith(timedOut).readGitUserName(), { name: "" });

    const unsafe = makeExecFileStub({ git: { stdout: "a/b\n" } });
    assert.deepStrictEqual(await cliWith(unsafe).readGitUserName(), { name: "" });
  });
});

describe("execFile options", () => {
  it("uses shell on win32 only", async () => {
    const projectPath = makeProject("0.6.17");
    const winStub = makeExecFileStub({ trellis: { stdout: "" } });
    await createTrellisCli({ execFileImpl: winStub, platform: "win32" }).updateProject(projectPath);
    assert.strictEqual(winStub.calls[0].options.shell, true);

    const posixStub = makeExecFileStub({ trellis: { stdout: "" } });
    await createTrellisCli({ execFileImpl: posixStub, platform: "linux" }).updateProject(projectPath);
    assert.notStrictEqual(posixStub.calls[0].options.shell, true);
  });

  it("hides the window and forwards an abort signal", async () => {
    const projectPath = makeProject("0.6.17");
    const stub = makeExecFileStub({ trellis: { stdout: "" } });
    const controller = new AbortController();
    await cliWith(stub).updateProject(projectPath, { signal: controller.signal });
    assert.strictEqual(stub.calls[0].options.windowsHide, true);
    assert.strictEqual(stub.calls[0].options.signal, controller.signal);
  });
});

describe("failure handling", () => {
  it("preserves stdout and stderr on a non-zero exit", async () => {
    const projectPath = makeProject("0.6.17");
    const stub = makeExecFileStub({
      trellis: { err: Object.assign(new Error("boom"), { code: 1 }), stdout: "partial out", stderr: "real reason" },
    });
    const result = await cliWith(stub).updateProject(projectPath);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.output, "partial out\nreal reason");
    assert.strictEqual(result.error, "real reason");
    assert.strictEqual(result.from, "0.6.17");
    assert.strictEqual(result.to, "0.6.17");
  });

  it("surfaces the version read back from disk after an upgrade", async () => {
    const projectPath = makeProject("0.6.17");
    const stub = makeExecFileStub({
      trellis: () => {
        fs.writeFileSync(path.join(projectPath, ".trellis", ".version"), "0.7.0-beta.4\n");
        return { stdout: "upgraded" };
      },
    });
    const result = await cliWith(stub).updateProject(projectPath);
    assert.strictEqual(result.from, "0.6.17");
    assert.strictEqual(result.to, "0.7.0-beta.4");
  });

  it("does not throw when execFile throws synchronously", async () => {
    const projectPath = makeProject("0.6.17");
    const stub = () => { throw Object.assign(new Error("spawn failed"), { code: "ENOENT" }); };
    const result = await cliWith(stub).updateProject(projectPath);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "not-found");
  });
});

describe("readGlobalVersion", () => {
  it("parses a version with a v prefix and trailing newline", async () => {
    const binDir = makeBinDir();
    const binPath = path.join(binDir, "trellis");
    const stub = makeExecFileStub({ [binPath]: { stdout: "v0.6.17\n" } });
    const result = await cliWith(stub, { env: { PATH: binDir } }).readGlobalVersion();
    // A tmp dir carries a plain (non-npm-layout) writable bin, so the cleanup
    // hint is a plain rm — asserted byte-exact alongside the rest.
    assert.deepStrictEqual(result, {
      installed: true,
      version: "0.6.17",
      error: null,
      path: binPath,
      installs: [{ path: binPath, version: "0.6.17", active: true, cleanup: `rm -f ${binPath}`, outdated: false }],
    });
    assert.deepStrictEqual(stub.calls[0].args, ["--version"]);
  });

  it("reports the resolved binary path alongside the version", async () => {
    const binDir = makeBinDir();
    const binPath = path.join(binDir, "trellis");
    const stub = makeExecFileStub({ [binPath]: { stdout: "0.6.17\n" } });
    const result = await cliWith(stub, { env: { PATH: binDir } }).readGlobalVersion();
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.path, binPath);
  });

  it("lists every install with its own version and an active marker", async () => {
    const fresh = makeBinDir();
    const fossil = makeBinDir();
    const freshBin = path.join(fresh, "trellis");
    const fossilBin = path.join(fossil, "trellis");
    const stub = makeExecFileStub({
      [freshBin]: { stdout: "0.7.0-beta.4\n" },
      [fossilBin]: { stdout: "0.3.10\n" },
    });
    const result = await cliWith(stub, { env: { PATH: `${fresh}:${fossil}` } }).readGlobalVersion();
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.version, "0.7.0-beta.4");
    assert.strictEqual(result.path, freshBin);
    assert.strictEqual(result.installs.length, 2);
    assert.deepStrictEqual(result.installs[0], {
      path: freshBin,
      version: "0.7.0-beta.4",
      active: true,
      cleanup: `rm -f ${freshBin}`, // tmp bin: plain layout, writable
      outdated: false,
    });
    assert.deepStrictEqual(result.installs[1], {
      path: fossilBin,
      version: "0.3.10",
      active: false,
      cleanup: `rm -f ${fossilBin}`,
      outdated: true,
    });

    // PATH order decides Active — never outdated — but the array itself is
    // NEWEST-FIRST (ui-flow): flipping the PATH swaps the active marker (it
    // travels with its entry, not its index) while the older install stays
    // the removable one: the GUI's PATH order is not the user's shell PATH
    // order, so version age (not PATH rank) is the only safe "safe to
    // remove" signal.
    const flipped = await cliWith(stub, { env: { PATH: `${fossil}:${fresh}` } }).readGlobalVersion();
    assert.strictEqual(flipped.path, fossilBin);
    assert.strictEqual(flipped.version, "0.3.10");
    assert.strictEqual(flipped.installs[0].path, freshBin, "newest first regardless of PATH order");
    assert.strictEqual(flipped.installs[1].path, fossilBin);
    assert.strictEqual(flipped.installs[0].active, false, "active travels with the first-hit entry");
    assert.strictEqual(flipped.installs[1].active, true);
    assert.strictEqual(flipped.installs[0].outdated, false);
    assert.strictEqual(flipped.installs[1].outdated, true);
  });

  it("never flags an unparsable or equal-version install as outdated", async () => {
    // An unreadable version must not be recommended for deletion, and equal
    // versions are not "older" than each other — only a strictly newer
    // install somewhere else makes one removable.
    const unreadable = makeBinDir();
    const twinA = makeBinDir();
    const twinB = makeBinDir();
    const stub = makeExecFileStub({
      [path.join(unreadable, "trellis")]: { stdout: "no version here" },
      [path.join(twinA, "trellis")]: { stdout: "0.6.17\n" },
      [path.join(twinB, "trellis")]: { stdout: "0.6.17\n" },
    });
    const result = await cliWith(stub, {
      env: { PATH: `${unreadable}:${twinA}:${twinB}` },
    }).readGlobalVersion();
    assert.strictEqual(result.installs.length, 3);
    assert.strictEqual(result.installs[0].version, null);
    assert.strictEqual(result.installs[0].outdated, false, "unparsable stays unflagged");
    assert.strictEqual(result.installs[1].outdated, false, "equal versions tie");
    assert.strictEqual(result.installs[2].outdated, false, "equal versions tie");
  });

  it("reports not installed with zero spawns when the PATH carries no trellis", async () => {
    const stub = makeExecFileStub({ trellis: { stdout: "0.6.17\n" } });
    const result = await cliWith(stub, { env: { PATH: "/nonexistent" } }).readGlobalVersion();
    // No fs hit → no spawn at all: "not installed" is a state, not an error.
    assert.deepStrictEqual(result, { installed: false, version: null, error: null, path: null, installs: [] });
    assert.strictEqual(stub.calls.length, 0);
  });

  it("reports a failed spawn when a found binary will not run", async () => {
    const binDir = makeBinDir();
    const binPath = path.join(binDir, "trellis");
    const stub = makeExecFileStub({
      [binPath]: { err: Object.assign(new Error("not found"), { code: "ENOENT" }) },
    });
    const result = await cliWith(stub, { env: { PATH: binDir } }).readGlobalVersion();
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.version, null);
    assert.strictEqual(result.path, binPath);
    assert.ok(result.error);
    assert.strictEqual(result.installs.length, 1);
  });

  it("keeps installed true but version null when output is unparsable", async () => {
    const binDir = makeBinDir();
    const stub = makeExecFileStub({ [path.join(binDir, "trellis")]: { stdout: "no version here" } });
    const result = await cliWith(stub, { env: { PATH: binDir } }).readGlobalVersion();
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.version, null);
  });

  it("reads the CLI version, not the project version in the startup banner", async () => {
    // Byte-exact stdout captured from `trellis --version` with the CLI at
    // 0.7.0-beta.4, run from a project stamped 0.7.0-beta.3. The banner is a
    // prefix and its left-hand side is `<cwd>/.trellis/.version`.
    const stdout = [
      "",
      "⚠️  Trellis update available: 0.7.0-beta.3 → 0.7.0-beta.4",
      "   Run: trellis update",
      "",
      "0.7.0-beta.4",
      "",
    ].join("\n");
    const binDir = makeBinDir();
    const stub = makeExecFileStub({ [path.join(binDir, "trellis")]: { stdout } });
    const result = await cliWith(stub, { env: { PATH: binDir } }).readGlobalVersion();
    assert.strictEqual(result.version, "0.7.0-beta.4");
    assert.notStrictEqual(result.version, "0.7.0-beta.3", "must not report the project's version");
  });

  it("reads the CLI version from the other banner branch too", async () => {
    // The mirror case, also captured byte-exact: the project is *newer* than the
    // CLI, so the banner embeds the project version inside prose rather than on
    // the left of an arrow. Position-based parsing happens to survive this one,
    // which is exactly why the assertion is here - it must keep surviving.
    const stdout = [
      "",
      "⚠️  Your CLI (0.7.0-beta.4) is older than project (9.9.9)",
      "   Run: trellis upgrade",
      "",
      "0.7.0-beta.4",
      "",
    ].join("\n");
    const binDir = makeBinDir();
    const stub = makeExecFileStub({ [path.join(binDir, "trellis")]: { stdout } });
    const result = await cliWith(stub, { env: { PATH: binDir } }).readGlobalVersion();
    assert.strictEqual(result.version, "0.7.0-beta.4");
    assert.notStrictEqual(result.version, "9.9.9", "must not pick up the prose project version");
  });

  // 10-03: win32 skips the fs scan (it cannot model npm's `trellis.cmd` shim),
  // so discovery is one shell spawn that lets the shell resolve `trellis` —
  // same as any real spawn on that platform. No bin dir fixtures needed.
  it("detects a win32 install through the shell and parses the version", async () => {
    // Banner prefix + bare-version line, mirroring a `trellis --version` run
    // from a project stamped 0.6.17 with the CLI at 0.7.0-beta.4: the parser
    // must anchor on the whole-line version, not the banner's numbers.
    const stdout = [
      "⚠️  Trellis update available: 0.6.17 → 0.7.0-beta.4",
      "",
      "0.7.0-beta.4",
      "",
    ].join("\n");
    const stub = makeExecFileStub({ trellis: { stdout } });
    const result = await cliWith(stub, { platform: "win32" }).readGlobalVersion();
    assert.deepStrictEqual(result, {
      installed: true,
      version: "0.7.0-beta.4",
      error: null,
      path: null,
      installs: [],
    });
    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(stub.calls[0].bin, "trellis");
    assert.deepStrictEqual(stub.calls[0].args, ["--version"]);
    assert.strictEqual(stub.calls[0].options.shell, true);
  });

  it("reports not installed, not an error, when the win32 shell cannot resolve trellis", async () => {
    const stub = makeExecFileStub({
      trellis: { err: Object.assign(new Error("spawn trellis ENOENT"), { code: "ENOENT" }) },
    });
    const result = await cliWith(stub, { platform: "win32" }).readGlobalVersion();
    // "Not installed" is a state, not an error — same semantics as the POSIX
    // empty-PATH branch.
    assert.deepStrictEqual(result, { installed: false, version: null, error: null, path: null, installs: [] });
    assert.strictEqual(stub.calls.length, 1);
  });

  it("reports the failure when the win32 spawn fails for another reason", async () => {
    const stub = makeExecFileStub({
      trellis: { err: Object.assign(new Error("timed out"), { killed: true }) },
    });
    const result = await cliWith(stub, { platform: "win32" }).readGlobalVersion();
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.version, null);
    assert.ok(result.error, "a non-ENOENT failure must surface an error");
    assert.strictEqual(result.path, null);
    assert.deepStrictEqual(result.installs, []);
  });
});

describe("fetchRemoteChannels", () => {
  it("queries npm once and returns only the known channels", async () => {
    const stub = makeExecFileStub({
      npm: { stdout: JSON.stringify({ latest: "0.6.17", beta: "0.7.0-beta.4", rc: "0.6.0-rc.0", next: "9.9.9" }) },
    });
    const result = await cliWith(stub).fetchRemoteChannels();
    assert.deepStrictEqual(result.channels, { latest: "0.6.17", beta: "0.7.0-beta.4", rc: "0.6.0-rc.0" });
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(stub.calls[0].args, ["view", REMOTE_PACKAGE, "dist-tags", "--json"]);
    assert.strictEqual(stub.calls.length, 1);
  });

  it("returns an error value instead of throwing on non-JSON output", async () => {
    const stub = makeExecFileStub({ npm: { stdout: "npm ERR! something" } });
    const result = await cliWith(stub).fetchRemoteChannels();
    assert.strictEqual(result.channels, null);
    assert.strictEqual(result.error, "invalid-json");
  });

  it("returns an error value when the command fails", async () => {
    const stub = makeExecFileStub({
      npm: { err: Object.assign(new Error("offline"), { code: "ENOTFOUND" }), stderr: "network down" },
    });
    const result = await cliWith(stub).fetchRemoteChannels();
    assert.strictEqual(result.channels, null);
    assert.strictEqual(result.error, "network down");
  });

  it("rejects JSON with no usable channel", async () => {
    const stub = makeExecFileStub({ npm: { stdout: JSON.stringify({ next: "9.9.9" }) } });
    const result = await cliWith(stub).fetchRemoteChannels();
    assert.strictEqual(result.channels, null);
    assert.strictEqual(result.error, "no-channels");
  });
});

describe("upgradeGlobal", () => {
  it("runs trellis upgrade and re-reads the version", async () => {
    let version = "0.6.17";
    const binDir = makeBinDir();
    const binPath = path.join(binDir, "trellis");
    const stub = makeExecFileStub({
      // --version probes resolve to the absolute bin; upgrade still runs by name.
      [binPath]: () => ({ stdout: `${version}\n` }),
      trellis: () => { version = "0.7.0-beta.4"; return { stdout: "upgraded globally" }; },
    });
    const result = await cliWith(stub, { env: { PATH: binDir } }).upgradeGlobal();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.from, "0.6.17");
    assert.strictEqual(result.to, "0.7.0-beta.4");
    assert.deepStrictEqual(stub.calls[1].args, ["upgrade"]);
  });

  it("passes a known dist-tag as `--tag <tag>` (a bare positional is ignored by the CLI)", async () => {
    const stub = makeExecFileStub({ trellis: { stdout: "0.6.17\n" } });
    await cliWith(stub).upgradeGlobal("beta");
    assert.deepStrictEqual(stub.calls[1].args, ["upgrade", "--tag", "beta"]);
    assert.ok(stub.calls[1].args.includes("--tag"), "the dist-tag must ride the --tag flag");
  });

  it("treats null the same as omitted, keeping the auto channel", async () => {
    const stub = makeExecFileStub({ trellis: { stdout: "0.6.17\n" } });
    await cliWith(stub).upgradeGlobal(null);
    assert.deepStrictEqual(stub.calls[1].args, ["upgrade"]);
  });

  it("fails closed on an unknown channel without spawning anything", async () => {
    for (const channel of ["--evil", "latest; rm -rf /", "next", 7]) {
      const stub = makeExecFileStub({ trellis: { stdout: "0.6.17\n" } });
      const result = await cliWith(stub).upgradeGlobal(channel);
      assert.strictEqual(result.ok, false, String(channel));
      assert.strictEqual(result.error, "unknown-channel", String(channel));
      assert.strictEqual(stub.calls.length, 0, `${channel} must not reach execFile`);
    }
  });
});

describe("pure helpers", () => {
  it("parses versions out of noisy output", () => {
    assert.strictEqual(parseVersionOutput("v0.6.17"), "0.6.17");
    assert.strictEqual(parseVersionOutput("trellis 0.7.0-beta.3\n"), "0.7.0-beta.3");
    assert.strictEqual(parseVersionOutput("nothing"), null);
    assert.strictEqual(parseVersionOutput(""), null);
  });

  it("classifies failures into actionable buckets", () => {
    assert.strictEqual(classifyFailure(Object.assign(new Error("x"), { code: "ENOENT" })), "not-found");
    assert.strictEqual(classifyFailure(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "timeout");
    assert.strictEqual(classifyFailure(Object.assign(new Error("x"), { killed: true })), "timeout");
    assert.strictEqual(classifyFailure(Object.assign(new Error("x"), { name: "AbortError" })), "aborted");
    assert.strictEqual(classifyFailure(Object.assign(new Error("x"), { code: 1 })), "error");
  });
});

describe("augmentedCliPath", () => {
  it("appends the GUI-launch lookup dirs on macOS", () => {
    const out = augmentedCliPath("/usr/bin:/bin", { platform: "darwin", home: "/Users/tester" });
    const parts = out.split(":");
    assert.strictEqual(parts[0], "/usr/bin");
    assert.ok(parts.includes("/opt/homebrew/bin"));
    assert.ok(parts.includes("/usr/local/bin"));
    assert.ok(parts.includes("/Users/tester/.local/bin"));
  });

  it("does not duplicate a directory that is already on PATH", () => {
    const out = augmentedCliPath("/usr/bin:/usr/local/bin", { platform: "darwin", home: "/h" });
    assert.strictEqual(out.split(":").filter((dir) => dir === "/usr/local/bin").length, 1);
  });

  it("leaves a Windows PATH untouched", () => {
    const win = "C:\\Windows\\System32;C:\\Program Files\\nodejs";
    assert.strictEqual(augmentedCliPath(win, { platform: "win32", home: "C:\\Users\\t" }), win);
  });

  it("still yields the lookup dirs for an empty base PATH", () => {
    const out = augmentedCliPath("", { platform: "linux", home: "/h" });
    assert.ok(out.includes("/usr/local/bin"));
    assert.ok(out.includes("/h/.local/bin"));
    assert.ok(!out.startsWith(":"));
  });

  it("appends the user-scoped package-manager bins after the legacy ones", () => {
    // nvm enumeration stubbed out (no .nvm here) so the assertion is exactly
    // about the fixed user-scoped list and its position.
    const out = augmentedCliPath("/usr/bin:/bin", {
      platform: "darwin",
      home: "/Users/tester",
      fs: { readdirSync: () => { throw new Error("ENOENT"); } },
    });
    const parts = out.split(":");
    const userBins = [
      "/Users/tester/.npm-global/bin",
      "/Users/tester/.bun/bin",
      "/Users/tester/Library/pnpm",
      "/Users/tester/.volta/bin",
    ];
    for (const dir of userBins) assert.ok(parts.includes(dir), dir);
    // Everything new lands after ~/.local/bin, so an environment that already
    // resolves a CLI keeps resolving the same one.
    const local = parts.indexOf("/Users/tester/.local/bin");
    for (const dir of userBins) assert.ok(parts.indexOf(dir) > local, dir);
  });

  it("enumerates every nvm node version's bin, newest first", () => {
    const fsStub = { readdirSync: () => [
      { name: "v18.20.4", isDirectory: () => true },
      { name: "v22.14.0", isDirectory: () => true },
      { name: "v9.1.0", isDirectory: () => true },
      { name: "stray.txt", isDirectory: () => false },
    ] };
    const out = augmentedCliPath("/usr/bin:/bin", { platform: "linux", home: "/h", fs: fsStub });
    const parts = out.split(":");
    const v22 = parts.indexOf("/h/.nvm/versions/node/v22.14.0/bin");
    const v18 = parts.indexOf("/h/.nvm/versions/node/v18.20.4/bin");
    const v9 = parts.indexOf("/h/.nvm/versions/node/v9.1.0/bin");
    assert.ok(v22 !== -1 && v18 !== -1 && v9 !== -1, "every version dir present");
    assert.ok(v22 < v18 && v18 < v9, "numeric order, newest version first");
    assert.ok(!parts.some((dir) => dir.includes("stray")), "non-directory entries ignored");
  });
});

describe("resolveTrellisBinPath", () => {
  it("returns the first executable trellis on the PATH", () => {
    const first = makeTmpDir();
    const second = makeTmpDir();
    for (const dir of [first, second]) {
      const bin = path.join(dir, "trellis");
      fs.writeFileSync(bin, "#!/bin/sh\n");
      fs.chmodSync(bin, 0o755);
    }
    assert.strictEqual(
      resolveTrellisBinPath(`${first}:${second}`),
      path.join(first, "trellis"),
    );
  });

  it("skips a trellis without the execute bit and keeps scanning", () => {
    const noExec = makeTmpDir();
    const exec = makeTmpDir();
    fs.writeFileSync(path.join(noExec, "trellis"), "#!/bin/sh\n");
    fs.chmodSync(path.join(noExec, "trellis"), 0o644);
    const bin = path.join(exec, "trellis");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    assert.strictEqual(resolveTrellisBinPath(`${noExec}:${exec}`), bin);
  });

  it("reports null when no directory carries a trellis", () => {
    const empty = makeTmpDir();
    assert.strictEqual(resolveTrellisBinPath(`${empty}:/nonexistent`), null);
    assert.strictEqual(resolveTrellisBinPath(undefined), null);
  });

  it("never resolves on win32, where the spawn goes through a shell", () => {
    assert.strictEqual(
      resolveTrellisBinPath("C:\\bin", { platform: "win32" }),
      null,
    );
  });
});

describe("scanTrellisBinPaths", () => {
  it("collects every executable trellis in PATH order", () => {
    const a = makeBinDir();
    const b = makeBinDir();
    assert.deepStrictEqual(scanTrellisBinPaths(`${a}:${b}:/nonexistent`), [
      path.join(a, "trellis"),
      path.join(b, "trellis"),
    ]);
  });

  it("returns [] when nothing carries a trellis and on win32", () => {
    assert.deepStrictEqual(scanTrellisBinPaths("/nonexistent:/also-no"), []);
    assert.deepStrictEqual(scanTrellisBinPaths("/usr/bin", { platform: "win32" }), []);
  });
});

describe("buildCleanupCommand", () => {
  const NPM_REAL = "/usr/local/lib/node_modules/@mindfoldhq/trellis/bin/trellis.js";

  // Only realpathSync + accessSync are consulted; W_OK probes are steerable.
  function fakeFs({ real, writable = true }) {
    return {
      realpathSync: () => {
        if (real === null) throw new Error("ENOENT");
        return real;
      },
      accessSync: (_p, mode) => {
        if (mode === fs.constants.W_OK && !writable) throw new Error("EACCES");
      },
      constants: fs.constants,
    };
  }

  it("uninstalls through npm for an npm layout, sudo when the prefix is unwritable", () => {
    assert.strictEqual(
      buildCleanupCommand("/usr/local/bin/trellis", { fs: fakeFs({ real: NPM_REAL, writable: false }) }),
      "sudo npm uninstall -g @mindfoldhq/trellis --prefix /usr/local",
    );
    assert.strictEqual(
      buildCleanupCommand("/h/.npm-global/bin/trellis", {
        fs: fakeFs({ real: "/h/.npm-global/lib/node_modules/@mindfoldhq/trellis/bin/trellis.js" }),
      }),
      "npm uninstall -g @mindfoldhq/trellis --prefix /h/.npm-global",
    );
  });

  it("falls back to rm for a non-npm layout, quoting paths with spaces", () => {
    assert.strictEqual(
      buildCleanupCommand("/opt/weird/trellis", { fs: fakeFs({ real: "/opt/weird/trellis" }) }),
      "rm -f /opt/weird/trellis",
    );
    assert.strictEqual(
      buildCleanupCommand("/Applications/My App/bin/trellis", {
        fs: fakeFs({ real: "/somewhere/else", writable: false }),
      }),
      "sudo rm -f '/Applications/My App/bin/trellis'",
    );
  });

  it("returns null when the realpath probe fails or the input is empty", () => {
    assert.strictEqual(buildCleanupCommand("/gone/bin/trellis", { fs: fakeFs({ real: null }) }), null);
    assert.strictEqual(buildCleanupCommand("", { fs: fakeFs({ real: NPM_REAL }) }), null);
  });
});

describe("compareVersions", () => {
  it("orders numeric segments and the exact same version as equal", () => {
    assert.strictEqual(compareVersions("0.3.10", "0.7.0-beta.4"), -1);
    assert.strictEqual(compareVersions("0.7.0-beta.4", "0.3.10"), 1);
    assert.strictEqual(compareVersions("0.7.0-beta.4", "0.7.0-beta.4"), 0);
  });

  it("ranks a release above its prereleases", () => {
    assert.strictEqual(compareVersions("1.0.0", "1.0.0-beta.4"), 1);
    assert.strictEqual(compareVersions("1.0.0-beta.4", "1.0.0"), -1);
  });

  it("orders prereleases by identifier, numerics numerically and below alphanumerics", () => {
    assert.strictEqual(compareVersions("1.0.0-beta.1", "1.0.0-beta.2"), -1);
    assert.strictEqual(compareVersions("1.0.0-beta.2", "1.0.0-beta.2.1"), -1, "fewer identifiers rank lower");
    assert.strictEqual(compareVersions("1.0.0-1", "1.0.0-alpha"), -1, "numeric identifier ranks below alphanumeric");
  });

  it("returns 0 for anything it cannot parse", () => {
    assert.strictEqual(compareVersions("junk", "1.0.0"), 0);
    assert.strictEqual(compareVersions(null, "1.0.0"), 0);
    assert.strictEqual(compareVersions("", ""), 0);
  });
});
