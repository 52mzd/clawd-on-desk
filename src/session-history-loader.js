"use strict";

// Main-process reader for the durable session history store.
//
// hooks/session-history.js owns the on-disk format and stays dependency-free
// so it can run inside a hook. This module adds the two things only the main
// process can know: which sessions are already on screen, and whether Claude
// Code still holds a transcript for a row we are about to offer to resume.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadSessionHistory, normalizeClaudeProfile } = require("../hooks/session-history");
const { normalizeClaudeSessionId } = require("../hooks/claude-session-id");

const DEFAULT_HISTORY_LIMIT = 25;

// Claude Code stores transcripts at
//   ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl
// where the encoding replaces every character outside [A-Za-z0-9-] with "-".
// The mapping is lossy and therefore one-way, which is all a lookup needs.
function encodeClaudeProjectDir(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

function getClaudeProjectsDir(profile, options = {}) {
  const normalizedProfile = normalizeClaudeProfile(profile);
  if (!normalizedProfile) return null;
  if (normalizedProfile.kind === "default") {
    if (typeof options.claudeProjectsDir === "string" && options.claudeProjectsDir) {
      return path.resolve(options.claudeProjectsDir);
    }
    return path.join(os.homedir(), ".claude", "projects");
  }
  return path.join(normalizedProfile.configDir, "projects");
}

/**
 * Does Claude Code still hold a transcript for this row?
 *
 * Deliberately fails open. The directory layout above is Claude Code's private
 * detail, so an unrecognized shape must read as "unknown", never as "gone" —
 * hiding a session the user could actually resume is the worse error. Only a
 * present project directory with the transcript absent is a confident no.
 *
 * When the recorded cwd has no project directory at all, the session is still
 * looked up by id across the other project directories, because that is what
 * `claude --resume <id>` itself does — a worktree or moved checkout keeps a
 * resumable transcript under a different directory. A miss stays "unknown",
 * never "gone": the transcript may live somewhere this scan cannot see.
 *
 * Returns true (present), false (confidently missing), or null (unknown).
 */
function probeTranscript(agentId, sessionId, cwd, profile, options = {}, projectEntriesCache = null) {
  if (agentId !== "claude-code") return null;
  try {
    if (!sessionId || normalizeClaudeSessionId(sessionId) !== sessionId) return null;
  } catch { return null; }
  const dirName = encodeClaudeProjectDir(cwd);
  if (!dirName) return null;
  const projectsDir = getClaudeProjectsDir(profile, options);
  if (!projectsDir) return null;
  const projectDir = path.join(projectsDir, dirName);
  try {
    const stat = fs.lstatSync(projectDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return findTranscriptAcrossProjects(projectsDir, sessionId, projectEntriesCache) ? true : null;
  }
  try {
    const transcript = path.join(projectDir, `${sessionId}.jsonl`);
    const stat = fs.lstatSync(transcript);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
  } catch (err) {
    return err && err.code === "ENOENT" ? false : null;
  }
}

// `projectEntriesCache` lets one loadResumableSessionHistory pass share its
// directory listings instead of re-reading the filesystem per row: the
// projects root's subdirectories once, and each subdirectory's file names
// once, so a full 200-record miss scan costs ~1 readdir per directory rather
// than a lstat per record-directory pair.
function findTranscriptAcrossProjects(projectsDir, sessionId, projectEntriesCache) {
  const cache = projectEntriesCache || new Map();
  let subdirs = cache.get(projectsDir);
  if (subdirs === undefined) {
    try {
      subdirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name);
    } catch {
      subdirs = null;
    }
    cache.set(projectsDir, subdirs);
  }
  if (!subdirs) return false;
  for (const name of subdirs) {
    const dir = path.join(projectsDir, name);
    let fileNames = cache.get(dir);
    if (fileNames === undefined) {
      try {
        fileNames = fs.readdirSync(dir);
      } catch {
        fileNames = null;
      }
      cache.set(dir, fileNames);
    }
    if (!fileNames || !fileNames.includes(`${sessionId}.jsonl`)) continue;
    // The name matches; verify it is a real transcript before claiming it.
    try {
      const stat = fs.lstatSync(path.join(dir, `${sessionId}.jsonl`));
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) return true;
    } catch { /* keep scanning the other project directories */ }
  }
  return false;
}

/**
 * History rows ready for the Dashboard's resume list.
 *
 * Sessions already present in the live snapshot are filtered out: the
 * Dashboard shows those in its own list, and offering "resume" for a
 * conversation that is running would invite a duplicate process.
 *
 * Every stored record is probed, not just the first `limit`: the store keeps
 * up to 200 files and ranks them by recency, so records whose cwd never held
 * a transcript (daemon-born rows, vanished worktrees) must not be able to
 * crowd resumable sessions out of the visible list before the probe runs.
 * Rows split into two groups instead:
 *   - "confirmed": the transcript probe says present. These keep the recency
 *     ranking and fill the visible list up to `limit`.
 *   - "other": probe false, unknown, or a v1 profile that cannot be probed.
 *     Every one of them is still returned, behind the confirmed rows, for the
 *     Dashboard's collapsed group — the probe is a hint, never a gate.
 */
function loadResumableSessionHistory(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_HISTORY_LIMIT;
  const activeRawSessionIds = options.activeRawSessionIds instanceof Set
    ? options.activeRawSessionIds
    : new Set();

  const records = loadSessionHistory({ ...options, limit: undefined });
  const projectEntriesCache = new Map();

  const confirmed = [];
  const other = [];
  for (const record of records) {
    if (activeRawSessionIds.has(record.sessionId)) continue;
    const profileVerified = record.version >= 2 && !!normalizeClaudeProfile(record.profile);
    const transcript = profileVerified
      ? probeTranscript(
        record.agentId, record.sessionId, record.cwd, record.profile, options, projectEntriesCache,
      )
      : null;
    const row = {
      agentId: record.agentId,
      sessionId: record.sessionId,
      historyKey: record.historyKey,
      cwd: record.cwd,
      title: record.title,
      lastState: record.lastState,
      firstSeenAt: record.firstSeenAt,
      lastEventAt: record.lastEventAt,
      endedAt: record.endedAt,
      interrupted: record.interrupted,
      // null means "could not determine" — the row is still offered.
      transcriptPresent: transcript,
      resumeDisabledReason: profileVerified ? null : "profile-unverified",
      group: profileVerified && transcript === true ? "confirmed" : "other",
    };
    (row.group === "confirmed" ? confirmed : other).push(row);
  }
  return [...confirmed.slice(0, limit), ...other];
}

/**
 * Resolve a resume request coming from the Dashboard back to a trusted row.
 *
 * The renderer sends only an agent id and opaque history key. Everything the launcher
 * acts on — above all the working directory — is read back from the store here
 * rather than taken from the message, so a renderer cannot choose the folder a
 * session is relaunched in.
 */
function resolveResumeTarget(agentId, historyKey, options = {}) {
  if (agentId !== "claude-code" || typeof historyKey !== "string"
    || !/^[a-f0-9]{32}$/.test(historyKey)) return null;
  const records = loadSessionHistory({ ...options, limit: undefined });
  const match = records.find(
    (record) => record.agentId === agentId && record.historyKey === historyKey,
  );
  if (!match) return null;
  const profile = match.version >= 2 ? normalizeClaudeProfile(match.profile) : null;
  if (!profile) return null;
  if (!match.cwd || !path.isAbsolute(match.cwd)) return null;
  try {
    const stat = fs.lstatSync(match.cwd);
    if (!stat.isDirectory()) return null;
  } catch {
    return null; // the project folder is gone; resuming there would fail anyway.
  }
  return {
    agentId: match.agentId,
    sessionId: match.sessionId,
    historyKey: match.historyKey,
    cwd: match.cwd,
    profile,
  };
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  encodeClaudeProjectDir,
  getClaudeProjectsDir,
  probeTranscript,
  loadResumableSessionHistory,
  resolveResumeTarget,
};
