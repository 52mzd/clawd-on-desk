"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  IGNORED_PREFIXES,
  PLATFORMS,
  UNKNOWN_PREFIX,
  parsePlatforms,
  flagsFor,
  isKnownPlatformId,
  platformById,
  platformLabel,
  staleIdsOf,
  staleOf,
} = require("../src/trellis-platforms");

const tmpRoots = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-platforms-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("PLATFORMS registry", () => {
  it("mirrors all 21 Trellis tools with unique prefixes, ids and flags", () => {
    assert.strictEqual(PLATFORMS.length, 21);
    const prefixes = new Set(PLATFORMS.map((p) => p.dirPrefix));
    const ids = new Set(PLATFORMS.map((p) => p.id));
    const flags = new Set(PLATFORMS.map((p) => p.cliFlag));
    assert.strictEqual(prefixes.size, 21);
    assert.strictEqual(ids.size, 21);
    assert.strictEqual(flags.size, 21);
    for (const entry of PLATFORMS) {
      assert.match(entry.dirPrefix, /^\./, `${entry.id} dirPrefix should be a dot-directory`);
      assert.strictEqual(entry.cliFlag, `--${entry.id === "claude-code" ? "claude" : entry.id}`, `flag shape for ${entry.id}`);
      assert.ok(entry.label.length > 0, `label for ${entry.id}`);
    }
  });

  it("maps every known prefix back to its own id and flag (all 21, both directions)", () => {
    for (const entry of PLATFORMS) {
      assert.deepStrictEqual(
        parsePlatforms({ [`${entry.dirPrefix}/agents/example.md`]: "hash" }),
        [entry.id],
        `parsePlatforms for ${entry.dirPrefix}`
      );
      assert.deepStrictEqual(flagsFor([entry.id]), [entry.cliFlag], `flagsFor for ${entry.id}`);
      assert.strictEqual(isKnownPlatformId(entry.id), true, `isKnownPlatformId ${entry.id}`);
      assert.strictEqual(platformById(entry.id).dirPrefix, entry.dirPrefix);
      assert.strictEqual(platformLabel(entry.id), entry.label);
    }
  });

  it("keeps ids whose dirPrefix differs from the id", () => {
    assert.deepStrictEqual(parsePlatforms({ ".claude/x": "h" }), ["claude-code"]);
    assert.deepStrictEqual(parsePlatforms({ ".factory/x": "h" }), ["droid"]);
    assert.deepStrictEqual(parsePlatforms({ ".github/x": "h" }), ["copilot"]);
    assert.deepStrictEqual(parsePlatforms({ ".kilocode/x": "h" }), ["kilo"]);
    assert.deepStrictEqual(parsePlatforms({ ".kimi-code/x": "h" }), ["kimi"]);
    assert.deepStrictEqual(parsePlatforms({ ".agent/x": "h" }), ["antigravity"]);
  });
});

describe("parsePlatforms", () => {
  it("reads multi-level config dirs down to their first segment", () => {
    const hashes = {
      ".kiro/skills/trellis-implement.md": "h",
      ".github/copilot/agents/trellis.md": "h",
      ".agent/workflows/start.md": "h",
      ".devin/workflows/start.md": "h",
      ".snow/skills/x.md": "h",
    };
    assert.deepStrictEqual(parsePlatforms(hashes), ["antigravity", "devin", "copilot", "kiro", "snow"]);
  });

  it("drops the prefixes every Trellis project has", () => {
    const hashes = {
      ".trellis/workflow.md": "h",
      "AGENTS.md": "h",
      ".agents/skills/x/SKILL.md": "h",
      ".claude/agents/trellis-implement.md": "h",
    };
    assert.deepStrictEqual(parsePlatforms(hashes), ["claude-code"]);
    assert.deepStrictEqual(IGNORED_PREFIXES, [".trellis", "AGENTS.md", ".agents"]);
  });

  it("preserves unknown prefixes instead of dropping or guessing", () => {
    const result = parsePlatforms({ ".futuretool/a": "h", ".claude/b": "h", ".another/z": "h" });
    assert.deepStrictEqual(result, ["claude-code", "unknown:.another", "unknown:.futuretool"]);
    assert.ok(result.includes(`${UNKNOWN_PREFIX}.futuretool`));
  });

  it("de-duplicates prefixes and returns a stable order", () => {
    const hashes = {
      ".pi/a": "h",
      ".pi/b": "h",
      ".claude/c": "h",
      ".gemini/d": "h",
    };
    assert.deepStrictEqual(parsePlatforms(hashes), ["claude-code", "gemini", "pi"]);
    assert.deepStrictEqual(parsePlatforms(hashes), parsePlatforms({ ...hashes, ".pi/e": "h" }));
  });

  it("returns [] for empty, null or non-object input", () => {
    for (const value of [null, undefined, {}, [], "hashes", 7]) {
      assert.deepStrictEqual(parsePlatforms(value), []);
    }
  });
});

describe("flagsFor", () => {
  it("maps ids to flags in the requested order", () => {
    assert.deepStrictEqual(flagsFor(["gemini"]), ["--gemini"]);
    assert.deepStrictEqual(flagsFor(["claude-code", "pi"]), ["--claude", "--pi"]);
    assert.deepStrictEqual(flagsFor([]), []);
  });

  it("fails closed on anything outside the whitelist", () => {
    assert.strictEqual(flagsFor(["--evil"]), null);
    assert.strictEqual(flagsFor(["pi; rm -rf /"]), null);
    assert.strictEqual(flagsFor(["gemini", "nope"]), null);
    assert.strictEqual(flagsFor(["unknown:.futuretool"]), null);
    assert.strictEqual(flagsFor([null]), null);
    assert.strictEqual(flagsFor("gemini"), null);
    assert.strictEqual(flagsFor(null), null);
  });
});

describe("staleIdsOf / staleOf", () => {
  it("flags a recorded platform whose directory is missing", () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, ".claude"));
    assert.deepStrictEqual(staleIdsOf(dir, ["claude-code", "gemini"]), ["gemini"]);
    assert.strictEqual(staleOf(dir, ["claude-code", "gemini"]), true);
  });

  it("is quiet when every recorded platform directory exists", () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.mkdirSync(path.join(dir, ".pi"));
    assert.deepStrictEqual(staleIdsOf(dir, ["claude-code", "pi"]), []);
    assert.strictEqual(staleOf(dir, ["claude-code", "pi"]), false);
  });

  it("skips ids it cannot resolve and tolerates bad input", () => {
    const dir = makeTmpDir();
    assert.deepStrictEqual(staleIdsOf(dir, ["unknown:.futuretool", "nope"]), []);
    assert.deepStrictEqual(staleIdsOf(dir, null), []);
    assert.strictEqual(staleOf(null, ["gemini"]), false);
  });
});
