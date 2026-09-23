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
        childCount: (childrenOf.get(task.taskPath) || []).length,
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

  // Archive rows come back newest-completed-first (readArchiveList order).
  // Group them by the month segment of taskPath — the "<month>" inside the
  // "/archive/" segment of the full posix path readArchiveList emits
  // (".trellis/tasks/archive/<month>/<name>") — months sorted descending
  // (string compare matches YYYY-MM), preserving the incoming order inside
  // each month. Unknown shapes (no /archive/ segment / empty month) collect
  // under "" and render after real months.
  function trellisArchiveMonthOf(taskPath) {
    const marker = "/archive/";
    const idx = taskPath.indexOf(marker);
    if (idx < 0) return "";
    const rest = taskPath.slice(idx + marker.length);
    const slash = rest.indexOf("/");
    return slash <= 0 ? "" : rest.slice(0, slash);
  }

  function groupTrellisArchiveByMonth(tasks) {
    const list = Array.isArray(tasks) ? tasks.filter((task) => task && typeof task.taskPath === "string") : [];
    const byMonth = new Map();
    for (const task of list) {
      const month = trellisArchiveMonthOf(task.taskPath);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(task);
    }
    const months = [...byMonth.keys()].sort((a, b) => (a === b ? 0 : a < b ? 1 : -1));
    return months.map((month) => ({ month, tasks: byMonth.get(month) }));
  }

  // ── Unified task tree (independent Trellis view) ──────────────────────────
  // buildTrellisTree(activeTasks, archivedTasks) nests both readActiveList /
  // readArchiveList outputs by the task.json `parent` NAME into one tree of
  // nodes { task, archived, depth, children, childSummary }. The `parent`
  // field is a sibling task NAME, so every link below is resolved by name
  // against one candidate set at a time — any ambiguity (duplicates, or a
  // name that matches nothing) flattens the child instead of guessing:
  //   • active child → active parent by same-directory taskPath
  //     (dirname(child.taskPath) + "/" + parent) — the groupTrellisTasks rule
  //   • active child not in the active set → the unique archived task with
  //     that NAME (any month); 0 or ≥2 candidates → flat
  //   • archived child → archived parent with that NAME: same month first,
  //     then a unique cross-month match (PRD order); ambiguous → flat
  //   • archived child → the unique ACTIVE task with that NAME (archived
  //     subtask shown grey under its still-active parent); else flat
  // Self-parents, parent cycles and nesting deeper than the depth cap all
  // flatten to depth 0 instead of erroring (emitted-guard pattern), and
  // childSummary sums every descendant's progress (archived tasks carry
  // none, so they never skew the numbers). Active roots come first in
  // readActiveList order, then archive roots newest-completed-first.
  const TRELLIS_TREE_DEPTH_CAP = 32;

  function taskPathName(taskPath) {
    return taskPath.slice(taskPath.lastIndexOf("/") + 1);
  }

  function buildTrellisTree(activeTasks, archivedTasks) {
    // Same cross-root duplicate taskPath renders once (groupTrellisTasks
    // semantics); archive duplicates keep every row like the v2 list did.
    const actives = [];
    const seenActivePath = new Set();
    for (const task of Array.isArray(activeTasks) ? activeTasks : []) {
      if (!task || typeof task.taskPath !== "string" || !task.taskPath) continue;
      if (seenActivePath.has(task.taskPath)) continue;
      seenActivePath.add(task.taskPath);
      actives.push(task);
    }
    const archives = [];
    for (const task of Array.isArray(archivedTasks) ? archivedTasks : []) {
      if (!task || typeof task.taskPath !== "string" || !task.taskPath) continue;
      archives.push(task);
    }

    const activeByPath = new Map(); // taskPath → index (first wins)
    const activeNameCounts = new Map();
    for (let i = 0; i < actives.length; i++) {
      activeByPath.set(actives[i].taskPath, i);
      const name = taskPathName(actives[i].taskPath);
      if (name) activeNameCounts.set(name, (activeNameCounts.get(name) || 0) + 1);
    }
    const archivesByName = new Map(); // name → [{ key, month }]
    for (let j = 0; j < archives.length; j++) {
      const name = taskPathName(archives[j].taskPath);
      if (!name) continue;
      if (!archivesByName.has(name)) archivesByName.set(name, []);
      archivesByName.get(name).push({ key: `r${j}`, month: trellisArchiveMonthOf(archives[j].taskPath) });
    }

    function activeParentKey(task) {
      const parentName = typeof task.parent === "string" ? task.parent.trim() : "";
      if (!parentName) return null;
      const slash = task.taskPath.lastIndexOf("/");
      const parentPath = `${slash < 0 ? "" : task.taskPath.slice(0, slash)}/${parentName}`;
      if (parentPath === task.taskPath) return null; // self-parent → flat
      const idx = activeByPath.get(parentPath);
      if (idx !== undefined) return `a${idx}`;
      const archived = archivesByName.get(parentName);
      return archived && archived.length === 1 ? archived[0].key : null;
    }

    function archivedParentKey(task, ownKey) {
      const parentName = typeof task.parent === "string" ? task.parent.trim() : "";
      if (!parentName) return null;
      const candidates = (archivesByName.get(parentName) || []).filter((c) => c.key !== ownKey);
      const sameMonth = candidates.filter((c) => c.month === trellisArchiveMonthOf(task.taskPath));
      let pick = null;
      if (sameMonth.length === 1) pick = sameMonth[0];
      else if (sameMonth.length === 0 && candidates.length === 1) pick = candidates[0];
      if (pick) return pick.key;
      if (activeNameCounts.get(parentName) === 1) {
        for (let i = 0; i < actives.length; i++) {
          if (taskPathName(actives[i].taskPath) === parentName) return `a${i}`;
        }
      }
      return null;
    }

    const taskOfKey = new Map();
    const childrenOf = new Map(); // parent key → [child key]
    const hasParent = new Set();
    for (let i = 0; i < actives.length; i++) {
      const key = `a${i}`;
      taskOfKey.set(key, actives[i]);
      const parentKey = activeParentKey(actives[i]);
      if (parentKey !== null) {
        hasParent.add(key);
        if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
        childrenOf.get(parentKey).push(key);
      }
    }
    for (let j = 0; j < archives.length; j++) {
      const key = `r${j}`;
      taskOfKey.set(key, archives[j]);
      const parentKey = archivedParentKey(archives[j], key);
      if (parentKey !== null) {
        hasParent.add(key);
        if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
        childrenOf.get(parentKey).push(key);
      }
    }

    const roots = [];
    const emitted = new Set();
    const overflow = []; // depth-cap pushdowns, flattened as roots afterwards
    function emit(key, depth, into) {
      if (emitted.has(key)) return; // cycle guard
      emitted.add(key);
      const node = {
        task: taskOfKey.get(key),
        archived: key[0] === "r",
        depth,
        children: [],
        childSummary: null,
      };
      into.push(node);
      const childKeys = childrenOf.get(key) || [];
      if (depth < TRELLIS_TREE_DEPTH_CAP) {
        for (const childKey of childKeys) emit(childKey, depth + 1, node.children);
      } else {
        for (const childKey of childKeys) overflow.push(childKey);
      }
    }
    for (let i = 0; i < actives.length; i++) {
      if (!hasParent.has(`a${i}`)) emit(`a${i}`, 0, roots);
    }
    for (let j = 0; j < archives.length; j++) {
      if (!hasParent.has(`r${j}`)) emit(`r${j}`, 0, roots);
    }
    // Cycle members (their parents are live, so the DFS never reached
    // them) and depth-cap pushdowns flatten to depth 0 in list order.
    for (let i = 0; i < actives.length; i++) {
      if (!emitted.has(`a${i}`)) emit(`a${i}`, 0, roots);
    }
    for (const key of overflow) emit(key, 0, roots);
    for (let j = 0; j < archives.length; j++) {
      if (!emitted.has(`r${j}`)) emit(`r${j}`, 0, roots);
    }

    function summarize(node) {
      let done = 0;
      let total = 0;
      let any = false;
      for (const child of node.children) {
        const progress = child.task && child.task.progress;
        if (progress && Number.isFinite(progress.done) && Number.isFinite(progress.total) && progress.total > 0) {
          done += progress.done;
          total += progress.total;
          any = true;
        }
        const sub = summarize(child);
        if (sub) {
          done += sub.done;
          total += sub.total;
          any = true;
        }
      }
      node.childSummary = any ? { done, total } : null;
      return node.childSummary;
    }
    for (const node of roots) summarize(node);
    return { roots, depthCap: TRELLIS_TREE_DEPTH_CAP };
  }

  // ── Project filter (independent Trellis view) ────────────────────────────
  // The filter is a pure render-layer concern: readActiveList /
  // readArchiveList rows carry the trusted `cwd` that owns their root, and
  // a registered root owns every cwd at or under it (main resolves roots
  // by walking cwd upward, separators already platform-normalized, no case
  // folding — matching here stays exact for the same reason). Nested roots
  // pick the longest (most specific) owner so a task never counts twice.
  function trellisTaskOwningRoot(cwd, roots) {
    if (typeof cwd !== "string" || !cwd) return null;
    const list = Array.isArray(roots) ? roots : [];
    let best = null;
    for (const root of list) {
      if (typeof root !== "string" || !root) continue;
      if (cwd !== root && !cwd.startsWith(root + "/") && !cwd.startsWith(root + "\\")) continue;
      if (best === null || root.length > best.length) best = root;
    }
    return best;
  }

  // selectedRoot null = "all" (merged cross-project list); otherwise only
  // tasks whose owning root is exactly the selected one survive.
  function filterTrellisTasksByRoot(tasks, roots, selectedRoot) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (selectedRoot === null || typeof selectedRoot !== "string") return list;
    return list.filter((task) => trellisTaskOwningRoot(task && task.cwd, roots) === selectedRoot);
  }

  function trellisRootSegments(root) {
    return String(root).split(/[\\/]+/).filter(Boolean);
  }

  // Chip labels: the root's basename, disambiguated only when several
  // roots share it — first with the parent segment ("name (parent)"), then
  // deeper ancestors ("name (grand/parent)"), finally the full path so a
  // label is never ambiguous.
  // v5-b board bucketing: map each task (active row shape or archived
  // entry shape) to its board column phase. Archived entries always land
  // in "done"; unknown/missing phases fall back to "execute" (the busiest
  // column, so nothing silently disappears into a corner).
  const BOARD_PHASES_ARRAY = ["plan", "execute", "check", "finish", "done"];
  const BOARD_PHASES = new Set(BOARD_PHASES_ARRAY);

  function boardPhaseFor(task) {
    if (!task || typeof task !== "object") return "execute";
    if (task.completedAt || task.archived === true) return "done";
    if (typeof task.phase === "string" && BOARD_PHASES.has(task.phase)) return task.phase;
    return "execute";
  }

  function bucketByBoardPhase(activeTasks, archiveTasks) {
    const byPhase = new Map(BOARD_PHASES_ARRAY.map((phase) => [phase, []]));
    for (const task of Array.isArray(activeTasks) ? activeTasks : []) {
      byPhase.get(boardPhaseFor(task)).push(task);
    }
    for (const task of Array.isArray(archiveTasks) ? archiveTasks : []) {
      byPhase.get("done").push(task);
    }
    return byPhase;
  }

  function buildTrellisRootLabels(roots) {
    const list = Array.isArray(roots) ? roots.filter((root) => typeof root === "string" && root) : [];
    const labels = new Map();
    const groups = new Map();
    for (const root of list) {
      const segs = trellisRootSegments(root);
      const base = segs.length ? segs[segs.length - 1] : root;
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(root);
    }
    for (const [base, group] of groups) {
      if (group.length === 1) {
        labels.set(group[0], base);
        continue;
      }
      const segsOf = new Map(group.map((root) => [root, trellisRootSegments(root)]));
      // "name (a/b)" takes the `up` segments ending right before the base.
      const candidate = (root, up) => {
        const segs = segsOf.get(root);
        if (up <= 0 || up >= segs.length) return null;
        return `${base} (${segs.slice(segs.length - 1 - up, segs.length - 1).join("/")})`;
      };
      for (const root of group) {
        let label = root; // fallback: roots are deduped, the path is unique
        for (let up = 1; up < segsOf.get(root).length; up++) {
          const text = candidate(root, up);
          if (text && !group.some((other) => other !== root && candidate(other, up) === text)) {
            label = text;
            break;
          }
        }
        labels.set(root, label);
      }
    }
    return labels;
  }

  return {
    aggregateTrellisTasks,
    groupTrellisTasks,
    groupTrellisArchiveByMonth,
    buildTrellisTree,
    trellisArchiveMonthOf,
    trellisTaskOwningRoot,
    filterTrellisTasksByRoot,
    buildTrellisRootLabels,
    boardPhaseFor,
    bucketByBoardPhase,
    TRELLIS_PHASE_BADGE,
    TRELLIS_TREE_DEPTH_CAP,
    normalizeProgress,
  };
});
