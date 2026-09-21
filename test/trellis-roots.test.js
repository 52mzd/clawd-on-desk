"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { createTrellisRootsStore, TRELLIS_ROOTS_MAX } = require("../src/trellis-roots");

// In-memory fs twin: files as a map, writes recorded in order so the atomic
// tmp+rename shape is assertable.
function makeFakeFs() {
  const files = new Map();
  const ops = [];
  return {
    files,
    ops,
    readFileSync(p) {
      if (!files.has(p)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    },
    mkdirSync(p, opts) {
      ops.push(["mkdir", p, opts]);
    },
    writeFileSync(p, content) {
      ops.push(["write", p]);
      files.set(p, content);
    },
    renameSync(a, b) {
      ops.push(["rename", a, b]);
      if (!files.has(a)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      files.set(b, files.get(a));
      files.delete(a);
    },
  };
}

function makeHarness({ initial = null } = {}) {
  const fs = makeFakeFs();
  const warnings = [];
  const filePath = path.join("/home", "user", ".clawd", "trellis-roots.json");
  if (initial !== null) fs.files.set(filePath, initial);
  const store = createTrellisRootsStore({ fs, filePath, warn: (m) => warnings.push(m) });
  return { fs, store, filePath, warnings };
}

describe("trellis-roots store", () => {
  it("loads a persisted array and normalizes entries", () => {
    const { store } = makeHarness({
      initial: JSON.stringify(["/proj/a/", "/proj/b", 42, "", null, "/proj/a"]),
    });
    assert.deepStrictEqual(store.load(), [path.join("/proj", "a"), "/proj/b"]);
  });

  it("treats a missing file as no roots without writing", () => {
    const { store, fs } = makeHarness();
    assert.deepStrictEqual(store.load(), []);
    assert.deepStrictEqual(fs.ops, []);
  });

  it("treats corrupt or non-array content as no roots and warns once", () => {
    for (const bad of ["{not json", '{"a":1}', "null"]) {
      const { store, warnings } = makeHarness({ initial: bad });
      assert.deepStrictEqual(store.load(), [], bad);
      assert.strictEqual(warnings.length, 1, bad);
    }
  });

  it("add persists atomically (tmp write + rename) only on change", () => {
    const { store, fs, filePath } = makeHarness();
    const result = store.add("/proj/one");
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.roots, [path.join("/proj", "one")]);
    assert.deepStrictEqual(fs.ops, [
      ["mkdir", path.dirname(filePath), { recursive: true }],
      ["write", expectTmp(fs.ops, filePath)],
      ["rename", expectTmp(fs.ops, filePath), filePath],
    ]);
    assert.deepStrictEqual(JSON.parse(fs.files.get(filePath)), [path.join("/proj", "one")]);

    fs.ops.length = 0;
    assert.strictEqual(store.add("/proj/one/").status, "duplicate");
    assert.deepStrictEqual(fs.ops, []);
  });

  it("remove deletes a registered root and persists; unknown roots change nothing", () => {
    const { store, fs, filePath } = makeHarness({
      initial: JSON.stringify(["/proj/a", "/proj/b"]),
    });
    store.load();
    fs.ops.length = 0;
    assert.strictEqual(store.remove("/proj/b").status, "ok");
    assert.deepStrictEqual(store.list(), [path.join("/proj", "a")]);
    assert.deepStrictEqual(JSON.parse(fs.files.get(filePath)), [path.join("/proj", "a")]);

    fs.ops.length = 0;
    assert.strictEqual(store.remove("/proj/zzz").status, "not-found");
    assert.strictEqual(store.remove(42).status, "invalid");
    assert.deepStrictEqual(fs.ops, []);
  });

  it("enforces the roots cap", () => {
    const { store } = makeHarness();
    for (let i = 0; i < TRELLIS_ROOTS_MAX; i++) {
      assert.strictEqual(store.add(`/proj/p${i}`).status, "ok");
    }
    assert.strictEqual(store.add("/proj/overflow").status, "limit");
    assert.strictEqual(store.list().length, TRELLIS_ROOTS_MAX);
  });
});

// The tmp path must live in the same directory as the final file (atomic
// same-volume rename); returns it after asserting the shape.
function expectTmp(_ops, filePath) {
  return path.join(path.dirname(filePath), `.trellis-roots.json.${process.pid}.tmp`);
}
