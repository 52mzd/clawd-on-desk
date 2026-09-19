"use strict";

// Pure-logic layer for Trellis phase awareness — zero IO, zero spawns.
//
// Mirrors the read-only truth under <project>/.trellis:
//   - .runtime/sessions/<platform>_<sanitized-session-id>.json  session→task pointer
//   - tasks/<task>/task.json                                     status / subtasks
// The key derivation is a faithful Node port of the Python original in
// .trellis/scripts/common/active_task.py (_sanitize_key / _context_key /
// _CONTEXT_KEY_PLATFORM_ALIASES); test/trellis-phase.test.js pins the port
// against real pointer filenames and python3-verified sanitize outputs.

const crypto = require("crypto");

const SANITIZE_MAX_LEN = 160;

// Clawd agentId → trellis runtime pointer-file platform prefix.
// Sources (active_task.py, verified 2026-09-19 — see the task's
// "前置检查结论 D" for the full audit):
//   - _KNOWN_PLATFORMS is the trellis-side platform name set
//   - _ENV_PLATFORM_ALIASES maps vendor names onto it
//     (claude-code → claude, github-copilot → copilot)
//   - _CONTEXT_KEY_PLATFORM_ALIASES renames platforms at pointer-file
//     construction: zcode → claude (ZCode reuses Claude's session env var,
//     so both hosts share one runtime filename)
// Clawd agentIds with no verified trellis platform (antigravity-cli,
// qwen-code, codewhale, mimocode, openclaw, hermes, reasonix, qoderwork,
// qwenwork, workbuddy, traecode, grok-build, deepseek-harness) are
// deliberately absent: trellis never writes pointers under those names, so
// mapping them could only ever miss. Add entries only with a real pointer
// file as evidence, never by analogy.
const PLATFORM_ALIASES = {
  "claude-code": "claude",
  codex: "codex",
  "copilot-cli": "copilot",
  "gemini-cli": "gemini",
  "cursor-agent": "cursor",
  opencode: "opencode",
  qoder: "qoder",
  codebuddy: "codebuddy",
  "kiro-cli": "kiro",
  "kimi-cli": "kimi",
  pi: "pi",
  zcode: "claude",
};

// Port of _sanitize_key: collapse runs of disallowed chars to one "_",
// trim leading/trailing "._-", then cap at 160. Order matters — the cap is
// applied last, so a truncated tail may keep its "_" (Python does the
// same). The original's leading raw.strip() is redundant here: whitespace
// it would remove becomes "_" and is trimmed right after anyway.
function sanitizeKey(raw) {
  if (typeof raw !== "string") return "";
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return safe.slice(0, SANITIZE_MAX_LEN);
}

// Port of _hash_value: first 24 hex chars of sha256(utf8).
function hashValue(raw) {
  return crypto
    .createHash("sha256")
    .update(String(raw), "utf8")
    .digest("hex")
    .slice(0, 24);
}

// Resolve the platform prefix used in .runtime/sessions pointer filenames
// for a Clawd agentId, or null when no verified mapping exists.
function trellisPlatformFor(agentId) {
  if (typeof agentId !== "string") return null;
  return Object.prototype.hasOwnProperty.call(PLATFORM_ALIASES, agentId)
    ? PLATFORM_ALIASES[agentId]
    : null;
}

// Build the pointer-file stem ("<platform>_<sanitized id>") for a Clawd
// session, mirroring _context_key(platform, "session", value).
//
// Several Clawd integrations namespace their session ids as
// "<agentId>:<raw>" (codex:, pi:, qoder:, zcode:, qwenwork:); trellis
// pointer files store the raw id, so that prefix is stripped first — and
// only when it equals the agentId, so Claude-style bare ids are untouched.
// Returns null when the agent has no trellis mapping or the id is blank
// (Python never writes a pointer for a blank id either).
function sessionPointerKey(agentId, sessionId) {
  const platform = trellisPlatformFor(agentId);
  if (!platform || typeof sessionId !== "string" || !sessionId.trim()) return null;
  const rawId = sessionId.startsWith(agentId + ":")
    ? sessionId.slice(agentId.length + 1)
    : sessionId;
  const safe = sanitizeKey(rawId);
  return safe ? `${platform}_${safe}` : `${platform}_${hashValue(rawId)}`;
}

// Derive the HUD phase badge from task.json facts (design D2, in order):
// archived > completed > in_progress > planning; anything else hides the
// badge. hasPrd does not split the badge for v1 — design D2 keeps both
// planning rows on "plan" — but stays in the signature so a future 1.x
// sub-phase ("1.1 PRD") has a stable call site.
function derivePhase({ status, hasPrd, isArchived } = {}) {
  if (isArchived) return "done";
  if (status === "completed") return "finish";
  if (status === "in_progress") return "execute";
  if (status === "planning") return "plan";
  return null;
}

// Count completed subtasks: {done, total} or null. Never invents a 0/0 —
// a task without subtasks (or with an empty list) shows no progress.
function deriveProgress(taskJson) {
  if (!taskJson || typeof taskJson !== "object") return null;
  const subtasks = taskJson.subtasks;
  if (!Array.isArray(subtasks) || subtasks.length === 0) return null;
  let done = 0;
  for (const subtask of subtasks) {
    if (subtask && typeof subtask === "object" && subtask.status === "completed") done += 1;
  }
  return { done, total: subtasks.length };
}

// Next-step guidance for the idle bubble + HUD tooltip. Pure mapping from
// phase → {key, params?} | null; done/unknown stay null (archive is already
// covered by the celebration channel, no nagging hint for it).
function deriveNextStepHint(trellisInfo) {
  if (!trellisInfo || typeof trellisInfo !== "object") return null;
  const phase = trellisInfo.phase;
  if (phase === "plan") return { key: "trellisHintPlan" };
  if (phase === "execute") {
    const progress = trellisInfo.progress;
    const done = Number(progress && progress.done);
    const total = Number(progress && progress.total);
    return {
      key: "trellisHintExecute",
      params: {
        done: Number.isFinite(done) ? Math.max(0, Math.trunc(done)) : 0,
        total: Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0,
      },
    };
  }
  if (phase === "finish") return { key: "trellisHintFinish" };
  return null;
}

module.exports = {
  PLATFORM_ALIASES,
  SANITIZE_MAX_LEN,
  sanitizeKey,
  hashValue,
  trellisPlatformFor,
  sessionPointerKey,
  derivePhase,
  deriveProgress,
  deriveNextStepHint,
};
