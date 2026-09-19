"use strict";

// Pure aggregation for the Dashboard's Trellis panel: turns per-session
// trellis bindings (snapshot `entry.trellis`, produced by the read-only
// resolver in src/state-session-snapshot.js) into a deduplicated task list.
// UMD twin of session-focus-unavailable.js: required directly by tests,
// loaded as a sibling <script> by dashboard.html and consumed via
// globalThis — no DOM, no i18n, no IPC in here.

(function exposeDashboardTrellisPanel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawdDashboardTrellisPanel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildDashboardTrellisPanel() {
  // Mirrors the HUD phase-chip mapping (TRELLIS_PHASE_CHIP in
  // src/session-hud-renderer.js): labelKey reuses the existing 7-language
  // sessionHudTrellisPhase* strings; cls is the Dashboard-local badge class.
  // Phases outside this table (resolver drift) render nothing, never an
  // error — same null-semantics as the HUD chip.
  const TRELLIS_PHASE_BADGE = {
    plan: { labelKey: "sessionHudTrellisPhasePlan", cls: "phase-plan" },
    execute: { labelKey: "sessionHudTrellisPhaseExecute", cls: "phase-execute" },
    finish: { labelKey: "sessionHudTrellisPhaseFinish", cls: "phase-finish" },
    done: { labelKey: "sessionHudTrellisPhaseDone", cls: "phase-done" },
  };

  function normalizeProgress(progress) {
    const done = Number(progress && progress.done);
    const total = Number(progress && progress.total);
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
    return { done: Math.max(0, Math.trunc(done)), total: Math.trunc(total) };
  }

  // Deduplicates sessions per task: the same taskPath bound to several
  // sessions becomes one entry whose `sessions` lists every binding, so the
  // panel answers "which task, which phase, how many sessions are on it"
  // without a second data source. Tasks only reachable through sessions the
  // Dashboard cannot see are out of scope by design (v1 renders the
  // per-session bindings it is given). Phase/progress take the last valid
  // observation; the title takes the first non-empty one and falls back to
  // taskPath at render time (same fallback as the HUD tooltip).
  function aggregateTrellisTasks(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    const byPath = new Map();
    const order = [];
    for (const session of list) {
      const info = session && session.trellis;
      if (!info || typeof info !== "object") continue;
      if (!TRELLIS_PHASE_BADGE[info.phase]) continue;
      const taskPath = typeof info.taskPath === "string" ? info.taskPath.trim() : "";
      if (!taskPath) continue;
      let entry = byPath.get(taskPath);
      if (!entry) {
        entry = {
          taskPath,
          title: "",
          phase: null,
          progress: null,
          sessions: [],
        };
        byPath.set(taskPath, entry);
        order.push(entry);
      }
      if (!entry.title && typeof info.title === "string" && info.title.trim()) {
        entry.title = info.title;
      }
      entry.phase = info.phase;
      entry.progress = normalizeProgress(info.progress) || entry.progress;
      entry.sessions.push({
        id: session.id,
        displayTitle: session.displayTitle || session.sessionTitle || session.id,
        agentId: session.agentId || null,
        agentName: session.agentName || null,
        canFocus: session.canFocus === true,
      });
    }
    return order;
  }

  return { aggregateTrellisTasks, TRELLIS_PHASE_BADGE, normalizeProgress };
});
