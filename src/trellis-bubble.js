"use strict";

// Idle thought-bubble that names the bound trellis task + a one-line
// next-step hint. Pure lifecycle/decision logic; all Electron-facing deps
// (window factory, timers, getters) are injected so tests run without
// Electron. Positioning reuses update-bubble's exported bounds calculator
// (same avoidance semantics as the update bubble: permission stack + HUD).

const path = require("path");
const { computeUpdateBubbleBounds } = require("./update-bubble.js").__test;

const SHOW_MS = 4000;
const BUBBLE_WIDTH = 260;
const BUBBLE_HEIGHT = 96;
const EDGE_MARGIN = 8;
const GAP = 10;
// PRD: same task+phase never re-pops within 10s, and rapid consecutive
// switches (<10s) must not pop again — both plain timestamp comparisons,
// no setTimeout chains.
const PHASE_TRANSITION_REPEAT_MS = 10 * 1000;

function createTrellisBubble(options) {
  const {
    getDnd,
    getPetHidden,
    getMiniMode,
    getPetState,
    getPetBounds,
    getWorkArea,
    getAvoidRects,
    getHudReservedOffset,
    getPermissionReservedHeight,
    getSleepingLike,       // () => boolean — pet is in a sleep-like render state (dozing/collapsing/sleeping)
    getWindow,            // () => BrowserWindow-like { setBounds, show, hide, close, isDestroyed }
    setText,              // (win, { title, hint }) => void  (executeJavaScript injection)
    formatHint,           // ({ key, params }) => localized string
    getTrellisInfo,       // () => TrellisInfo | null for the currently bound task
    now = () => Date.now(),
    setTimeoutFn = (...a) => setTimeout(...a),
    clearTimeoutFn = (t) => clearTimeout(t),
    getSleepingLikeFn = typeof getSleepingLike === "function" ? getSleepingLike : () => false,
  } = options;

  const shownTasks = new Set(); // taskPath (".trellis/tasks/<name>") → already shown this Clawd session
  // Phase-transition bubble (v3 lifecycle feedback): dedupe per
  // (taskPath, toPhase) + debounce per taskPath, both keyed independently
  // from the idle shownTasks set above.
  const phaseKeyShownAt = new Map();  // `${taskPath} ${toPhase}` → ms
  const phaseTaskShownAt = new Map(); // taskPath → ms
  let win = null;
  let hideTimer = null;
  let visible = false;

  function disposeWindow() {
    if (hideTimer) { clearTimeoutFn(hideTimer); hideTimer = null; }
    if (win) {
      const w = win;
      win = null;
      try { if (!w.isDestroyed()) w.close(); } catch (_) { /* already gone */ }
    }
  }

  function hide() {
    if (hideTimer) { clearTimeoutFn(hideTimer); hideTimer = null; }
    visible = false;
    if (win && !win.isDestroyed()) win.hide();
  }

  // Full gate chain; returns the task info to show, or null to stay silent.
  function evaluateGates() {
    if (getDnd()) return null;
    if (getPetHidden()) return null;
    if (getMiniMode()) return null;
    if (getPetState() !== "idle") return null;
    const info = getTrellisInfo();
    if (!info || !info.taskPath) return null;
    if (shownTasks.has(info.taskPath)) return null;
    return info;
  }

  function buildBounds() {
    const petBounds = getPetBounds();
    const workArea = getWorkArea();
    if (!petBounds || !workArea) return null;
    return computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: BUBBLE_WIDTH,
      height: BUBBLE_HEIGHT,
      edgeMargin: EDGE_MARGIN,
      gap: GAP,
      reservedHeight: getPermissionReservedHeight(),
      hudReservedOffset: getHudReservedOffset(),
      workArea,
      petBounds,
      avoidRects: getAvoidRects(),
    });
  }

  function maybeShow() {
    const info = evaluateGates();
    if (!info) return false;
    const hint = formatHintFor(info);
    if (!hint) return false;

    const bounds = buildBounds();
    if (!bounds) return false;

    if (!win) {
      win = getWindow();
      if (!win) return false;
    }
    if (win.isDestroyed()) { win = getWindow(); if (!win) return false; }

    win.setBounds(bounds);
    setText(win, { title: info.title || info.taskPath, hint });
    win.show();
    shownTasks.add(info.taskPath);
    visible = true;

    if (hideTimer) clearTimeoutFn(hideTimer);
    hideTimer = setTimeoutFn(hide, SHOW_MS);
    return true;
  }

  // Hint comes from the shared rule table; done/unknown produce no bubble.
  function formatHintFor(info) {
    const { deriveNextStepHint } = require("./trellis-phase.js");
    const hint = deriveNextStepHint(info);
    return hint ? formatHint(hint) : null;
  }

  // One-shot phase-transition bubble (PRD: task name + new phase). Shares
  // this module's window/bounds/injection with the idle bubble; the dedupe
  // key is taskPath+toPhase (independent of shownTasks), and a rapid switch
  // inside the 10s window rewrites the still-visible bubble to the final
  // phase instead of popping again. Gates: DND / hidden / mini / sleep-like
  // pet state (NOT agent-idle — a transition usually happens mid-work).
  function showPhaseTransitionBubble(transition) {
    if (!transition || typeof transition !== "object") return false;
    const taskPath = transition.taskPath;
    const toPhase = transition.toPhase;
    if (!taskPath || !toPhase) return false;
    if (getDnd() || getPetHidden() || getMiniMode()) return false;
    if (getSleepingLikeFn()) return false;

    const phaseLabel = typeof transition.phaseLabel === "string" && transition.phaseLabel
      ? transition.phaseLabel
      : toPhase;
    const hint = formatHint({ key: "trellisPhaseBubbleHint", params: { phase: phaseLabel } });
    if (!hint) return false;

    const nowMs = now();
    const dedupeKey = `${taskPath} ${toPhase}`;
    const lastKeyAt = phaseKeyShownAt.get(dedupeKey);
    if (lastKeyAt !== undefined && nowMs - lastKeyAt < PHASE_TRANSITION_REPEAT_MS) return false;
    const lastTaskAt = phaseTaskShownAt.get(taskPath);
    const inRapidWindow = lastTaskAt !== undefined && nowMs - lastTaskAt < PHASE_TRANSITION_REPEAT_MS;
    // Debounce: inside the window a still-visible bubble is rewritten to
    // the final phase (one pop, latest content); a hidden one stays hidden.
    if (inRapidWindow && !visible) return false;

    const bounds = buildBounds();
    if (!bounds) return false;
    if (!win) {
      win = getWindow();
      if (!win) return false;
    }
    if (win.isDestroyed()) { win = getWindow(); if (!win) return false; }

    win.setBounds(bounds);
    setText(win, { title: transition.title || taskPath, hint });
    if (!visible) win.show();
    phaseKeyShownAt.set(dedupeKey, nowMs);
    phaseTaskShownAt.set(taskPath, nowMs);
    visible = true;

    if (hideTimer) clearTimeoutFn(hideTimer);
    hideTimer = setTimeoutFn(hide, SHOW_MS);
    return true;
  }

  // Re-position while visible (permission bubble added/removed, HUD moved).
  function relayout() {
    if (!visible || !win || win.isDestroyed()) return false;
    const bounds = buildBounds();
    if (!bounds) return false;
    win.setBounds(bounds);
    return true;
  }

  return {
    maybeShow,
    showPhaseTransitionBubble,
    hide,
    relayout,
    dispose: disposeWindow,
    // test surface
    __test: { shownTasks, evaluateGates },
  };
}

module.exports = { createTrellisBubble, TRELLIS_BUBBLE_DIMENSIONS: { width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT } };
