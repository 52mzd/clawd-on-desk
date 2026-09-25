"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createTrellisCli,
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

  it("adds a platform with exactly [init, -u <name>, --gemini, -y]", async () => {
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
    // 09-25: -u <folder-name> rides init (fresh projects abort without it).
    assert.deepStrictEqual(stub.calls[0].args, ["init", "-u", path.basename(projectPath), "--gemini", "-y"]);
    assert.deepStrictEqual(Array.from(INIT_ARGS_SUFFIX), ["-y"]);
    assert.ok(!stub.calls[0].args.includes("-s"), "-s must never be passed to init");
    assert.ok(!stub.calls[0].args.includes("--skip-all"));
    assert.ok(!stub.calls[0].args.includes("-f"), "-f must never be passed to init");
    assert.ok(!stub.calls[0].args.includes("--force"));
    assert.strictEqual(stub.calls[0].options.cwd, projectPath);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.added, ["gemini"]);
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
    const stub = makeExecFileStub({ trellis: { stdout: "v0.6.17\n" } });
    const result = await cliWith(stub).readGlobalVersion();
    assert.deepStrictEqual(result, { installed: true, version: "0.6.17", error: null });
    assert.deepStrictEqual(stub.calls[0].args, ["--version"]);
  });

  it("reports not installed when the binary is missing", async () => {
    const stub = makeExecFileStub({
      trellis: { err: Object.assign(new Error("not found"), { code: "ENOENT" }) },
    });
    const result = await cliWith(stub).readGlobalVersion();
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.version, null);
    assert.ok(result.error);
  });

  it("keeps installed true but version null when output is unparsable", async () => {
    const stub = makeExecFileStub({ trellis: { stdout: "no version here" } });
    const result = await cliWith(stub).readGlobalVersion();
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
    const stub = makeExecFileStub({ trellis: { stdout } });
    const result = await cliWith(stub).readGlobalVersion();
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
    const stub = makeExecFileStub({ trellis: { stdout } });
    const result = await cliWith(stub).readGlobalVersion();
    assert.strictEqual(result.version, "0.7.0-beta.4");
    assert.notStrictEqual(result.version, "9.9.9", "must not pick up the prose project version");
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
    const stub = makeExecFileStub({
      trellis: (call) => {
        if (call.args[0] === "--version") return { stdout: `${version}\n` };
        version = "0.7.0-beta.4";
        return { stdout: "upgraded globally" };
      },
    });
    const result = await cliWith(stub).upgradeGlobal();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.from, "0.6.17");
    assert.strictEqual(result.to, "0.7.0-beta.4");
    assert.deepStrictEqual(stub.calls[1].args, ["upgrade"]);
  });

  it("passes a known dist-tag as the second argv token", async () => {
    const stub = makeExecFileStub({ trellis: { stdout: "0.6.17\n" } });
    await cliWith(stub).upgradeGlobal("beta");
    assert.deepStrictEqual(stub.calls[1].args, ["upgrade", "beta"]);
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
