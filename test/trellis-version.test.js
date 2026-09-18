"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  parseVersion,
  compareVersions,
  inferChannel,
  resolveTarget,
  evaluate,
} = require("../src/trellis-version");

describe("parseVersion", () => {
  it("splits base and prerelease identifiers", () => {
    assert.deepStrictEqual(parseVersion("0.7.0-beta.3"), { base: [0, 7, 0], pre: ["beta", "3"] });
    assert.deepStrictEqual(parseVersion("0.6.17"), { base: [0, 6, 17], pre: [] });
    assert.deepStrictEqual(parseVersion("v1.2.3"), { base: [1, 2, 3], pre: [] });
    assert.deepStrictEqual(parseVersion(" 0.6.0-rc.0 "), { base: [0, 6, 0], pre: ["rc", "0"] });
  });

  it("rejects unparsable input", () => {
    for (const value of [null, undefined, "", "   ", 42, {}, "latest", "0.x.0", "0.7.0-"]) {
      assert.strictEqual(parseVersion(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });
});

describe("compareVersions", () => {
  it("orders base segments numerically, padding missing segments", () => {
    assert.strictEqual(compareVersions("0.6.17", "0.6.17"), 0);
    assert.strictEqual(compareVersions("0.7.0", "0.6.17"), 1);
    assert.strictEqual(compareVersions("0.6.17", "0.7.0"), -1);
    assert.strictEqual(compareVersions("1.0", "1.0.0"), 0);
    assert.strictEqual(compareVersions("1.0.1", "1.0"), 1);
  });

  it("ranks a release above a prerelease of the same base", () => {
    assert.strictEqual(compareVersions("0.7.0", "0.7.0-beta.3"), 1);
    assert.strictEqual(compareVersions("0.7.0-beta.3", "0.7.0"), -1);
    assert.strictEqual(compareVersions("0.7.0-beta.10", "0.7.0-beta.3"), 1);
    assert.strictEqual(compareVersions("0.7.0-rc.1", "0.7.0-beta.9"), 1);
  });

  it("compares numeric prerelease identifiers numerically, not lexically", () => {
    assert.strictEqual(compareVersions("0.7.0-beta.9", "0.7.0-beta.10"), -1);
  });

  it("returns null instead of guessing when a side is unparsable", () => {
    assert.strictEqual(compareVersions("nonsense", "0.6.17"), null);
    assert.strictEqual(compareVersions("0.6.17", null), null);
  });
});

describe("inferChannel", () => {
  it("routes prereleases to their channel and everything else to latest", () => {
    assert.strictEqual(inferChannel("0.7.0-beta.3"), "beta");
    assert.strictEqual(inferChannel("0.6.0-rc.0"), "rc");
    assert.strictEqual(inferChannel("0.6.17"), "latest");
    assert.strictEqual(inferChannel("0.7.0"), "latest");
    assert.strictEqual(inferChannel(null), "latest");
  });

  it("does not mistake a longer identifier for a channel tag", () => {
    assert.strictEqual(inferChannel("0.7.0-betamax.1"), "latest");
  });
});

describe("resolveTarget", () => {
  it("reads only the requested channel", () => {
    const channels = { latest: "0.6.17", beta: "0.7.0-beta.4", rc: "0.6.0-rc.0" };
    assert.strictEqual(resolveTarget(channels, "beta"), "0.7.0-beta.4");
    assert.strictEqual(resolveTarget(channels, "latest"), "0.6.17");
    assert.strictEqual(resolveTarget(channels, "missing"), null);
    assert.strictEqual(resolveTarget(null, "latest"), null);
  });
});

describe("evaluate", () => {
  const channels = { latest: "0.6.17", beta: "0.7.0-beta.4", rc: "0.6.0-rc.0" };

  it("reports an equal version as not upgradable", () => {
    assert.deepStrictEqual(
      evaluate({ current: "0.6.17", channels, channel: "latest" }),
      { target: "0.6.17", upgradable: false }
    );
  });

  it("reports a behind beta project as upgradable", () => {
    assert.deepStrictEqual(
      evaluate({ current: "0.7.0-beta.3", channels, channel: "beta" }),
      { target: "0.7.0-beta.4", upgradable: true }
    );
  });

  it("never offers a downgrade when the local version is ahead of the channel", () => {
    assert.deepStrictEqual(
      evaluate({ current: "0.9.0", channels, channel: "latest" }),
      { target: "0.6.17", upgradable: false }
    );
    assert.deepStrictEqual(
      evaluate({ current: "0.7.0", channels, channel: "beta" }),
      { target: "0.7.0-beta.4", upgradable: false }
    );
  });

  it("routes a plain version to latest rather than beta", () => {
    const inferred = inferChannel("0.6.17");
    assert.strictEqual(inferred, "latest");
    assert.deepStrictEqual(
      evaluate({ current: "0.6.17", channels, channel: inferred }),
      { target: "0.6.17", upgradable: false }
    );
  });

  it("returns unknown (not false) when the remote channels are unavailable", () => {
    assert.deepStrictEqual(
      evaluate({ current: "0.6.17", channels: null, channel: "latest" }),
      { target: null, upgradable: null }
    );
    assert.deepStrictEqual(
      evaluate({ current: "0.6.17", channels: {}, channel: "latest" }),
      { target: null, upgradable: null }
    );
  });

  it("returns unknown when the installed version cannot be read or parsed", () => {
    assert.deepStrictEqual(
      evaluate({ current: null, channels, channel: "latest" }),
      { target: "0.6.17", upgradable: null }
    );
    assert.deepStrictEqual(
      evaluate({ current: "not-a-version", channels, channel: "latest" }),
      { target: "0.6.17", upgradable: null }
    );
  });
});
