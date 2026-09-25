"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createTrellisCelebration,
  pickCelebrationReaction,
} = require("../src/trellis-celebration");

// Clawd's real reactions.double entry (themes/clawd/theme.json): a files
// pool plus a duration — the same clips a 4-click combo plays.
const CLAWD_THEME = {
  reactions: {
    double: { files: ["clawd-react-double.svg", "clawd-react-double-jump.svg"], duration: 3500 },
  },
};

function makeCelebration(overrides = {}) {
  const played = [];
  const deps = {
    getDnd: () => false,
    getPetHidden: () => false,
    getMiniMode: () => false,
    getTheme: () => CLAWD_THEME,
    playReaction: (file, duration) => {
      played.push([file, duration]);
      return { dispatched: true };
    },
    ...overrides,
  };
  return { celebrate: createTrellisCelebration(deps), played };
}

describe("pickCelebrationReaction", () => {
  it("picks a clip from the double files pool with the theme duration", () => {
    const plan = pickCelebrationReaction(CLAWD_THEME);
    assert.ok(plan, "clawd has a double reaction");
    assert.ok(CLAWD_THEME.reactions.double.files.includes(plan.file));
    assert.strictEqual(plan.duration, 3500);
  });

  it("falls back to a single file entry and the default duration", () => {
    const plan = pickCelebrationReaction({ reactions: { double: { file: "x.svg" } } });
    assert.deepStrictEqual(plan, { file: "x.svg", duration: 3500 });
  });

  it("returns null for themes without a double reaction (Calico, Cloudling)", () => {
    assert.strictEqual(pickCelebrationReaction({ reactions: {} }), null);
    assert.strictEqual(pickCelebrationReaction({}), null);
    assert.strictEqual(pickCelebrationReaction(null), null);
    // Structurally present but empty → still nothing to celebrate.
    assert.strictEqual(pickCelebrationReaction({ reactions: { double: { files: [] } } }), null);
    assert.strictEqual(pickCelebrationReaction({ reactions: { double: {} } }), null);
  });
});

describe("createTrellisCelebration", () => {
  it("dispatches a double clip through the one-shot reaction entry", () => {
    const { celebrate, played } = makeCelebration();
    assert.strictEqual(celebrate("rel/path"), true);
    assert.strictEqual(played.length, 1);
    assert.ok(CLAWD_THEME.reactions.double.files.includes(played[0][0]));
    assert.strictEqual(played[0][1], 3500);
  });

  it("stays silent while DND is on", () => {
    const { celebrate, played } = makeCelebration({ getDnd: () => true });
    assert.strictEqual(celebrate(), false);
    assert.strictEqual(played.length, 0);
  });

  it("stays silent while the pet is hidden", () => {
    const { celebrate, played } = makeCelebration({ getPetHidden: () => true });
    assert.strictEqual(celebrate(), false);
    assert.strictEqual(played.length, 0);
  });

  it("stays silent in mini mode", () => {
    const { celebrate, played } = makeCelebration({ getMiniMode: () => true });
    assert.strictEqual(celebrate(), false);
    assert.strictEqual(played.length, 0);
  });

  it("skips themes that ship no double reaction", () => {
    const { celebrate, played } = makeCelebration({ getTheme: () => ({ reactions: { drag: { file: "d.svg" } } }) });
    assert.strictEqual(celebrate(), false);
    assert.strictEqual(played.length, 0);
  });

  it("reports no dispatch when the entry rejects a missing asset", () => {
    // requestClickReaction returns null for files the active theme does not
    // ship — that null is the missing-asset silent skip, not an error.
    const rejected = [];
    const { celebrate } = makeCelebration({
      playReaction: (file, duration) => { rejected.push([file, duration]); return null; },
    });
    assert.strictEqual(celebrate(), false);
    assert.strictEqual(rejected.length, 1, "the entry was still consulted");
  });

  it("never throws — a throwing gate or entry degrades to no celebration", () => {
    const { celebrate, played } = makeCelebration({
      getTheme: () => { throw new Error("boom"); },
    });
    assert.strictEqual(celebrate(), false);
    assert.strictEqual(played.length, 0);
    const broken = makeCelebration({
      playReaction: () => { throw new Error("boom"); },
    });
    assert.strictEqual(broken.celebrate(), false);
  });
});
