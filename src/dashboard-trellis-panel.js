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
    check: { labelKey: "sessionHudTrellisPhaseCheck", cls: "phase-check" },
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
          parent: null,
          sessions: [],
        };
        byPath.set(taskPath, entry);
        order.push(entry);
      }
      if (!entry.title && typeof info.title === "string" && info.title.trim()) {
        entry.title = info.title;
      }
      // First non-empty parent wins (same policy as the title): the link is
      // written once by task.py and never moves for a given task dir.
      if (!entry.parent && typeof info.parent === "string" && info.parent.trim()) {
        entry.parent = info.parent;
      }
      entry.phase = info.phase;
      entry.progress = normalizeProgress(info.progress) || entry.progress;
      // cwd rides along for the detail view: its on-demand read resolves
      // the .trellis root from a bound session's working directory, exactly
      // like the polling binder does.
      entry.sessions.push({
        id: session.id,
        cwd: typeof session.cwd === "string" ? session.cwd : "",
        displayTitle: session.displayTitle || session.sessionTitle || session.id,
        agentId: session.agentId || null,
        agentName: session.agentName || null,
        canFocus: session.canFocus === true,
      });
    }
    return order;
  }

  // Parent/child grouping for the panel's task list. `parent` in task.json
  // is a sibling task NAME, so a child links to the parent only when a task
  // with path dirname(child.taskPath) + "/" + parent is itself in the
  // aggregated list — the same-directory rule keeps two same-named tasks in
  // different projects from fusing into one tree. Output is a flat render
  // sequence (depth-first, original aggregate order at every level):
  //   { task, depth, hasChildren, childSummary: {done,total}|null }
  // Orphans (parent missing from the live set), bad/blank parents and
  // parent cycles all flatten to depth 0 instead of erroring.
  function groupTrellisTasks(tasks) {
    const list = Array.isArray(tasks) ? tasks.filter((task) => task && task.taskPath) : [];
    const byPath = new Map();
    for (const task of list) byPath.set(task.taskPath, task);

    const childrenOf = new Map(); // parent taskPath → [task] (aggregate order)
    const hasLiveParent = new Set();
    for (const task of list) {
      const parentName = typeof task.parent === "string" ? task.parent.trim() : "";
      if (!parentName) continue;
      const slash = task.taskPath.lastIndexOf("/");
      if (slash < 0) continue;
      const parentPath = `${task.taskPath.slice(0, slash)}/${parentName}`;
      if (!byPath.has(parentPath)) continue; // orphan → flat
      hasLiveParent.add(task.taskPath);
      if (!childrenOf.has(parentPath)) childrenOf.set(parentPath, []);
      childrenOf.get(parentPath).push(task);
    }

    const childSummaryOf = new Map();
    function summary(taskPath) {
      if (childSummaryOf.has(taskPath)) return childSummaryOf.get(taskPath);
      // Reserve the slot before recursing so a parent cycle cannot loop.
      childSummaryOf.set(taskPath, null);
      let done = 0;
      let total = 0;
      let any = false;
      for (const child of childrenOf.get(taskPath) || []) {
        if (child.progress) {
          done += child.progress.done;
          total += child.progress.total;
          any = true;
        }
        const sub = summary(child.taskPath);
        if (sub) {
          done += sub.done;
          total += sub.total;
          any = true;
        }
      }
      const value = any ? { done, total } : null;
      childSummaryOf.set(taskPath, value);
      return value;
    }

    const rows = [];
    const emitted = new Set();
    function emit(task, depth) {
      if (emitted.has(task.taskPath)) return; // cycle guard
      emitted.add(task.taskPath);
      rows.push({
        task,
        depth,
        hasChildren: childrenOf.has(task.taskPath),
        childSummary: summary(task.taskPath),
      });
      for (const child of childrenOf.get(task.taskPath) || []) emit(child, depth + 1);
    }
    for (const task of list) {
      if (!hasLiveParent.has(task.taskPath)) emit(task, 0);
    }
    // Cycle members never surface at the top level (each one's parent is
    // live), so append them flat in aggregate order instead of dropping.
    for (const task of list) {
      if (!emitted.has(task.taskPath)) {
        emit(task, 0);
      }
    }
    return rows;
  }

  return { aggregateTrellisTasks, groupTrellisTasks, TRELLIS_PHASE_BADGE, normalizeProgress };
});
