"use strict";

// Owner of Trellis phase awareness: bounded read-only polling that binds
// live Clawd sessions onto Trellis tasks, caches TrellisInfo per session,
// detects phase transitions and notifies the host. All disk access is
// strictly read-only (readFile / stat / readdir only — design D7) and
// confined to `<projectRoot>/.trellis/`; this module never writes, spawns,
// or touches the network.
//
// Polling shape (design D3): a self-scheduling setTimeout chain modelled on
// src/claude-settings-watcher.js (scheduleHealthCheck L286-299 /
// runHealthCheck token guard L345-356 / stop-bumps-token L556-578 /
// start L580-615) — never setInterval, because the delay depends on what
// the previous round found:
//   - ≥1 session whose cwd resolves to a .trellis root → next poll in 5s
//   - none (no sessions, or no resolvable root) → next poll in 15s (backoff)
//
// Per-round IO budget (design D3, documented for reviewers):
//   - root lookup: ≤8 stat per unique cwd, memoized per cwd (positives
//     forever — a cwd does not move its .trellis root; negatives for 60s so
//     a freshly `trellis init`-ed project is still picked up)
//   - per session: 1 pointer readFile on exact-key hit; on miss +1 readdir
//     of .runtime/sessions and (only with exactly one same-platform
//     candidate filename) 1 more readFile — the fallback path
//   - per bound task (deduped across sessions via a per-round read cache):
//     1 stat on the task dir, 1 task.json readFile, 1 stat on prd.md and
//     1 implement.md readFile (checklist progress / next-step hint; a
//     missing file is one ENOENT read, never an error); an archived task
//     adds 1 readdir of tasks/archive + ≤ months stats
//   - parallelCount is cached per .trellis root for 30s; a refresh costs
//     1 readdir of tasks/ + 1 small task.json readFile per non-archived
//     task (typically a handful of files)

const path = require("path");
const { parseImplementChecklist, truncateNextStep } = require("./trellis-checklist");
const { compareDocNames } = require("./trellis-doc-renderer");
const { listArchivedTasks, normalizePriority, MONTH_DIR_PATTERN } = require("./trellis-archive");
const { normalizeRootPath } = require("./trellis-roots");
const {
  sessionPointerKey,
  trellisPlatformFor,
  derivePhase,
  deriveProgress,
} = require("./trellis-phase");

