"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readProjectVersion,
  readHashes,
  readPlatforms,
  readInstallState,
  scanRoot,
  scanRoots,
} = require("../src/trellis-scanner");

const tmpRoots = [];

function makeTmpDir(prefix = "trellis-scanner-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function writeFile(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

// A minimal but realistic installed project.
function makeProject(root, name, { version = "0.7.0-beta.3", hashes = null, dirs = [] } = {}) {
  const projectPath = path.join(root, name);
  writeFile(path.join(projectPath, ".trellis", ".version"), `${version}\n`);
  writeFile(path.join(projectPath, ".trellis", "workflow.md"), "# workflow\n");
  if (hashes) {
    writeFile(
      path.join(projectPath, ".trellis", ".template-hashes.json"),
      JSON.stringify({ __version: 2, hashes })
    );
  }
  for (const dir of dirs) fs.mkdirSync(path.join(projectPath, dir), { recursive: true });
  return projectPath;
}

describe("readProjectVersion", () => {
  it("returns the trimmed version stamp", () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha");
    assert.strictEqual(readProjectVersion(projectPath), "0.7.0-beta.3");
  });

  it("returns null for missing, empty or invalid input", () => {
    const root = makeTmpDir();
    const empty = path.join(root, "empty");
    writeFile(path.join(empty, ".trellis", ".version"), "   \n");
    assert.strictEqual(readProjectVersion(empty), null);
    assert.strictEqual(readProjectVersion(path.join(root, "nope")), null);
    assert.strictEqual(readProjectVersion(""), null);
    assert.strictEqual(readProjectVersion(null), null);
  });
});

describe("readHashes / readPlatforms", () => {
  it("parses the hashes object", () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha", {
      hashes: { ".claude/agents/x.md": "h", ".pi/prompts/y.md": "h", ".trellis/workflow.md": "h" },
    });
    assert.deepStrictEqual(Object.keys(readHashes(projectPath)).sort(), [
      ".claude/agents/x.md", ".pi/prompts/y.md", ".trellis/workflow.md",
    ]);
    assert.deepStrictEqual(readPlatforms(projectPath), ["claude-code", "pi"]);
  });

  it("treats missing, malformed and shapeless manifests as no platforms", () => {
    const root = makeTmpDir();
    const missing = makeProject(root, "missing");
    assert.strictEqual(readHashes(missing), null);
    assert.deepStrictEqual(readPlatforms(missing), []);

    const broken = makeProject(root, "broken");
    writeFile(path.join(broken, ".trellis", ".template-hashes.json"), "{ not json");
    assert.strictEqual(readHashes(broken), null);
    assert.deepStrictEqual(readPlatforms(broken), []);

    const arrayRoot = makeProject(root, "array-root");
    writeFile(path.join(arrayRoot, ".trellis", ".template-hashes.json"), "[1,2,3]");
    assert.strictEqual(readHashes(arrayRoot), null);

    const noHashes = makeProject(root, "no-hashes");
    writeFile(path.join(noHashes, ".trellis", ".template-hashes.json"), JSON.stringify({ __version: 2 }));
    assert.strictEqual(readHashes(noHashes), null);

    const badHashes = makeProject(root, "bad-hashes");
    writeFile(
      path.join(badHashes, ".trellis", ".template-hashes.json"),
      JSON.stringify({ __version: 2, hashes: [".claude/x"] })
    );
    assert.strictEqual(readHashes(badHashes), null);
    assert.deepStrictEqual(readPlatforms(badHashes), []);
  });

  it("surfaces future platform prefixes verbatim", () => {
    const root = makeTmpDir();
    const projectPath = makeProject(root, "alpha", {
      hashes: { ".claude/x": "h", ".futuretool/y": "h" },
    });
    assert.deepStrictEqual(readPlatforms(projectPath), ["claude-code", "unknown:.futuretool"]);
  });
});

describe("readInstallState", () => {
  it("accepts a .trellis directory with either a version stamp or scripts", () => {
    const root = makeTmpDir();
    const withVersion = makeProject(root, "with-version");
    assert.deepStrictEqual(readInstallState(withVersion), { installed: true, current: "0.7.0-beta.3" });

    const withScripts = path.join(root, "with-scripts");
    fs.mkdirSync(path.join(withScripts, ".trellis", "scripts"), { recursive: true });
    assert.deepStrictEqual(readInstallState(withScripts), { installed: true, current: null });
  });

  it("rejects a bare .trellis folder and non-Trellis directories", () => {
    const root = makeTmpDir();
    const bare = path.join(root, "bare");
    fs.mkdirSync(path.join(bare, ".trellis"), { recursive: true });
    assert.deepStrictEqual(readInstallState(bare), { installed: false, current: null });
    assert.deepStrictEqual(readInstallState(path.join(root, "nothing")), { installed: false, current: null });
  });
});

