"use strict";

// Pure implement.md checklist parser — zero IO, zero spawns.
//
// task.py never syncs task.json subtasks back from the checkboxes agents
// actually tick, so implement.md is the de-facto progress truth for tasks
// that carry one. This parser turns its markdown checkboxes into the same
// {done,total} shape deriveProgress already consumes, plus the first
// unchecked item's text for the idle-bubble next-step hint. Output lives in
// memory only (ephemeral rendering) — nothing here is persisted anywhere.

const CHECKLIST_LINE_RE = /^(\s*)- \[([ xX])\]\s*(.*)$/;
const NEXT_STEP_MAX_LEN = 40;

// First-line text with markdown emphasis (**bold**, `code`) stripped.
// Inline links/images are intentionally left alone: they are rare in
// checklist items and stripping them safely needs a real markdown parser.
function stripEmphasis(text) {
  return String(text)
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

// Parse `- [ ]` / `- [x]` checkboxes (leading indentation allowed) into
// { items: [{text, checked}], done, total, nextUncheckedText }. An empty
// or checkbox-less document is a normal outcome, never an exception.
function parseImplementChecklist(mdText) {
  if (typeof mdText !== "string" || !mdText) {
    return { items: [], done: 0, total: 0, nextUncheckedText: null };
  }
  const items = [];
  for (const line of mdText.split(/\r?\n/)) {
    const match = CHECKLIST_LINE_RE.exec(line);
    if (!match) continue;
    const text = stripEmphasis(match[3]);
    // A checkbox with no visible text cannot be shown as a next step and
    // would poison the done/total counts with noise — skip it.
    if (!text) continue;
    items.push({ text, checked: match[2] !== " " });
  }
  let done = 0;
  let nextUncheckedText = null;
  for (const item of items) {
    if (item.checked) done += 1;
    else if (nextUncheckedText === null) nextUncheckedText = item.text;
  }
  return { items, done, total: items.length, nextUncheckedText };
}

// Clamp a next-step text for the one-line bubble: hard cap at 40 chars
// (Unicode code points via Array.from) with an ellipsis when truncated.
function truncateNextStep(text) {
  const chars = Array.from(String(text || ""));
  if (chars.length <= NEXT_STEP_MAX_LEN) return chars.join("");
  return chars.slice(0, NEXT_STEP_MAX_LEN).join("").trimEnd() + "…";
}

module.exports = {
  parseImplementChecklist,
  truncateNextStep,
  NEXT_STEP_MAX_LEN,
};
