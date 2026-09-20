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
const { listArchivedTasks } = require("./trellis-archive");
const {
  sessionPointerKey,
  trellisPlatformFor,
  derivePhase,
  deriveProgress,
} = require("./trellis-phase");

const ACTIVE_POLL_MS = 5000;
const IDLE_POLL_MS = 15000;
const ROOT_SEARCH_MAX_DEPTH = 8;
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
      if (onCelebration) onCelebration(relPath);
    }
    const seen = new Map(); // abs task dir → { relPath, phase }
    for (const resolved of nextResolved.values()) {
      if (!resolved || !resolved.info) continue;
      seen.set(resolved.absDir, { relPath: resolved.info.taskPath, phase: resolved.info.phase });
    }
    for (const [absDir, { relPath, phase }] of seen) {
      const last = phaseHistory.get(absDir);
      phaseHistory.set(absDir, phase);
      if (!last || !phase || last === phase) continue;
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

  // Checklist facts from the task's implement.md, or an empty checklist
  // when the file is absent — same read-only round as task.json/prd.md,
  // no extra polling (the file rides the existing per-round task cache).
  async function readChecklist(absTaskDir) {
    const md = await readTextQuiet(path.join(absTaskDir, "implement.md"));
    return parseImplementChecklist(md);
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
      // Parent link for the Dashboard's task-tree grouping: task.py writes
      // it as a sibling task name (task.json "parent"). Absent/blank stays
      // unset so the legacy TrellisInfo shape is byte-identical.
      if (typeof taskJson.value.parent === "string" && taskJson.value.parent.trim()) {
        info.parent = taskJson.value.parent;
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
  //                           completedAt, archived, checklist } }
  //   { status: "missing" }          — no root / task dir nowhere on disk
  //   { status: "error", message }   — unreadable (corrupt) task.json
  const TASK_DETAIL_PREFIX = ".trellis/tasks/";

  async function readTaskDetail(cwd, taskPath) {
    if (typeof cwd !== "string" || !cwd.trim()) return { status: "missing" };
    if (typeof taskPath !== "string" || !taskPath.startsWith(TASK_DETAIL_PREFIX)) {
      return { status: "missing" };
    }
    // Only a cwd that a live trellis-capable session is actually working in
    // may resolve a root. Panel rows are built from exactly those sessions,
    // so a compromised renderer cannot probe .trellis trees no session ever
    // touched (roots come from sessions, never from the request itself).
    const liveCwds = new Set(collectLiveSessions().map((session) => session.cwd));
    if (!liveCwds.has(cwd)) return { status: "missing" };
    // Split on BOTH separators before validating: on win32 path.join
    // normalizes backslash segments too, so a "/"-only split would let
    // ".trellis/tasks/a\..\..\x" join outside the root.
    const segments = taskPath.slice(TASK_DETAIL_PREFIX.length).split(/[\\/]/);
    // Path containment: the renderer supplies this string, so traversal
    // segments must be rejected before they ever reach path.join.
    if (!segments.length || segments.some((s) => !s || s === "." || s === "..")) {
      return { status: "missing" };
    }
    const root = await findTrellisRoot(cwd);
    if (!root) return { status: "missing" };

    let absDir = path.join(root, "tasks", ...segments);
    let archived = segments[0] === "archive";
    const st = await statQuiet(absDir);
    if (!(st && st.isDirectory())) {
      if (archived) return { status: "missing" };
      // Active dir gone → maybe it was just archived (task.py moves the dir
      // in one commit); the archive copy answers the same detail read.
      const archivedDir = await findArchivedTaskDir(
        path.join(root, "tasks", "archive"),
        segments[segments.length - 1]
      );
      if (!archivedDir) return { status: "missing" };
      absDir = archivedDir;
      archived = true;
    }

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
        createdAt: sanitizeTaskDate(value.createdAt),
        completedAt: sanitizeTaskDate(value.completedAt),
        archived,
        checklist: {
          items: checklist.items,
          done: checklist.done,
          total: checklist.total,
        },
      },
    };
  }

  function sanitizeTaskDate(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  // On-demand read of the most recently archived tasks for the Dashboard's
  // collapsed "Archived" section: same trust model as readTaskDetail — the
  // renderer only supplies cwds of live trellis-capable sessions, each one
  // resolves (and de-duplicates) a .trellis root, and the shared archive
  // traversal (src/trellis-archive.js, also the recap's) does the reading.
  // Never scheduled, never cached: every call is a fresh one-shot scan.
  //
  // Returns { status: "ok", tasks } with at most 20 entries, newest
  // completed first, each entry an IPC/JSON-safe object:
  //   { taskPath, title, createdAt, completedAt, completedAtMs, durationMs, cwd }
  // taskPath is the archive-relative posix path readTaskDetail accepts;
  // cwd is a live session cwd that resolved the same root, so opening the
  // detail card needs no extra trust surface.
  const ARCHIVE_LIST_MAX = 20;
  const ARCHIVE_LIST_MAX_CWDS = 16;

  async function readArchiveList(cwds) {
    if (!Array.isArray(cwds) || cwds.length === 0 || cwds.length > ARCHIVE_LIST_MAX_CWDS) {
      return { status: "ok", tasks: [] };
    }
    // Same live-cwd whitelist as readTaskDetail: roots come from sessions,
    // never from the request itself.
    const liveCwds = new Set(collectLiveSessions().map((session) => session.cwd));
    const rootToCwd = new Map();
    for (const cwd of cwds) {
      if (typeof cwd !== "string" || !cwd.trim()) continue;
      if (!liveCwds.has(cwd)) continue;
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
        createdAt: entry.createdAt,
        completedAt: entry.completedAt,
        completedAtMs: entry.completedAtMs,
        durationMs: Number.isFinite(diff) && diff > 0 ? diff : null,
        cwd,
      };
    });
    return { status: "ok", tasks };
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
    readTaskDetail,
    readArchiveList,
  };
}

module.exports = { createTrellisActivity, ACTIVE_POLL_MS, IDLE_POLL_MS };