const ACTIVE_POLL_MS = 5000;
const IDLE_POLL_MS = 15000;
const ROOT_SEARCH_MAX_DEPTH = 8;
const CHILD_PROJECT_MAX = 32;
const ROOT_NEGATIVE_TTL_MS = 60 * 1000;
const FALLBACK_MAX_AGE_MS = 30 * 60 * 1000;
const CELEBRATION_MIN_INTERVAL_MS = 10 * 1000;
const PARALLEL_COUNT_TTL_MS = 30 * 1000;

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// TrellisInfo shape (design §5), or null when the session has no binding:
//   { taskPath, title, phase, progress: {done,total}|null, parallelCount }
function createTrellisActivity(options) {
  const opts = options || {};
  const state = opts.state || { sessions: new Map() };
  const fs = opts.fs || require("fs").promises;
  // Synchronous fs surface for the shared archive traversal
  // (src/trellis-archive.js): a one-shot on-demand read, injected separately
  // so tests can fake it without touching the async polling fs.
  const syncFs = opts.syncFs || require("fs");
  const nowFn = typeof opts.now === "function" ? opts.now : Date.now;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const onTrellisUpdate = typeof opts.onTrellisUpdate === "function" ? opts.onTrellisUpdate : null;
  const onCelebration = typeof opts.onCelebration === "function" ? opts.onCelebration : null;
  const onPhaseTransition = typeof opts.onPhaseTransition === "function" ? opts.onPhaseTransition : null;
  const onAggregateChange = typeof opts.onAggregateChange === "function" ? opts.onAggregateChange : null;

  let lifecycleToken = 0;
  let pollTimer = null;
  let pollInFlight = false;
  let started = false;

  // sessionId → TrellisInfo | null (null = confirmed "no binding", itself a
  // cached state so a missing pointer does not re-notify every round).
  const sessionCache = new Map();
  // cwd → { root } | { root: null, negativeUntil } — root lookup memo.
  const rootCache = new Map();
  // Absolute task dir → last observed phase. The first observation seeds
  // the baseline and never celebrates — otherwise booting Clawd onto a
  // finished task would cheer out of nowhere.
  const phaseHistory = new Map();
  // Absolute task dir → taskPath (".trellis/tasks/<name>") as last reported
  // by a live pointer. Retained across rounds so an archive-completion
  // celebration (pointer already deleted) can still name the task.
  const taskRelPaths = new Map();
  // Absolute task dir → ms of the last celebration (jitter suppression, D5).
  const lastCelebrationAt = new Map();
  // Absolute .trellis root → { count, activeTasks, computedAt } (per-root
  // summary cache: parallelCount + the Settings active-task digest).
  const parallelCache = new Map();
  // User-registered project roots (Dashboard Trellis view → directory
  // picker), normalized project-root paths — NOT `.trellis` dirs. They join
  // the trust surface of readTaskDetail / readArchiveList / readActiveList
  // so registered projects stay browsable with no live session at all.
  const persistedRoots = new Set();
  // Project aggregates for the pet visual (avatar R3/R3.1): total executing
  // tasks across roots that still have a bound live session, and whether any
  // bound task is in the planning phase. Both are rewritten from the same
  // caches each poll round — pure memory reads, zero extra IO (R4).
  let executingCount = 0;
  let planningActive = false;

  // ── lifecycle ──

  function clearPollTimer() {
    if (pollTimer) {
      clearTimeoutFn(pollTimer);
      pollTimer = null;
    }
  }

  // Self-scheduling setTimeout (never setInterval), token-guarded after
  // the watcher skeleton: stop() bumps the token first, so a timer that
  // already fired but has not run yet compares tokens and becomes a no-op.
  function schedulePoll(delayMs, reason) {
    clearPollTimer();
    const tokenAtSchedule = lifecycleToken;
    pollTimer = setTimeoutFn(() => {
      pollTimer = null;
      if (tokenAtSchedule !== lifecycleToken) return;
      runPoll(reason).catch(() => {});
    }, delayMs);
  }

  function start() {
    if (started) return false;
    started = true;
    lifecycleToken++;
    schedulePoll(0, "startup");
    return true;
  }

  function stop() {
    const wasStarted = started;
    // Bump first: a queued timer callback compares its captured token and
    // turns into a no-op even if it fires before clearPollTimer runs.
    lifecycleToken++;
    clearPollTimer();
    pollInFlight = false;
    started = false;
    sessionCache.clear();
    rootCache.clear();
    phaseHistory.clear();
    taskRelPaths.clear();
    lastCelebrationAt.clear();
    parallelCache.clear();
    executingCount = 0;
    planningActive = false;
    // persistedRoots survives stop(): it mirrors a file the caller owns,
    // not a cache this module owns.
    return wasStarted;
  }

  // Snapshot resolver surface for phase-3 wiring:
  //   (sessionId) => TrellisInfo | null
  function getTrellisInfo(sessionId) {
    const value = sessionCache.get(sessionId);
    return value === undefined ? null : value;
  }

  // R3 thinking-cap gate: true while any bound live session's task is in
  // the planning phase. The cache only holds entries for live sessions, so
  // this cannot go stale beyond one poll round.
  function hasPlanningBinding() {
    for (const info of sessionCache.values()) {
      if (info && info.phase === "plan") return true;
    }
    return false;
  }

  // R3.1 parallel-task juggling input: total executing tasks across roots
  // that still have a bound live session (per-root deduped, so two sessions
  // on one project count that project's tasks once).
  function getExecutingCount() {
    return executingCount;
  }

  function setAggregate(nextExecuting, nextPlanning) {
    if (nextExecuting === executingCount && nextPlanning === planningActive) return;
    executingCount = nextExecuting;
    planningActive = nextPlanning;
    if (onAggregateChange) onAggregateChange({ executingCount, planningActive });
  }

  // Aggregate fanout for rounds with no bound session left: stale bindings
  // must not keep the wizard-hat or the juggling tier alive after the last
  // bound session disappears from the live snapshot.
  function clearStaleBindings() {
    if (sessionCache.size === 0) return;
    sessionCache.clear();
    setAggregate(0, false);
  }

  // ── read-only fs helpers ──

  async function statQuiet(p) {
    try {
      return await fs.stat(p);
    } catch {
      return null;
    }
  }

  async function readdirQuiet(p) {
    try {
      const entries = await fs.readdir(p);
      return Array.isArray(entries) ? entries : null;
    } catch {
      return null;
    }
  }

  // Read a utf-8 text file, or null when unreadable/missing — implement.md
  // is optional per task, so absence is a normal outcome.
  async function readTextQuiet(p) {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return null;
    }
  }

  // Read a JSON object file. { ok, value } | { missing } | { corrupt } —
  // the distinction matters for pointer files: a *missing* exact key may
  // fall back to a single-candidate match, but a *corrupt* one must not
  // (a corrupt pointer falling back could mis-attribute a neighbour
  // session's task to this session).
  async function readJsonObject(p) {
    let raw;
    try {
      raw = await fs.readFile(p, "utf8");
    } catch (err) {
      return err && err.code === "ENOENT" ? { missing: true } : { corrupt: true };
    }
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value)
        ? { ok: true, value }
        : { corrupt: true };
    } catch {
      return { corrupt: true };
    }
  }

  // ── trust surface + known-root collection ──

  // Replace the user-registered root set (main calls this after loading or
  // mutating the roots store). Normalized project roots; a cwd equal to a
  // registered project root (or one that positively resolved a .trellis
  // root earlier in this process) is trusted for the on-demand reads.
  function setPersistedRoots(cwds) {
    persistedRoots.clear();
    for (const cwd of Array.isArray(cwds) ? cwds : []) {
      if (typeof cwd === "string" && cwd.trim()) {
        persistedRoots.add(normalizeRootPath(cwd));
      }
    }
  }

  // Trusted cwd for the on-demand reads (PRD: roots come from "a session
  // resolved it" ∪ "persisted registration"). Live cwds keep the panel's
  // current behavior; a positively-resolved historical cwd keeps archived
  // rows openable after their session ended; persisted roots cover projects
  // no session ever touched.
  function isTrustedTrellisCwd(cwd) {
    if (typeof cwd !== "string" || !cwd.trim()) return false;
    for (const session of collectLiveSessions()) {
      if (session.cwd === cwd) return true;
    }
    if (persistedRoots.has(normalizeRootPath(cwd))) return true;
    const cached = rootCache.get(cwd);
    return Boolean(cached && cached.root);
  }

  // Registered roots first, then cwds that positively resolved a .trellis
  // root this process, capped so a one-shot scan stays bounded.
  const KNOWN_ROOTS_MAX = 32;

  function collectKnownRootCwds() {
    const out = [...persistedRoots];
    for (const [cwd, entry] of rootCache) {
      if (entry && entry.root && !out.includes(cwd)) out.push(cwd);
    }
    return out.slice(0, KNOWN_ROOTS_MAX);
  }

  // A registered project root resolves directly — no upward search, no
  // negative-TTL cache: the user picked this exact directory, and a missing
  // .trellis simply answers empty lists (harmless) until they init one.
  function persistedRootDir(cwd) {
    return path.join(normalizeRootPath(cwd), ".trellis");
  }

  // Upward .trellis search for the add-root flow: returns the project root
  // (parent of the .trellis dir) nearest to `dir`, or null when the picked
  // directory has no .trellis at or above it. Mirrors findTrellisRoot's
  // climb but is never cached — it runs once per explicit user action.
  // Whether `dir` ITSELF contains a .trellis — no upward walk. Used by the
  // explicit root picker where the user's choice is authoritative;
  // resolveProjectRoot's upward search is for session cwds only (picking
  // ~/Downloads/codes used to climb all the way to a stray ~/.trellis in
  // $HOME and register the whole home as a root).
  async function isDirectProjectRoot(dir) {
    if (typeof dir !== "string" || !dir.trim()) return false;
    const st = await statQuiet(path.join(path.normalize(dir), ".trellis"));
    return !!(st && st.isDirectory());
  }

  async function resolveProjectRoot(dir) {
    if (typeof dir !== "string" || !dir.trim()) return null;
    let cur = path.normalize(dir);
    for (let depth = 0; depth < ROOT_SEARCH_MAX_DEPTH; depth++) {
      const candidate = path.join(cur, ".trellis");
      const st = await statQuiet(candidate);
      if (st && st.isDirectory()) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  }

  // Direct children of `dir` that contain a .trellis — used when the user
  // picks a parent folder holding several projects. Shallow by design (one
  // readdir + one stat per child); capped so a giant home directory cannot
  // fan out into hundreds of registrations.
  async function listChildProjectRoots(dir) {
    if (typeof dir !== "string" || !dir.trim()) return [];
    let names;
    try {
      names = await fs.readdir(path.normalize(dir), { withFileTypes: true });
    } catch {
      return [];
    }
    const roots = [];
    for (const entry of names) {
      // withFileTypes gives Dirents in the real fs, but injected test fakes
      // may return plain strings — normalize both before the dot check.
      const name = typeof entry === "string" ? entry : entry && entry.name;
      if (typeof name !== "string" || !name || name.startsWith(".")) continue;
      const isDirEntry = typeof entry === "string" ? true : entry.isDirectory();
      if (!isDirEntry) continue;
      const child = path.join(path.normalize(dir), entry.name);
      const st = await statQuiet(path.join(child, ".trellis"));
      if (st && st.isDirectory()) roots.push(child);
      if (roots.length >= CHILD_PROJECT_MAX) break;
    }
    return roots;
  }

  // ── per-round pipeline ──

  async function runPoll(reason) {
    if (pollInFlight) return;
    pollInFlight = true;
    const tokenAtStart = lifecycleToken;
    let delayMs = IDLE_POLL_MS;
    try {
      const bound = [];
      for (const session of collectLiveSessions()) {
        const root = await findTrellisRoot(session.cwd);
        if (root) bound.push({ session, root });
      }
      if (bound.length) {
        delayMs = ACTIVE_POLL_MS;
        await refreshBindings(bound);
      } else {
        clearStaleBindings();
      }
    } catch (err) {
      // A failed round must never kill the loop: log, retry next round (D6).
      const message = err && err.message ? err.message : String(err);
      console.warn(`Clawd: trellis activity poll failed (${reason}):`, message);
    } finally {
      pollInFlight = false;
      if (tokenAtStart === lifecycleToken) schedulePoll(delayMs, "periodic");
    }
  }

  // Live-session view over the injected state: only non-headless sessions
  // with a cwd and a verified trellis platform mapping can ever bind, so
  // the rest are skipped before any IO happens.
  //
  // Two accepted sources:
  //  - getLiveSessions(): injection used by main.js because the state
  //    factory intentionally does NOT expose the raw sessions Map. It
  //    derives the list from the last session snapshot instead, so no new
  //    surface is added to src/state.js.
  //  - state.sessions: Map<sessionId, entry> (unit tests / direct wiring).
  function collectLiveSessions() {
    let list = [];
    if (typeof opts.getLiveSessions === "function") {
      const injected = opts.getLiveSessions();
      if (Array.isArray(injected)) {
        for (const entry of injected) {
          if (!entry || typeof entry !== "object") continue;
          if (entry.headless) continue;
          if (typeof entry.cwd !== "string" || !entry.cwd.trim()) continue;
          if (!trellisPlatformFor(entry.agentId)) continue;
          const sessionId = typeof entry.id === "string" && entry.id ? entry.id : entry.sessionId;
          if (typeof sessionId !== "string" || !sessionId) continue;
          // Pointer matching needs the RAW session id (e.g. "pi:<uuid>"); the
          // snapshot entry id may be a scoped/encoded id ("s1.<base64>...")
          // which never matches the trellis pointer file name.
          const rawSessionId = typeof entry.rawSessionId === "string" && entry.rawSessionId ? entry.rawSessionId : sessionId;
          list.push({ sessionId, rawSessionId, agentId: entry.agentId, cwd: entry.cwd });
        }
        return list;
      }
    }
    const sessions = state && state.sessions;
    if (!sessions || typeof sessions.entries !== "function") return [];
    for (const [sessionId, entry] of sessions.entries()) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.headless) continue;
      if (typeof entry.cwd !== "string" || !entry.cwd.trim()) continue;
      if (!trellisPlatformFor(entry.agentId)) continue;
      const rawSessionId = typeof entry.rawSessionId === "string" && entry.rawSessionId ? entry.rawSessionId : sessionId;
      list.push({ sessionId, rawSessionId, agentId: entry.agentId, cwd: entry.cwd });
    }
    return list;
  }

  async function findTrellisRoot(cwd) {
    const nowMs = nowFn();
    const cached = rootCache.get(cwd);
    if (cached) {
      if (cached.root) return cached.root;
      if (cached.negativeUntil > nowMs) return null;
    }
    let dir = path.normalize(cwd);
    for (let depth = 0; depth < ROOT_SEARCH_MAX_DEPTH; depth++) {
      const candidate = path.join(dir, ".trellis");
      const st = await statQuiet(candidate);
      if (st && st.isDirectory()) {
        rootCache.set(cwd, { root: candidate });
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    rootCache.set(cwd, { root: null, negativeUntil: nowMs + ROOT_NEGATIVE_TTL_MS });
    return null;
  }

  async function refreshBindings(bound) {
    const taskReads = new Map(); // abs task dir → Promise<taskInfo|null>
    const nextResolved = new Map(); // sessionId → { info, absDir } | null
    for (const { session, root } of bound) {
      nextResolved.set(session.sessionId, await resolveSessionTrellis(session, root, taskReads));
    }

    // Diff against the previous round: only genuinely changed sessions are
    // reported, and a first-round null is not a change (nothing was shown
    // before, so there is nothing to update).
    const changed = [];
    for (const [sessionId, resolved] of nextResolved) {
      const prev = sessionCache.get(sessionId);
      const info = resolved ? resolved.info : null;
      if (!trellisInfoChanged(prev, info)) continue;
      changed.push(sessionId);
    }
    for (const sessionId of [...sessionCache.keys()]) {
      if (!nextResolved.has(sessionId)) sessionCache.delete(sessionId);
    }
    for (const [sessionId, resolved] of nextResolved) {
      sessionCache.set(sessionId, resolved ? resolved.info : null);
    }

    const archived = await detectArchivedTasks(nextResolved);
    recordPhaseTransitions(nextResolved, archived);

    // R3/R3.1 project aggregate: count executing tasks per root that still
    // has a bound session this round (resolveSessionTrellis already warmed
    // parallelCache), then fan out only on change.
    const boundRoots = new Set();
    for (const { session, root } of bound) {
      if (nextResolved.get(session.sessionId)) boundRoots.add(root);
    }
    let nextExecuting = 0;
    for (const root of boundRoots) {
      const summary = parallelCache.get(root);
      if (summary) nextExecuting += summary.count;
    }
    setAggregate(nextExecuting, hasPlanningBinding());

    if (changed.length && onTrellisUpdate) onTrellisUpdate(changed);
  }

  function trellisInfoChanged(prev, next) {
    if (prev === undefined) return next !== null && next !== undefined;
    if (prev === null || next === null) return prev !== next;
    return !trellisInfoEqual(prev, next);
  }

  function trellisInfoEqual(a, b) {
    return (
      a.taskPath === b.taskPath
      && a.title === b.title
      && a.phase === b.phase
      && a.parallelCount === b.parallelCount
      && (a.progress ? a.progress.done : null) === (b.progress ? b.progress.done : null)
      && (a.progress ? a.progress.total : null) === (b.progress ? b.progress.total : null)
      && (a.nextStep || null) === (b.nextStep || null)
      && (a.parent || null) === (b.parent || null)
    );
  }

  // Phase-transition watching (D5): only arrivals at finish/done celebrate;
  // planning → execute is announced by the working animation itself.
  // Archive completion: `task.py archive` moves the task dir and deletes
  // the session pointer in one commit — by the time the next poll round
  // runs, the binding is already gone. Detect "bound last round, gone now,
  // dir lives under archive/" and surface it as an explicit completion so
  // the celebration fires on the real archive event (not just the brief
  // pre-archive status flip, which poll timing may skip entirely).
  // returns [{ archivedDir, relPath }] for entries that completed.
  async function detectArchivedTasks(nextResolved) {
    const liveDirs = new Set();
    for (const resolved of nextResolved.values()) {
      if (!resolved) continue;
      liveDirs.add(resolved.absDir);
      if (resolved.info && resolved.info.taskPath) {
        taskRelPaths.set(resolved.absDir, resolved.info.taskPath);
      }
    }
    const archived = [];
    for (const [dir, relPath] of [...taskRelPaths.entries()]) {
      if (liveDirs.has(dir)) continue;
      // Binding vanished. If the task dir moved into archive/ it completed.
      // archive/ is a sibling: <root>/tasks/<name> → tasks/archive/<month>/<name>.
      taskRelPaths.delete(dir);
      if (!relPath) continue;
      const archiveRoot = path.resolve(dir, "..", "archive");
      const archivedDir = await findArchivedTaskDir(archiveRoot, path.basename(relPath));
      if (!archivedDir) continue;
      phaseHistory.set(archivedDir, "done");
      archived.push({ archivedDir, relPath });
    }
    return archived;
  }

  function recordPhaseTransitions(nextResolved, archived) {
    const nowMs = nowFn();
    for (const { archivedDir, relPath } of archived) {
      if (lastCelebrationAt.has(archivedDir)) continue;
      lastCelebrationAt.set(archivedDir, nowMs);
      // Archive move = arrival at done. The pointer is already deleted, so
      // no title is available here — the bubble falls back to the task path.
      if (onPhaseTransition) onPhaseTransition({ taskPath: relPath, title: null, fromPhase: null, toPhase: "done" });
      if (onCelebration) onCelebration(relPath);
    }
    const seen = new Map(); // abs task dir → { relPath, title, phase }
    for (const resolved of nextResolved.values()) {
      if (!resolved || !resolved.info) continue;
      seen.set(resolved.absDir, {
        relPath: resolved.info.taskPath,
        title: resolved.info.title,
        phase: resolved.info.phase,
      });
    }
    for (const [absDir, { relPath, title, phase }] of seen) {
      const last = phaseHistory.get(absDir);
      phaseHistory.set(absDir, phase);
      if (!last || !phase || last === phase) continue;
      // v3 lifecycle feedback: every genuine transition is surfaced to the
      // host (one-shot phase bubble). The celebration below keeps its
      // narrower finish/done-only remit and its own 10s jitter window.
      if (onPhaseTransition) onPhaseTransition({ taskPath: relPath, title, fromPhase: last, toPhase: phase });
      if (phase !== "finish" && phase !== "done") continue;
      const lastAt = lastCelebrationAt.get(absDir) || 0;
      if (nowMs - lastAt < CELEBRATION_MIN_INTERVAL_MS) continue;
      lastCelebrationAt.set(absDir, nowMs);
      if (onCelebration) onCelebration(relPath);
    }
  }

  async function resolveSessionTrellis(session, root, taskReads) {
    const key = sessionPointerKey(session.agentId, session.rawSessionId || session.sessionId);
    if (!key) return null;
    const platform = trellisPlatformFor(session.agentId);
    const sessionsDir = path.join(root, ".runtime", "sessions");

    let pointer = await readJsonObject(path.join(sessionsDir, `${key}.json`));
    if (pointer.missing) {
      pointer = await matchFallbackPointer(sessionsDir, platform);
    }
    if (!pointer.ok) return null;
    const taskRef = pointer.value.current_task;
    if (typeof taskRef !== "string" || !taskRef.trim()) return null;

    // current_task comes from a file we do not own — resolve it against the
    // project root and require it to stay strictly inside <root>/tasks
    // before anything is read from it.
    const projectRoot = path.dirname(root);
    const absTaskDir = path.resolve(projectRoot, taskRef);
    const tasksRoot = path.join(root, "tasks");
    if (!absTaskDir.startsWith(tasksRoot + path.sep)) return null;

    let taskInfo = taskReads.get(absTaskDir);
    if (!taskInfo) {
      taskInfo = readTaskInfo(root, absTaskDir).catch(() => null);
      taskReads.set(absTaskDir, taskInfo);
    }
    const task = await taskInfo;
    if (!task) return null;

    const parallelCount = (await getRootSummary(root)).count;
    const info = {
      taskPath: toPosix(path.relative(projectRoot, task.dir)),
      title: task.title,
      phase: task.phase,
      progress: task.progress,
      parallelCount,
    };
    if (task.nextStep) info.nextStep = task.nextStep;
    if (task.parent) info.parent = task.parent;
    return {
      info,
      // Transition history is keyed by the pointer's task ref, not by the
      // resolved dir: an archive move relocates the actual dir (task.dir →
      // tasks/archive/<month>/…) while the pointer keeps referencing the
      // old path, and the same logical task must keep one history entry.
      absDir: absTaskDir,
    };
  }

  // Fallback binding (D1 step 4): with the exact pointer file missing, adopt
  // the single remaining pointer of the same platform only when it was seen
  // within 30min. Candidates are matched by filename prefix — the prefix is
  // produced by _context_key with the alias table applied (zcode pointers
  // are named claude_*), while the in-file "platform" field keeps the raw
  // host name, so the filename is the only alias-consistent signal. Zero or
  // several same-platform files means ambiguity → give up (never guess).
  // Transcript-kind files (`<platform>_transcript_<hash>`) are excluded.
  async function matchFallbackPointer(sessionsDir, platform) {
    const entries = await readdirQuiet(sessionsDir);
    if (!entries) return { missing: true };
    const prefix = `${platform}_`;
    const transcriptPrefix = `${platform}_transcript_`;
    const candidates = entries.filter(
      (name) => name.endsWith(".json") && name.startsWith(prefix) && !name.startsWith(transcriptPrefix)
    );
    if (candidates.length !== 1) return { missing: true };
    const pointer = await readJsonObject(path.join(sessionsDir, candidates[0]));
    if (!pointer.ok) return pointer;
    const seenAt = typeof pointer.value.last_seen_at === "string"
      ? Date.parse(pointer.value.last_seen_at)
      : NaN;
    if (!Number.isFinite(seenAt)) return { corrupt: true };
    if (nowFn() - seenAt >= FALLBACK_MAX_AGE_MS) return { missing: true };
    return pointer;
  }

  // Checklist facts from the task's implement.md. PRD-only lightweight
  // tasks (no implement.md, or one without checkboxes) fall back to the
  // prd.md acceptance-criteria checkboxes so progress/next-step still
  // render — same read-only round, and the extra prd read only happens
  // when implement yields nothing (tasks with a real checklist pay zero
  // extra IO).
  async function readChecklist(absTaskDir) {
    const md = await readTextQuiet(path.join(absTaskDir, "implement.md"));
    const parsed = parseImplementChecklist(md);
    if (parsed.total > 0) return parsed;
    const prd = await readTextQuiet(path.join(absTaskDir, "prd.md"));
    const prdParsed = parseImplementChecklist(prd);
    if (prdParsed.total > 0) return prdParsed;
    return parsed;
  }

  async function readTaskInfo(root, absTaskDir) {
    const st = await statQuiet(absTaskDir);
    if (st && st.isDirectory()) {
      const taskJson = await readJsonObject(path.join(absTaskDir, "task.json"));
      if (!taskJson.ok) return null;
      const hasPrd = Boolean(await statQuiet(path.join(absTaskDir, "prd.md")));
      const checklist = await readChecklist(absTaskDir);
      const phase = derivePhase({
        status: taskJson.value.status,
        hasPrd,
        isArchived: false,
        implementChecklist: checklist,
      });
      if (!phase) return null;
      const info = {
        dir: absTaskDir,
        title: pickTitle(taskJson.value, absTaskDir),
        phase,
        progress: deriveProgress(taskJson.value, checklist),
      };
      // Priority badge (v7 R7): normalized to "p0"|"p1"|"p2", attached
      // only when set so the legacy TrellisInfo shape stays byte-identical.
      const priority = normalizePriority(taskJson.value.priority);
      if (priority) info.priority = priority;
      // Parent link for the Dashboard's task-tree grouping: task.py writes
      // it as a sibling task name (task.json "parent"). Absent/blank stays
      // unset so the legacy TrellisInfo shape is byte-identical.
      if (typeof taskJson.value.parent === "string" && taskJson.value.parent.trim()) {
        info.parent = taskJson.value.parent;
      }
      // v4-b network signal: the row-level "links" affordance needs to
      // know whether this task has children. Same never-empty-when-absent
      // contract as parent.
      if (Array.isArray(taskJson.value.children) && taskJson.value.children.length > 0) {
        info.hasChildren = true;
      }
      // Only attach nextStep when there is one, so tasks without a usable
      // checklist keep the exact TrellisInfo shape they had before.
      if (checklist.nextUncheckedText) {
        info.nextStep = truncateNextStep(checklist.nextUncheckedText);
      }
      return info;
    }
    // Task dir gone → maybe archived (tasks/archive/<month>/<name>).
    const archivedDir = await findArchivedTaskDir(path.join(root, "tasks", "archive"), path.basename(absTaskDir));
    if (!archivedDir) return null;
    const taskJson = await readJsonObject(path.join(archivedDir, "task.json"));
    const value = taskJson.ok ? taskJson.value : {};
    return {
      dir: archivedDir,
      title: pickTitle(value, archivedDir),
      phase: "done",
      progress: deriveProgress(value, await readChecklist(archivedDir)),
      priority: normalizePriority(value.priority),
    };
  }

  function pickTitle(taskJson, absTaskDir) {
    const title = taskJson && taskJson.title;
    return typeof title === "string" && title.trim() ? title : path.basename(absTaskDir);
  }

  // archiveRoot is the tasks/archive dir itself. Only exact-name moves count;
  // the target name is what `task.py archive` wrote, so no fuzzy matching.
  async function findArchivedTaskDir(archiveRoot, taskName) {
    const months = await readdirQuiet(archiveRoot);
    if (!months) return null;
    for (const month of months) {
      const candidate = path.join(archiveRoot, month, taskName);
      const st = await statQuiet(candidate);
      if (st && st.isDirectory()) return candidate;
    }
    return null;
  }

  // Per-root summary from the same readdir+read pass that used to feed only
  // parallelCount: activeTasks powers the Settings → Trellis project-row
  // digest (phase 5, getByProject). No extra IO — the list is a by-product
  // of the count scan and rides the same 30s cache entry. An active task's
  // phase needs no hasPrd stat: in_progress → execute and planning → plan
  // unambiguously (derivePhase's other inputs only matter for completed or
  // archived tasks, which are not active). implement.md is deliberately
  // not read here either: the digest is a coarse per-project summary, so
  // an in-progress task stays "execute" rather than doubling this scan's
  // file reads to split out the check sub-phase.
  async function getRootSummary(root) {
    const nowMs = nowFn();
    const cached = parallelCache.get(root);
    if (cached && nowMs - cached.computedAt < PARALLEL_COUNT_TTL_MS) return cached;
    const tasksDir = path.join(root, "tasks");
    const entries = await readdirQuiet(tasksDir);
    let count = 0;
    const activeTasks = [];
    if (entries) {
      for (const entry of entries) {
        if (entry === "archive") continue;
        const taskJson = await readJsonObject(path.join(tasksDir, entry, "task.json"));
        if (!taskJson.ok) continue;
        const status = taskJson.value.status;
        if (status !== "in_progress" && status !== "planning") continue;
        if (status === "in_progress") count += 1;
        const phase = derivePhase({ status });
        if (phase) activeTasks.push({ title: pickTitle(taskJson.value, path.join(tasksDir, entry)), phase });
      }
    }
    const summary = { count, activeTasks, computedAt: nowMs };
    parallelCache.set(root, summary);
    return summary;
  }

  // On-demand single read for the Dashboard task-detail card: resolves the
  // .trellis root from the bound session's cwd (reusing the polling root
  // cache), then reads task.json / prd.md / implement.md of that one task —
  // active or archived. Never scheduled, never cached: every call is a fresh
  // read, and it touches none of the snapshot caches, so opening a detail
  // cannot jitter phase badges or celebrations.
  //
  // taskPath is the snapshot-relative posix path (".trellis/tasks/<name>"
  // for a live task, ".trellis/tasks/archive/<month>/<name>" for one that
  // already moved). Results:
  //   { status: "ok", task: { title, phase, rawStatus, createdAt,
  //                           completedAt, archived, checklist, docs } }
  //   { status: "missing" }          — no root / task dir nowhere on disk
  //   { status: "error", message }   — unreadable (corrupt) task.json
  // docs lists the task dir's *.md files (name + byte size) so the card can
  // offer one tab per document; contents are read separately, one doc at a
  // time, by readTaskDoc.
  const TASK_DETAIL_PREFIX = ".trellis/tasks/";

  // Shared path resolution for the on-demand detail/doc reads: validates
  // the trusted cwd + the renderer-supplied taskPath (prefix + per-segment
  // containment on BOTH separators), then resolves the task dir with the
  // active→archive fallback. Returns { absDir, archived } or null.
  async function resolveTaskDir(cwd, taskPath) {
    if (typeof cwd !== "string" || !cwd.trim()) return null;
    if (typeof taskPath !== "string" || !taskPath.startsWith(TASK_DETAIL_PREFIX)) {
      return null;
    }
    // Only a cwd a live trellis-capable session is working in, one that
    // resolved a .trellis root earlier in this process, or a registered
    // project root may resolve a root. Rows are built from exactly those
    // sources, so a compromised renderer cannot probe .trellis trees no
    // session ever touched and no user ever registered.
    if (!isTrustedTrellisCwd(cwd)) return null;
    // Split on BOTH separators before validating: on win32 path.join
    // normalizes backslash segments too, so a "/"-only split would let
    // ".trellis/tasks/a\..\..\x" join outside the root.
    const segments = taskPath.slice(TASK_DETAIL_PREFIX.length).split(/[\\/]/);
    // Path containment: the renderer supplies this string, so traversal
    // segments must be rejected before they ever reach path.join.
    if (!segments.length || segments.some((s) => !s || s === "." || s === "..")) {
      return null;
    }
    const root = await findTrellisRoot(cwd);
    if (!root) return null;

    let absDir = path.join(root, "tasks", ...segments);
    let archived = segments[0] === "archive";
    const st = await statQuiet(absDir);
    if (!(st && st.isDirectory())) {
      if (archived) return null;
      // Active dir gone → maybe it was just archived (task.py moves the dir
      // in one commit); the archive copy answers the same reads.
      const archivedDir = await findArchivedTaskDir(
        path.join(root, "tasks", "archive"),
        segments[segments.length - 1]
      );
      if (!archivedDir) return null;
      absDir = archivedDir;
      archived = true;
    }
    return { absDir, archived };
  }

  async function readTaskDetail(cwd, taskPath) {
    const resolved = await resolveTaskDir(cwd, taskPath);
    if (!resolved) return { status: "missing" };
    const { absDir, archived } = resolved;

    const taskJson = await readJsonObject(path.join(absDir, "task.json"));
    // A corrupt task.json cannot answer any of the card's fields — surface
    // a retryable error instead of half-empty data.
    if (!taskJson.ok) return { status: "error", message: "unreadable-task-json" };
    const value = taskJson.value;
    const hasPrd = Boolean(await statQuiet(path.join(absDir, "prd.md")));
    const checklist = await readChecklist(absDir);
    return {
      status: "ok",
      task: {
        title: pickTitle(value, absDir),
        phase: derivePhase({
          status: value.status,
          hasPrd,
          isArchived: archived,
          implementChecklist: checklist,
        }),
        rawStatus: typeof value.status === "string" ? value.status : null,
        priority: normalizePriority(value.priority),
        createdAt: sanitizeTaskDate(value.createdAt),
        completedAt: sanitizeTaskDate(value.completedAt),
        archived,
        checklist: {
          items: checklist.items,
          done: checklist.done,
          total: checklist.total,
        },
        docs: await listTaskDocs(absDir),
      },
    };
  }

  function sanitizeTaskDate(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  // The task dir's markdown documents for the detail card's doc tabs:
  // every regular *.md file, canonical Trellis names first (prd → design →
  // implement), everything else alphabetically. sizes are byte lengths of
  // the utf-8 contents (fake fs stats carry no size field, so the read
  // itself is the source of truth — one small read per file, only on the
  // on-demand detail path).
  async function listTaskDocs(absDir) {
    const entries = await readdirQuiet(absDir);
    if (!entries) return [];
    const docs = [];
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const st = await statQuiet(path.join(absDir, name));
      if (!(st && !st.isDirectory())) continue;
      const content = await readTextQuiet(path.join(absDir, name));
      if (content === null) continue;
      docs.push({ name, size: Buffer.byteLength(content, "utf8") });
    }
    docs.sort((a, b) => compareDocNames(a.name, b.name));
    return docs;
  }

  // Single-document read for the detail card's doc tabs. Same trust surface
  // and same taskPath containment as readTaskDetail (resolveTaskDir); the
  // `doc` argument must additionally be a plain *.md basename that is a
  // member of the directory's freshly listed file set — never a path, never
  // a name that was not listed. Content is capped at TASK_DOC_MAX_BYTES
  // (beyond that it is byte-truncated and flagged, so a runaway document
  // cannot drag the whole card down). Document contents are ephemeral:
  // they ride the IPC reply only — never prefs, never logs, never disk.
  //   { status: "ok", name, size, truncated, content }
  //   { status: "missing" }        — bad doc name / not listed / unreadable
  const TASK_DOC_MAX_BYTES = 1024 * 1024;

  async function readTaskDoc(cwd, taskPath, doc) {
    const resolved = await resolveTaskDir(cwd, taskPath);
    if (!resolved) return { status: "missing" };
    if (
      typeof doc !== "string"
      || !doc.endsWith(".md")
      || !doc.slice(0, -3)
      || doc.includes("/")
      || doc.includes("\\")
      || doc === "."
      || doc === ".."
    ) {
      return { status: "missing" };
    }
    // Whitelist membership: only a name the directory itself just listed
    // may be read — the renderer cannot name a file that is not there.
    const entries = await readdirQuiet(resolved.absDir);
    if (!entries || !entries.includes(doc)) return { status: "missing" };
    const st = await statQuiet(path.join(resolved.absDir, doc));
    if (!(st && !st.isDirectory())) return { status: "missing" };

    const content = await readTextQuiet(path.join(resolved.absDir, doc));
    if (content === null) return { status: "missing" };
    const size = Buffer.byteLength(content, "utf8");
    if (size <= TASK_DOC_MAX_BYTES) {
      return { status: "ok", name: doc, size, truncated: false, content };
    }
    const truncatedContent = Buffer.from(content, "utf8")
      .subarray(0, TASK_DOC_MAX_BYTES)
      .toString("utf8");
    return {
      status: "ok",
      name: doc,
      size,
      truncated: true,
      content: truncatedContent,
    };
  }

  // v4-a spec map: bounded listing of <root>/.trellis/spec/**/*.md for the
  // Dashboard's Trellis view. Same trust gate as every other on-demand
  // read (registered root / live cwd / positively resolved this process),
  // same quiet-IO helpers. Depth is counted relative to spec/ and hard-
  // capped so a pathological tree cannot stall the round-trip.
  const SPEC_TREE_MAX_DEPTH = 3;
  const SPEC_TREE_MAX_FILES = 200;
  // v7 R6: the spec map also reports whether each doc has a body and how
  // many task documents reference it. Both passes are bounded — the whole
  // task tree is walked at most SPEC_REF_MAX_FILES times for at most
  // SPEC_REF_MAX_BYTES of text, so a huge repo cannot stall the round-trip.
  const SPEC_REF_MAX_FILES = 400;
  const SPEC_REF_MAX_BYTES = 2 * 1024 * 1024;
  const SPEC_REF_DOC_NAMES = ["prd.md", "design.md", "implement.md", "implement.jsonl", "check.jsonl"];

  // A doc counts as "filled" once it carries at least SPEC_FILL_MIN_LINES
  // body lines — blank lines, headings and `//` comments do not count. The
  // placeholder specs written by `trellis init` are all headings, so they
  // read as 待填 instead of as content (PRD R6).
  const SPEC_FILL_MIN_LINES = 5;

  function countSpecBodyLines(text) {
    let n = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) n += 1;
    }
    return n;
  }

  // Reference count for the spec map (v7 R6): a spec doc is referenced when
  // a task document mentions its repo-relative path, or its bare file name
  // when that name is unambiguous within the spec tree (a shared name like
  // index.md would otherwise collect false positives).
  async function countSpecRefs(root, relPaths) {
    const counts = new Map();
    if (relPaths.length === 0) return counts;
    const nameCounts = new Map();
    for (const relPath of relPaths) {
      const bare = relPath.slice(relPath.lastIndexOf("/") + 1);
      nameCounts.set(bare, (nameCounts.get(bare) || 0) + 1);
    }
    const needles = relPaths.map((relPath) => {
      const bare = relPath.slice(relPath.lastIndexOf("/") + 1);
      return {
        relPath,
        full: `.trellis/spec/${relPath}`,
        bare: nameCounts.get(bare) === 1 ? bare : null,
      };
    });
    const tasksDir = path.join(root, ".trellis", "tasks");
    const queue = [{ rel: "", depth: 0 }];
    let scanned = 0;
    let bytes = 0;
    while (queue.length > 0 && scanned < SPEC_REF_MAX_FILES && bytes < SPEC_REF_MAX_BYTES) {
      const { rel, depth } = queue.shift();
      if (depth > 4) continue;
      const dir = rel ? path.join(tasksDir, rel) : tasksDir;
      const entries = await readdirQuiet(dir);
      if (!entries) continue;
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        if (SPEC_REF_DOC_NAMES.includes(name)) {
          const text = await readTextQuiet(path.join(dir, name));
          if (text === null) continue;
          scanned += 1;
          bytes += text.length;
          for (const needle of needles) {
            if (text.includes(needle.full) || (needle.bare && text.includes(needle.bare))) {
              counts.set(needle.relPath, (counts.get(needle.relPath) || 0) + 1);
            }
          }
          continue;
        }
        if (depth < 4) queue.push({ rel: rel ? `${rel}/${name}` : name, depth: depth + 1 });
      }
    }
    return counts;
  }

  function resolveTrustedSpecDir(root) {
    if (typeof root !== "string" || !root.trim()) return null;
    if (!isTrustedTrellisCwd(root)) return null;
    const specDir = path.join(root, ".trellis", "spec");
    const normalizedRoot = normalizeRootPath(root);
    return { specDir, normalizedRoot };
  }

  async function readSpecTree(root) {
    const resolved = resolveTrustedSpecDir(root);
    if (!resolved) return { status: "missing" };
    const files = [];
    // Iterative walk, one directory queue entry at a time; file order is
    // directory order (stable per platform), not sorted here.
    const queue = [{ rel: "", depth: 0 }];
    while (queue.length > 0 && files.length < SPEC_TREE_MAX_FILES) {
      const { rel, depth } = queue.shift();
      if (depth > SPEC_TREE_MAX_DEPTH) continue;
      const entries = await readdirQuiet(path.join(resolved.specDir, rel));
      if (!entries) continue;
      for (const name of entries) {
        if (files.length >= SPEC_TREE_MAX_FILES) break;
        if (name.startsWith(".")) continue;
        const childRel = rel ? `${rel}/${name}` : name;
        if (name.endsWith(".md")) {
          const group = rel ? rel.split("/")[0] : "spec";
          files.push({ relPath: childRel, group });
          continue;
        }        // Descend only into plain-named directories below the cap.
        if (depth < SPEC_TREE_MAX_DEPTH) {
          queue.push({ rel: childRel, depth: depth + 1 });
        }
      }
    }
    // v7 R6: fill status + reference count. A doc that vanished between the
    // listing and this read keeps filled=null so the UI can say "unknown"
    // rather than claiming it is empty.
    for (const file of files) {
      const text = await readTextQuiet(path.join(resolved.specDir, ...file.relPath.split("/")));
      if (text === null) {
        file.filled = null;
        file.lines = null;
        continue;
      }
      const lines = countSpecBodyLines(text);
      file.lines = lines;
      file.filled = lines >= SPEC_FILL_MIN_LINES;
    }
    const refs = await countSpecRefs(resolved.normalizedRoot, files.map((file) => file.relPath));
    for (const file of files) file.refCount = refs.get(file.relPath) || 0;
    return { status: "ok", files, truncated: files.length >= SPEC_TREE_MAX_FILES };
  }

  // Read one spec document. The renderer-supplied relPath is validated by
  // segment shape AND by whitelist membership against what the parent
  // directories themselves list (the readTaskDoc philosophy: a file can
  // only be read if the directory just said it exists) — traversal never
  // reaches path.join.
  async function readSpecDoc(root, relPath) {
    const resolved = resolveTrustedSpecDir(root);
    if (!resolved) return { status: "missing" };
    if (
      typeof relPath !== "string"
      || !relPath.endsWith(".md")
      || relPath.includes("\\")
      || relPath === ".md"
    ) {
      return { status: "missing" };
    }
    const segments = relPath.split("/");
    if (segments.length > SPEC_TREE_MAX_DEPTH + 1) return { status: "missing" };
    for (const seg of segments) {
      if (!seg || seg === "." || seg === "..") return { status: "missing" };
    }
    // Layer-by-layer whitelist: every directory segment must appear in the
    // listing of its parent before we descend into it.
    let absDir = resolved.specDir;
    for (let i = 0; i < segments.length - 1; i++) {
      const entries = await readdirQuiet(absDir);
      if (!entries || !entries.includes(segments[i])) return { status: "missing" };
      absDir = path.join(absDir, segments[i]);
    }
    const fileName = segments[segments.length - 1];
    const dirEntries = await readdirQuiet(absDir);
    if (!dirEntries || !dirEntries.includes(fileName)) return { status: "missing" };
    const st = await statQuiet(path.join(absDir, fileName));
    if (!(st && !st.isDirectory())) return { status: "missing" };

    const content = await readTextQuiet(path.join(absDir, fileName));
    if (content === null) return { status: "missing" };
    const size = Buffer.byteLength(content, "utf8");
    if (size <= TASK_DOC_MAX_BYTES) {
      return { status: "ok", relPath, size, truncated: false, content };
    }
    const truncatedContent = Buffer.from(content, "utf8")
      .subarray(0, TASK_DOC_MAX_BYTES)
      .toString("utf8");
    return { status: "ok", relPath, size, truncated: true, content: truncatedContent };
  }

  // v4-b task network: one-shot on-demand read of ONE task's structured
  // linkage — parent / children from task.json — resolved against the same
  // trusted-task-dir gate as the detail read. Refs carry a taskPath the
  // detail channel accepts (snapshot-relative posix), a display title, and
  // an archived flag; unknown ids degrade to {missing} rows instead of
  // failing the whole payload. Evidence source is task.json only.
  const NETWORK_SIBLING_MAX = 200; // R2 horizontal-edge sibling scan cap
  const NETWORK_REF_MAX = 20;

  function taskRefPathFromAbs(absTaskDir) {
    const marker = `${path.sep}.trellis${path.sep}`;
    const idx = absTaskDir.lastIndexOf(marker);
    if (idx === -1) return null;
    // Keep the leading ".trellis/" — the detail channel's taskPath prefix.
    return absTaskDir.slice(idx + 1).split(path.sep).join("/");
  }

  // ── v7 R8 project-wide network overview ───────────
  // One bounded read-only pass over every task in a root (active two levels
  // + archive/<month>/<name>) producing the whole-relation graph the
  // project panel renders: nodes + vertical parent edges + the same
  // shared-spec/shared-PRD horizontal groups as the single-task network.
  // Caps: ≤NETWORK_SIBLING_MAX task dirs, ≤SPEC_REF_MAX_BYTES doc text.
  async function readTaskNetworkOverview(root) {
    const specResolved = resolveTrustedSpecDir(root);
    if (!specResolved) return { status: "missing" };
    const tasksDir = path.join(specResolved.normalizedRoot, ".trellis", "tasks");
    const dirEntries = await readdirQuiet(tasksDir);
    if (!dirEntries) return { status: "missing" };

    const nodes = [];
    const nodeByTaskPath = new Map();
    const pendingParent = []; // {taskPath, parentName}
    const docTexts = [];      // {taskPath, text}
    let truncated = false;

    const visit = async (dir, taskPath, archived) => {
      if (nodes.length >= NETWORK_SIBLING_MAX) { truncated = true; return; }
      const taskJson = await readJsonObject(path.join(dir, "task.json"));
      if (!taskJson) return;
      const value = taskJson.value || {};
      const node = {
        taskPath,
        title: (typeof value.title === "string" && value.title) || taskPath,
        archived,
        priority: normalizePriority(value.priority),
      };
      nodes.push(node);
      nodeByTaskPath.set(taskPath, node);
      const parentName = typeof value.parent === "string" ? value.parent.trim() : "";
      if (parentName) pendingParent.push({ taskPath, parentName });
      let text = "";
      for (const name of (await readdirQuiet(dir)) || []) {
        if (!SPEC_REF_DOC_NAMES.includes(name)) continue;
        const chunk = await readTextQuiet(path.join(dir, name));
        if (chunk) text += `\n${chunk}`;
      }
      if (text) docTexts.push({ taskPath, text });
    };

    for (const name of dirEntries) {
      if (name.startsWith(".") || MONTH_DIR_PATTERN.test(name)) continue;
      await visit(path.join(tasksDir, name), `.trellis/tasks/${name}`, false);
    }
    const archiveDir = path.join(tasksDir, "archive");
    for (const month of (await readdirQuiet(archiveDir)) || []) {
      if (!MONTH_DIR_PATTERN.test(month)) continue;
      for (const name of (await readdirQuiet(path.join(archiveDir, month))) || []) {
        if (name.startsWith(".")) continue;
        await visit(path.join(archiveDir, month, name), `.trellis/tasks/archive/${month}/${name}`, true);
      }
    }

    // Vertical edges resolved with the full node set (sibling join first,
    // unique basename fallback — same rule as groupTrellisTasks).
    const byBasename = new Map();
    for (const node of nodes) {
      const base = node.taskPath.slice(node.taskPath.lastIndexOf("/") + 1);
      if (!byBasename.has(base)) byBasename.set(base, []);
      byBasename.get(base).push(node.taskPath);
    }
    const edges = [];
    for (const { taskPath, parentName } of pendingParent) {
      const slash = taskPath.lastIndexOf("/");
      const siblingPath = `${taskPath.slice(0, slash)}/${parentName}`;
      let parentTaskPath = null;
      if (nodeByTaskPath.has(siblingPath)) {
        parentTaskPath = siblingPath;
      } else {
        const candidates = byBasename.get(parentName) || [];
        if (candidates.length === 1) [parentTaskPath] = candidates;
      }
      edges.push({
        parentTaskPath,
        childTaskPath: taskPath,
        parentMissing: parentTaskPath === null,
      });
    }

    // Horizontal edges: same needles as the single-task scan, grouped
    // across the whole root. Spec groups need ≥2 distinct citers.
    const ref = (taskPath) => {
      const node = nodeByTaskPath.get(taskPath);
      return {
        taskPath,
        title: node ? node.title : taskPath,
        archived: node ? node.archived : taskPath.includes("/archive/"),
        ...(node ? {} : { missing: true }),
      };
    };
    const specHits = new Map();
    const prdHits = new Map();
    let bytes = 0;
    for (const { taskPath, text } of docTexts) {
      bytes += text.length;
      if (bytes > SPEC_REF_MAX_BYTES) { truncated = true; break; }
      for (const m of text.matchAll(/\.trellis\/spec\/([^\s"'`<>)]+?\.md)/g)) {
        if (!specHits.has(m[1])) specHits.set(m[1], []);
        specHits.get(m[1]).push(taskPath);
      }
      for (const m of text.matchAll(/\.trellis\/tasks\/archive\/(\d{4}-\d{2})\/([^\s"'`<>)\/]+)\/prd\.md/g)) {
        const target = `.trellis/tasks/archive/${m[1]}/${m[2]}`;
        if (target !== taskPath) {
          if (!prdHits.has(target)) prdHits.set(target, []);
          prdHits.get(target).push(taskPath);
        }
      }
      for (const m of text.matchAll(/\.trellis\/tasks\/([^\s"'`<>)\/]+)\/prd\.md/g)) {
        const target = `.trellis/tasks/${m[1]}`;
        if (target !== taskPath) {
          if (!prdHits.has(target)) prdHits.set(target, []);
          prdHits.get(target).push(taskPath);
        }
      }
    }
    const specGroups = [];
    for (const relPath of [...specHits.keys()].sort()) {
      const citers = [...new Set(specHits.get(relPath))];
      if (citers.length < 2) continue;
      specGroups.push({
        specPath: relPath,
        tasks: citers.slice(0, NETWORK_REF_MAX).map(ref),
        truncated: citers.length > NETWORK_REF_MAX,
      });
    }
    const prdGroups = [];
    for (const target of [...prdHits.keys()].sort()) {
      const citers = [...new Set(prdHits.get(target))];
      if (citers.length === 0) continue;
      prdGroups.push({
        prdPath: target,
        owner: ref(target),
        tasks: citers.slice(0, NETWORK_REF_MAX).map(ref),
        truncated: citers.length > NETWORK_REF_MAX,
      });
    }

    return { status: "ok", nodes, edges, specGroups, prdGroups, truncated };
  }


  // On-demand read of the most recently archived tasks for the Dashboard's
  // independent Trellis view. The data source is the known-root set
  // (registered roots + cwds that positively resolved a .trellis root this
  // process), so browsing works with no live session at all. Never
  // scheduled, never cached: every call is a fresh one-shot scan.
  //
  // Returns { status: "ok", tasks } newest completed first (capped for the
  // month-grouped browser view), each entry an IPC/JSON-safe object:
  //   { taskPath, title, parent, createdAt, completedAt, completedAtMs, durationMs, cwd }
  // taskPath is the full snapshot-relative posix path readTaskDetail accepts
  // (".trellis/tasks/archive/<month>/<name>") — the "/archive/" segment is
  // what the dashboard's month grouping keys on; parent is the task.json parent task NAME (or null) for the archive
  // tree's by-name cross-month matching; cwd is a trusted cwd (registered
  // root or session-resolved cwd) that resolved the same root, so opening
  // the detail card needs no extra trust surface.
  const ARCHIVE_LIST_MAX = 200;

  async function readArchiveList() {
    const rootToCwd = new Map();
    for (const cwd of collectKnownRootCwds()) {
      if (persistedRoots.has(normalizeRootPath(cwd))) {
        const root = persistedRootDir(cwd);
        if (!rootToCwd.has(root)) rootToCwd.set(root, cwd);
        continue;
      }
      const root = await findTrellisRoot(cwd);
      if (root && !rootToCwd.has(root)) rootToCwd.set(root, cwd);
    }

    const merged = [];
    for (const [root, cwd] of rootToCwd) {
      for (const entry of listArchivedTasks(syncFs, path.join(root, "tasks", "archive"))) {
        merged.push({ entry, cwd });
      }
    }
    merged.sort((a, b) => {
      const am = a.entry.completedAtMs;
      const bm = b.entry.completedAtMs;
      if (am === null && bm === null) return 0;
      if (am === null) return 1;
      if (bm === null) return -1;
      return bm - am;
    });

    const tasks = merged.slice(0, ARCHIVE_LIST_MAX).map(({ entry, cwd }) => {
      const createdAtMs = entry.createdAt !== null ? Date.parse(entry.createdAt) : NaN;
      const diff = entry.completedAtMs !== null && Number.isFinite(createdAtMs)
        ? entry.completedAtMs - createdAtMs
        : NaN;
      return {
        taskPath: `.trellis/tasks/archive/${entry.month}/${entry.name}`,
        title: entry.title || entry.name,
        parent: entry.parent,
        hasChildren: entry.hasChildren === true,
        priority: entry.priority,
        createdAt: entry.createdAt,
        completedAt: entry.completedAt,
        completedAtMs: entry.completedAtMs,
        durationMs: Number.isFinite(diff) && diff > 0 ? diff : null,
        cwd,
      };
    });
    return { status: "ok", tasks };
  }

  // On-demand read of the non-archived tasks under every known root for
  // the Dashboard's independent Trellis view: a project-centric list that
  // (unlike the session panel) includes tasks no live session is bound to.
  // Same trust model as readArchiveList — the root set comes from this
  // module, never from the request. One shot per call, never cached.
  //
  // Returns { status: "ok", tasks }, each entry IPC/JSON-safe:
  //   { taskPath, title, phase, progress: {done,total}|null, parent: string|null,
  //     hasChildren: boolean, priority: "p0"|"p1"|"p2"|null, cwd }
  // taskPath is the snapshot-relative posix path readTaskDetail accepts;
  // cwd is the trusted cwd that owns the task's root.
  const ACTIVE_LIST_MAX = 200;

  async function readActiveList() {
    const tasks = [];
    // One cwd per root: a registered project root and a session cwd deep
    // inside it both resolve the same root — without this guard each task
    // would be listed once per source (readArchiveList's rootToCwd twin).
    const seenRoots = new Set();
    for (const cwd of collectKnownRootCwds()) {
      const isPersisted = persistedRoots.has(normalizeRootPath(cwd));
      const root = isPersisted ? persistedRootDir(cwd) : await findTrellisRoot(cwd);
      if (!root) continue;
      if (seenRoots.has(root)) continue;
      seenRoots.add(root);
      const projectRoot = path.dirname(root);
      const entries = await readdirQuiet(path.join(root, "tasks"));
      if (!entries) continue;
      for (const entry of entries) {
        if (entry === "archive") continue;
        const info = await readTaskInfo(root, path.join(root, "tasks", entry));
        if (!info) continue;
        const task = {
          taskPath: toPosix(path.relative(projectRoot, info.dir)),
          title: info.title,
          phase: info.phase,
          progress: info.progress,
          parent: typeof info.parent === "string" ? info.parent : null,
          hasChildren: info.hasChildren === true,
          priority: info.priority || null,
          cwd,
        };
        if (info.nextStep) task.nextStep = info.nextStep;
        tasks.push(task);
      }
      if (tasks.length >= ACTIVE_LIST_MAX) break;
    }
    return { status: "ok", tasks: tasks.slice(0, ACTIVE_LIST_MAX) };
  }

  // Roots whose .trellis directory was resolved from a live session cwd
  // during this process. Positive lookups are cached forever (a cwd does not
  // move its .trellis root), so a project worked on earlier today still
  // feeds the recap Trellis section after its sessions ended. stop() clears
  // the cache together with everything else.
  function getKnownRoots() {
    const roots = new Set();
    for (const entry of rootCache.values()) {
      if (entry && entry.root) roots.add(entry.root);
    }
    return [...roots];
  }

  // Phase-5 read for the Settings → Trellis tab: active (planning /
  // in_progress) task digests of one project, served from the polling cache
  // only — a pure memory lookup, never a fresh disk scan. null when the root
  // has not been polled (no bound session yet) or nothing is active.
  function getByProject(projectPath) {
    if (typeof projectPath !== "string" || !projectPath.trim()) return null;
    const root = path.join(path.normalize(projectPath), ".trellis");
    const cached = parallelCache.get(root);
    if (!cached || !Array.isArray(cached.activeTasks) || cached.activeTasks.length === 0) return null;
    return cached.activeTasks.map((task) => ({ title: task.title, phase: task.phase }));
  }

  return {
    start,
    stop,
    getTrellisInfo,
    getByProject,
    getKnownRoots,
    getExecutingCount,
    hasPlanningBinding,
    setPersistedRoots,
    resolveProjectRoot,
    isDirectProjectRoot,
    listChildProjectRoots,
    readTaskDetail,
    readTaskDoc,
    readSpecTree,
    readSpecDoc,
    readTaskNetworkOverview,
    readArchiveList,
    readActiveList,
  };
}

module.exports = { createTrellisActivity, ACTIVE_POLL_MS, IDLE_POLL_MS };
