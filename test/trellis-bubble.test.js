"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTrellisBubble } = require("../src/trellis-bubble.js");

function makeHarness(overrides = {}) {
  const win = {
    _shown: 0,
    _hidden: 0,
    _bounds: null,
    _texts: [],
    isDestroyed: () => false,
    setBounds(b) { this._bounds = b; },
    show() { this._shown += 1; },
    hide() { this._hidden += 1; },
    close() {},
  };
  const timers = [];
  const state = {
    dnd: false, petHidden: false, mini: false, petState: "idle",
    info: { taskPath: ".trellis/tasks/task-a", title: "Task A", phase: "plan" },
    petBounds: { x: 100, y: 700, width: 120, height: 120 },
    workArea: { x: 0, y: 0, width: 1512, height: 982 },
    avoidRects: [],
    permHeight: 0,
    hudOffset: 0,
  };
  const h = {
    win,
    state,
    ...overrides,
    bubble: createTrellisBubble({
      getDnd: () => state.dnd,
      getPetHidden: () => state.petHidden,
      getMiniMode: () => state.mini,
      getPetState: () => state.petState,
      getPetBounds: () => state.petBounds,
      getWorkArea: () => state.workArea,
      getAvoidRects: () => state.avoidRects,
      getHudReservedOffset: () => state.hudOffset,
      getPermissionReservedHeight: () => state.permHeight,
      getWindow: () => win,
      setText: (w, t) => win._texts.push(t),
      formatHint: ({ key, params }) => params
        ? `${key}|${params.done}/${params.total}`
        : key,
      getTrellisInfo: () => state.info,
      setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeoutFn: (id) => { timers[id - 1] = null; },
    }),
    fireTimers() {
      const pending = timers.filter(Boolean);
      timers.length = 0;
      pending.forEach((t) => t.fn());
    },
  };
  return h;
}

test("maybeShow shows once with title + plan hint", () => {
  const h = makeHarness();
  assert.strictEqual(h.bubble.maybeShow(), true);
  assert.strictEqual(h.win._shown, 1);
  assert.deepStrictEqual(h.win._texts, [{ title: "Task A", hint: "trellisHintPlan" }]);
  assert.ok(h.win._bounds);
});

test("same task shows only once per Clawd session", () => {
  const h = makeHarness();
  assert.strictEqual(h.bubble.maybeShow(), true);
  // 4s elapsed + gone hidden; second trigger for the same task stays silent.
  h.fireTimers();
  assert.strictEqual(h.win._hidden, 1);
  assert.strictEqual(h.bubble.maybeShow(), false);
  assert.strictEqual(h.win._shown, 1);
});

test("different task after rebind shows again", () => {
  const h = makeHarness();
  assert.strictEqual(h.bubble.maybeShow(), true);
  h.fireTimers();
  h.state.info = { taskPath: ".trellis/tasks/task-b", title: "Task B", phase: "finish" };
  assert.strictEqual(h.bubble.maybeShow(), true);
  assert.deepStrictEqual(h.win._texts.at(-1), { title: "Task B", hint: "trellisHintFinish" });
});

test("gate chain: dnd / petHidden / mini / non-idle suppress", () => {
  for (const gate of ["dnd", "petHidden", "mini"]) {
    const h = makeHarness();
    h.state[gate] = true;
    assert.strictEqual(h.bubble.maybeShow(), false, gate);
  }
  const h = makeHarness();
  h.state.petState = "working";
  assert.strictEqual(h.bubble.maybeShow(), false);
});

test("done phase and null info never bubble", () => {
  const h = makeHarness();
  h.state.info = { taskPath: ".x", title: "X", phase: "done" };
  assert.strictEqual(h.bubble.maybeShow(), false);
  h.state.info = null;
  assert.strictEqual(h.bubble.maybeShow(), false);
});

test("execute hint carries sanitized progress params", () => {
  const h = makeHarness();
  h.state.info = { taskPath: ".x", title: "X", phase: "execute", progress: { done: 2, total: 5 } };
  assert.strictEqual(h.bubble.maybeShow(), true);
  assert.strictEqual(h.win._texts[0].hint, "trellisHintExecute|2/5");
});

test("auto-hide fires once per show; hide is idempotent", () => {
  const h = makeHarness();
  h.bubble.maybeShow();
  h.fireTimers();
  h.fireTimers(); // no queued timers left — no double hide
  assert.strictEqual(h.win._hidden, 1);
  h.bubble.hide();
  h.bubble.hide();
  assert.strictEqual(h.win._hidden, 3); // explicit hides still count, no throw
});

test("relayout repositions while visible", () => {
  const h = makeHarness();
  h.bubble.maybeShow();
  const before = h.win._bounds.y;
  h.state.avoidRects = [{ x: 0, y: 0, width: 1512, height: 200 }];
  assert.strictEqual(h.bubble.relayout(), true);
  // Not guaranteed to move for every input, but must not crash and stay set.
  assert.ok(h.win._bounds);
  assert.strictEqual(typeof before, "number");
});

test("relayout is a no-op after hide", () => {
  const h = makeHarness();
  h.bubble.maybeShow();
  h.fireTimers();
  assert.strictEqual(h.bubble.relayout(), false);
});

test("dispose closes window and clears timers", () => {
  let closed = false;
  const win = { ...makeHarness().win, close() { closed = true; } };
  const timers = [];
  const bubble = createTrellisBubble({
    getDnd: () => false, getPetHidden: () => false, getMiniMode: () => false,
    getPetState: () => "idle",
    getPetBounds: () => ({ x: 100, y: 700, width: 120, height: 120 }),
    getWorkArea: () => ({ x: 0, y: 0, width: 1512, height: 982 }),
    getAvoidRects: () => [], getHudReservedOffset: () => 0,
    getPermissionReservedHeight: () => 0,
    getWindow: () => win, setText: () => {},
    formatHint: ({ key }) => key,
    getTrellisInfo: () => ({ taskPath: ".x", title: "X", phase: "plan" }),
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });
  bubble.maybeShow();
  assert.strictEqual(timers.length, 1);
  bubble.dispose();
  assert.strictEqual(closed, true);
});