describe("scanRoot", () => {
  it("lists every direct child with its install state, in stable name order", () => {
    const root = makeTmpDir();
    makeProject(root, "beta-project");
    fs.mkdirSync(path.join(root, "alpha-plain"));
    makeProject(root, "zeta-project", { version: "0.6.17" });

    const result = scanRoot(root);
    assert.strictEqual(result.root, root);
    assert.strictEqual(result.readable, true);
    assert.deepStrictEqual(result.projects.map((p) => p.name), ["alpha-plain", "beta-project", "zeta-project"]);
    assert.deepStrictEqual(result.projects.map((p) => p.installed), [false, true, true]);
    assert.deepStrictEqual(result.projects.map((p) => p.current), [null, "0.7.0-beta.3", "0.6.17"]);
    assert.strictEqual(result.projects[1].path, path.join(root, "beta-project"));
  });

  it("skips hidden directories, node_modules and files", () => {
    const root = makeTmpDir();
    makeProject(root, "visible");
    makeProject(root, ".hidden-project");
    makeProject(root, "node_modules");
    writeFile(path.join(root, "README.md"), "x");
    writeFile(path.join(root, ".gitignore"), "x");

    const result = scanRoot(root);
    assert.deepStrictEqual(result.projects.map((p) => p.name), ["visible"]);
  });

  it("does not follow symlinks out of the root", () => {
    const root = makeTmpDir();
    const outside = makeTmpDir("trellis-scanner-outside-");
    makeProject(outside, "outside-project");
    fs.symlinkSync(path.join(outside, "outside-project"), path.join(root, "linked-project"), "dir");
    makeProject(root, "inside-project");

    const result = scanRoot(root);
    assert.deepStrictEqual(result.projects.map((p) => p.name), ["inside-project"]);
  });

  it("handles paths containing spaces and shell metacharacters", () => {
    const root = makeTmpDir();
    const trickyName = "my project & 'friends' (v2)";
    makeProject(root, trickyName);
    const result = scanRoot(root);
    assert.deepStrictEqual(result.projects.map((p) => p.name), [trickyName]);
    assert.strictEqual(result.projects[0].current, "0.7.0-beta.3");
    assert.strictEqual(result.projects[0].path, path.join(root, trickyName));
  });

  it("reports unreadable or missing roots instead of throwing", () => {
    const missing = scanRoot(path.join(os.tmpdir(), "trellis-scanner-does-not-exist"));
    assert.strictEqual(missing.readable, false);
    assert.deepStrictEqual(missing.projects, []);

    const fileRoot = makeTmpDir();
    const filePath = path.join(fileRoot, "a-file");
    writeFile(filePath, "x");
    assert.strictEqual(scanRoot(filePath).readable, false);

    assert.strictEqual(scanRoot(null).readable, false);
    assert.deepStrictEqual(scanRoot("").projects, []);
  });
});

describe("scanRoot platform reporting", () => {
  it("matches the recorded prefixes and flags a stale record", () => {
    const root = makeTmpDir();
    const staleProject = makeProject(root, "stale", {
      hashes: { ".claude/agents/x.md": "h", ".gemini/x.md": "h" },
      dirs: [".claude"],
    });
    const freshProject = makeProject(root, "fresh", {
      hashes: { ".claude/agents/x.md": "h", ".gemini/x.md": "h" },
      dirs: [".claude", ".gemini"],
    });

    const result = scanRoot(root);
    const byName = new Map(result.projects.map((p) => [p.name, p]));
    assert.deepStrictEqual(byName.get("stale").platforms, ["claude-code", "gemini"]);
    assert.deepStrictEqual(byName.get("stale").staleIds, ["gemini"]);
    assert.strictEqual(byName.get("stale").staleRecord, true);
    assert.deepStrictEqual(byName.get("fresh").platforms, ["claude-code", "gemini"]);
    assert.deepStrictEqual(byName.get("fresh").staleIds, []);
    assert.strictEqual(byName.get("fresh").staleRecord, false);
    assert.strictEqual(byName.get("fresh").path, freshProject);
    assert.strictEqual(byName.get("stale").path, staleProject);
  });

  it("reports only the missing platforms, never the ones that are present", () => {
    const root = makeTmpDir();
    // The UI renders `staleIds`, so a partial gap must not accuse the
    // platforms whose directories exist.
    makeProject(root, "partial", {
      hashes: { ".claude/x": "h", ".gemini/y": "h", ".pi/z": "h" },
      dirs: [".claude", ".pi"],
    });
    const result = scanRoot(root);
    assert.deepStrictEqual(result.projects[0].platforms, ["claude-code", "gemini", "pi"]);
    assert.deepStrictEqual(result.projects[0].staleIds, ["gemini"]);
  });

  it("does not report platforms for a project that is not installed", () => {
    const root = makeTmpDir();
    const projectPath = path.join(root, "no-trellis");
    writeFile(
      path.join(projectPath, ".template-hashes.json"),
      JSON.stringify({ hashes: { ".claude/x": "h" } })
    );
    const result = scanRoot(root);
    assert.deepStrictEqual(result.projects[0].platforms, []);
    assert.strictEqual(result.projects[0].installed, false);
    assert.deepStrictEqual(result.projects[0].staleIds, []);
    assert.strictEqual(result.projects[0].staleRecord, false);
  });
});

describe("scanRoots", () => {
  it("scans each root independently and keeps unreadable ones in place", () => {
    const rootA = makeTmpDir();
    const rootB = makeTmpDir();
    makeProject(rootA, "one");
    makeProject(rootB, "two");

    const results = scanRoots([rootA, path.join(os.tmpdir(), "missing-root-xyz"), rootB]);
    assert.strictEqual(results.length, 3);
    assert.deepStrictEqual(results[0].projects.map((p) => p.name), ["one"]);
    assert.strictEqual(results[1].readable, false);
    assert.deepStrictEqual(results[2].projects.map((p) => p.name), ["two"]);
    assert.deepStrictEqual(scanRoots(null), []);
  });
});
