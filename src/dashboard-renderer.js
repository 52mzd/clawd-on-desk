"use strict";

const { canOfferLocalFolder, focusUnavailableReasonKey } = globalThis.ClawdSessionFocusUnavailable;
const {
  aggregateTrellisTasks,
  groupTrellisTasks,
  groupTrellisArchiveByMonth,
  trellisArchiveMonthOf,
  trellisTaskOwningRoot,
  filterTrellisTasksByRoot,
  buildTrellisRootLabels,
  TRELLIS_PHASE_BADGE,
} = globalThis.ClawdDashboardTrellisPanel;
const {
  renderMarkdownDoc,
  MD_MAX_RENDER_LINES,
} = globalThis.ClawdTrellisDocRenderer;

const AGENT_LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "Copilot",
  "cursor-agent": "Cursor Agent",
  "gemini-cli": "Gemini",
  "antigravity-cli": "Antigravity",
  "kiro-cli": "Kiro",
  "kimi-cli": "Kimi",
  opencode: "opencode",
  mimocode: "MiMo Code",
  codebuddy: "CodeBuddy",
  workbuddy: "WorkBuddy",
  "grok-build": "Grok Build",
  pi: "Pi",
  openclaw: "OpenClaw",
};

let snapshot = { sessions: [], groups: [], orderedIds: [] };
let i18nPayload = { lang: "en", translations: {} };
let activeEdit = null;

const SESSION_FOLDER_FEEDBACK_MS = 4000;
const sessionFolderActionState = new Map();
const sessionAutomationActionState = new Map();

const titleEl = document.getElementById("title");
const countEl = document.getElementById("count");
const contentEl = document.getElementById("content");
const quotaSummaryEl = document.getElementById("quotaSummary");
const trellisPanelEl = document.getElementById("trellisPanel");
const trellisDetailOverlayEl = document.getElementById("trellisDetailOverlay");
// Independent Trellis view: a second scrolling main plus the header tab.
const trellisViewEl = document.getElementById("trellisView");
const viewSessionsTabEl = document.getElementById("viewSessionsTab");
const viewTrellisTabEl = document.getElementById("viewTrellisTab");
const sessionsHeaderExtrasEl = document.getElementById("sessionsHeaderExtras");
// Fixed node in the header. Keeping the mode banner outside the card tree
// means entering the mode never reflows or rebuilds the user's content.
const quickBannerEl = document.getElementById("quickBanner");

// ── Dashboard keyboard mode ─────────────────────────────────────────────────
// A temporary state of this same page: same DOM, same drafts, same scroll.
// Digits own session IDs for the whole round (never list indices), so a
// snapshot arriving mid-round can disable a number but never reassign it.
const QUICK_HANDOFF_QUIET_MS = 120;
const quick = {
  revision: 0,
  entries: [],
  active: false,
  // Digits are only captured when the round actually froze candidates. An
  // empty round still opens the Dashboard, it just captures nothing.
  capture: false,
  // A busy replacement may leave an unarmed editor on the borrowed host.
  canDismissBorrow: false,
  pending: false,
  pendingId: null,
  feedbackKey: "",
  hintKey: "",
  // Bumped on every cancel/exit so a late timer or in-flight IPC reply from an
  // abandoned attempt can never activate anything.
  generation: 0,
  // Bumped whenever a round is started, refused or ended. An `enter`/`ready`
  // reply that arrives after its round was abandoned must not revive it, and
  // comparing revisions alone cannot detect that (a dismissal leaves the
  // revision in place so a stale `dismissed` can still be matched).
  roundSeq: 0,
  // Frozen presentation for the round: which group held which id, in which
  // order, at the moment the round started. Discarded when the round ends.
  skeleton: null,
  held: new Set(),
  timer: null,
};
let composing = false;

// ── Scroll continuity across a host transfer ────────────────────────────────
// Observed on Windows (#972): after the mode borrowed this page and handed it
// back, `#content` was at exactly 0. Same WebContents, same document token,
// same group/card order and same scrollHeight before and after — but *which*
// step drops the offset is not established. The card tree is rebuilt
// (replaceChildren) on every render, the view is re-parented between two native
// hosts, the host size changes and focus moves; the evidence does not single
// any of them out, and this page cannot see below itself to find out. So this
// is a repair, not a prevention, and it is deliberately narrow:
//
//   * `top` is the position the user last chose. A landing on exactly 0 that no
//     user gesture produced never overwrites it.
//   * `armed` is only true while a transfer is plausible: from the start of a
//     round until the round has ended and one settling signal has arrived.
//     Outside that window nothing is ever repaired.
//   * a repair only fires at exactly 0, only while armed, only when the content
//     is still tall enough, and it clamps to the current maximum.
//   * a scroll the user asked for always wins, including a scroll to the top.
//     Chromium turns one wheel notch into a whole animation — a scroll event
//     per frame, only the first of which sits next to an input event — so what
//     is tracked is the *gesture* (wheel / scrolling keys; the keys
//     come from the document-capture handler, so a key that never reaches this
//     element still counts), and every frame it produces belongs to the user.
//     A gesture ends at `scrollend` or when a movement reverses it. Pointer
//     holds are separate: a plain click must not leave a gesture waiting for
//     a scrollend that will never come. Drag positions belong to the user
//     until release, including a last position whose scroll event is queued.
//
// The repair rides the scroll/resize signals the transfer itself produces plus
// the round's own IPC boundaries — no timers and no retry loops, which could
// otherwise land on top of a scroll the user made in the meantime.
const SCROLL_INTENT_KEYS = new Set([
  "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " ", "Spacebar",
]);
// Native keyboard semantics only, not the feature's platform-availability gate.
// On macOS bare Home scrolls the page even while a text input owns focus; on
// Windows that same key moves the caret and must not open a page gesture.
const MAC_INPUT_HOME_SCROLL = typeof navigator !== "undefined"
  && /^Mac/.test(navigator.platform || "");
const scrollGuard = {
  armed: false,
  // The round ended: stay armed for the return transfer, then close on the
  // first signal after it so nothing is repaired indefinitely.
  settling: false,
  top: 0,
  // A scroll the user started that has not finished yet.
  gesture: false,
  // Which way that gesture is moving (-1 up, 1 down, 0 = not moved yet).
  gestureDir: 0,
  // A pointer is still down, so the whole drag is theirs whatever it does.
  held: false,
};
let restoringScroll = false;

function scrollMetrics() {
  if (!contentEl) return null;
  const top = contentEl.scrollTop;
  const scrollHeight = contentEl.scrollHeight;
  const clientHeight = contentEl.clientHeight;
  if (!Number.isFinite(top) || !Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) {
    return null;
  }
  return { top, max: Math.max(0, scrollHeight - clientHeight) };
}

// The user started a scroll. Each input event opens a fresh gesture, so a
// direction change (wheel down, then up) is not read as a reversal.
function noteScrollIntent() {
  scrollGuard.gesture = true;
  scrollGuard.gestureDir = 0;
}

function endScrollGesture() {
  scrollGuard.gesture = false;
  scrollGuard.gestureDir = 0;
}

function endScrollHold() {
  if (!scrollGuard.held) return;
  // The last drag offset can be applied before its scroll event is delivered.
  // Capture it while the pointer still owns it, without ending an independent
  // wheel/key animation or recording releases that started outside content.
  const metrics = scrollMetrics();
  if (metrics) scrollGuard.top = metrics.top;
  scrollGuard.held = false;
}

// Whether this scroll event is another frame of the gesture that is running.
// Chromium animates one wheel notch into a sequence of scroll events that moves
// steadily one way, so a same-direction move continues the gesture and a
// reversal ends it. `scrollend` ends it properly where the event is available.
function scrollContinuesGesture(top) {
  if (!scrollGuard.gesture) return false;
  const delta = top - scrollGuard.top;
  // No movement attributes nothing, and must not end a running animation.
  if (delta === 0) return false;
  const direction = delta > 0 ? 1 : -1;
  if (scrollGuard.gestureDir === 0) {
    scrollGuard.gestureDir = direction;
    return true;
  }
  if (scrollGuard.gestureDir === direction) return true;
  endScrollGesture();
  return false;
}

// From here on a transfer can move this page between hosts.
function armScrollGuard() {
  scrollGuard.armed = true;
  scrollGuard.settling = false;
  const metrics = scrollMetrics();
  // A 0 here is either a top the user already chose (recorded when it happened)
  // or an offset a transfer already dropped; neither is worth re-recording.
  if (metrics && metrics.top !== 0) scrollGuard.top = metrics.top;
}

// The round is over. Main returns the view to the ordinary host *before* it
// tells this page, so the return transfer can land first: stay armed for it.
function settleScrollGuard() {
  armScrollGuard();
  scrollGuard.settling = true;
}

function closeScrollGuard() {
  scrollGuard.armed = false;
  scrollGuard.settling = false;
}

// One signal that the scroller may have moved: a scroll event, a layout change
// or a transfer that just reported back.
function handleScrollSignal(options = {}) {
  if (restoringScroll) return false;
  const metrics = scrollMetrics();
  if (!metrics) {
    closeScrollGuard();
    return false;
  }
  // Only a scroll event can belong to a gesture; a layout signal or an IPC
  // reply never does, and must not end one either.
  const userOwned = options.fromScrollEvent === true
    && (scrollGuard.held || scrollContinuesGesture(metrics.top));
  if (!scrollGuard.armed) {
    // No transfer is possible right now, so wherever the page sits is simply
    // where the user is.
    scrollGuard.top = metrics.top;
    return false;
  }
  let repaired = false;
  if (metrics.top !== 0 || userOwned) {
    // A real position: the user's own, or a legitimate clamp.
    scrollGuard.top = metrics.top;
  } else if (scrollGuard.top > 0 && metrics.max > 0) {
    restoringScroll = true;
    try {
      contentEl.scrollTop = Math.min(scrollGuard.top, metrics.max);
    } finally {
      restoringScroll = false;
    }
    const after = scrollMetrics();
    if (after) scrollGuard.top = after.top;
    repaired = true;
  }
  if (scrollGuard.settling) closeScrollGuard();
  return repaired;
}

function isEditableElement(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

// The single busy predicate. It is answered before anything native moves,
// because the host transfer itself blurs a focused alias input and would
// commit a half-typed draft.
function isEditingBusy() {
  if (activeEdit) return true;
  if (composing) return true;
  return isEditableElement(document.activeElement);
}

function quickDigitForSession(sessionId) {
  if (!quick.active || !quick.capture || !sessionId) return 0;
  const index = quick.entries.findIndex((entry) => entry.id === sessionId);
  return index === -1 ? 0 : index + 1;
}

function clearQuickTimer() {
  if (quick.timer !== null) clearTimeout(quick.timer);
  quick.timer = null;
}

// Drop any not-yet-sent jump without touching the round itself.
function cancelPendingActivation() {
  clearQuickTimer();
  quick.generation += 1;
  quick.held = new Set();
  quick.pending = false;
  quick.pendingId = null;
}

function endQuickRound() {
  cancelPendingActivation();
  // Invalidate the round itself so any enter/ready reply still in flight is
  // discarded instead of re-arming a round the user already left.
  quick.roundSeq += 1;
  quick.active = false;
  quick.capture = false;
  quick.canDismissBorrow = false;
  quick.entries = [];
  // Dropping the skeleton restores the ordinary dynamic ordering.
  quick.skeleton = null;
  quick.feedbackKey = "";
  quick.hintKey = "";
  renderQuickBanner();
  render();
  // After this round's own repaint, so the settle window is not closed by it:
  // the page may still be on its way back to the ordinary host, because main
  // returns the view before it sends the dismissal.
  settleScrollGuard();
}

function setQuickHint(key) {
  quick.hintKey = key || "";
  renderQuickBanner();
}

function setQuickFeedback(key) {
  quick.feedbackKey = key || "";
  renderQuickBanner();
}

function renderQuickBanner() {
  // Busy negotiation must not rebuild an editor just to remove old digits.
  // Hide their paint without changing card geometry or the focused input.
  if (contentEl) contentEl.classList.toggle("is-quick-capture", quick.active && quick.capture);
  if (!quickBannerEl) return;
  const message = quick.feedbackKey || quick.hintKey
    || (quick.active ? "dashboardQuickSelectHint" : "");
  if (!message) {
    quickBannerEl.hidden = true;
    quickBannerEl.textContent = "";
    quickBannerEl.classList.remove("is-active");
    return;
  }
  quickBannerEl.hidden = false;
  quickBannerEl.textContent = t(message);
  quickBannerEl.classList.toggle("is-active", quick.active);
}

async function beginQuickRound(revision) {
  if (!Number.isInteger(revision) || revision <= 0) return;
  // Only main issues rounds and only ever forward; a stale or repeated intent
  // can never reopen a finished round.
  if (revision <= quick.revision) return;
  // The numbered skeleton renders inside the sessions content area, so a
  // round started while the Trellis view was open switches back first.
  switchDashboardView("sessions");
  quick.revision = revision;
  cancelPendingActivation();
  quick.roundSeq += 1;
  const seq = quick.roundSeq;
  quick.active = false;
  quick.capture = false;
  quick.canDismissBorrow = false;
  quick.entries = [];
  quick.skeleton = null;
  quick.feedbackKey = "";
  quick.hintKey = "";
  renderQuickBanner();

  let result;
  try {
    result = await window.dashboardAPI.quickEnter({ revision, busy: isEditingBusy() });
  } catch {
    result = null;
  }
  // The round was superseded, dismissed or invalidated while we waited.
  if (!result || seq !== quick.roundSeq || revision !== quick.revision) return;
  if (result.status !== "ok" && result.status !== "empty") {
    // Busy: this press is refused outright. The draft/IME/select keeps its
    // keyboard, nothing is armed, and the user presses the shortcut again once
    // the edit is finished. Do NOT force a render here — a forced rebuild
    // re-creates the alias input and re-selects the whole draft.
    if (result.status === "busy") {
      quick.canDismissBorrow = result.retainedBorrow === true;
      setQuickHint("dashboardQuickSelectBusy");
    }
    return;
  }
  quick.entries = Array.isArray(result.entries) ? result.entries : [];
  quick.capture = result.status === "ok" && quick.entries.length > 0;
  quick.active = true;
  // Pin the layout the user is already looking at before the first render of
  // the round, so entering the mode never rearranges existing cards.
  quick.skeleton = quick.capture ? captureQuickSkeleton() : null;
  quick.feedbackKey = "";
  quick.hintKey = quick.capture ? "" : "dashboardQuickSelectEmpty";

  // Editing may have started while `enter` was in flight. Nothing native has
  // moved yet, so tell main to abandon the round rather than transfer a page
  // whose detach would blur the input and commit its draft.
  if (isEditingBusy()) {
    quick.active = false;
    quick.capture = false;
    quick.entries = [];
    quick.skeleton = null;
    setQuickHint("dashboardQuickSelectBusy");
    try {
      const refused = await window.dashboardAPI.quickReady({ revision, busy: true });
      if (seq !== quick.roundSeq || revision !== quick.revision) return;
      quick.canDismissBorrow = refused && refused.status === "busy" && refused.retainedBorrow === true;
    } catch { /* main also ends the round on blur/close. */ }
    return;
  }

  // Paint the digits into the existing page before the quick host appears.
  // Everything from here on can move this page to another native host, so
  // remember where the user is first.
  armScrollGuard();
  renderQuickBanner();
  render({ force: true });
  let readyResult;
  try {
    readyResult = await window.dashboardAPI.quickReady({ revision, busy: false });
  } catch {
    readyResult = null;
  }
  if (seq !== quick.roundSeq) return;
  // Main refused or could not arm the round: drop the local mode so the page
  // never shows digits that cannot be activated.
  if (!readyResult || (readyResult.status !== "ok")) {
    endQuickRound();
    return;
  }
  // The page is on its new host. If the move dropped the offset before this
  // reply, no later scroll or layout signal is coming to report it.
  handleScrollSignal();
}

function dismissQuickRound() {
  const revision = quick.revision;
  cancelPendingActivation();
  if (!revision) return;
  try {
    const pending = window.dashboardAPI.quickDismiss({ revision });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    /* main also ends the round on blur/close. */
  }
  endQuickRound();
}

// Main-key row and numpad are tracked as distinct physical keys so holding one
// while tapping the other cannot fire early.
function physicalDigit(event) {
  if (/^(Digit|Numpad)[1-9]$/.test(event.code || "")) return event.code;
  return /^[1-9]$/.test(event.key) ? `key:${event.key}` : null;
}

function armQuickHandoff() {
  clearQuickTimer();
  if (!quick.pending || quick.held.size > 0) return;
  const attempt = quick.generation;
  const sessionId = quick.pendingId;
  const seq = quick.roundSeq;
  quick.timer = setTimeout(async () => {
    quick.timer = null;
    if (!quick.active || !quick.capture) return;
    if (quick.generation !== attempt || quick.roundSeq !== seq) return;
    // Re-validate the safe state at submit time, not only at keydown: an
    // input, select or IME composition may have taken focus during the quiet
    // period, and a jump must never fire out from under it.
    if (isEditingBusy()) {
      quick.pending = false;
      return;
    }
    const entry = quick.entries.find((item) => item.id === sessionId);
    if (!entry || !entry.canFocus) {
      quick.pending = false;
      setQuickFeedback("dashboardQuickSelectUnavailable");
      return;
    }
    let result;
    try {
      result = await window.dashboardAPI.quickActivate({ sessionId, revision: quick.revision });
    } catch {
      result = { status: "rejected" };
    }
    if (quick.generation !== attempt || quick.roundSeq !== seq) return;
    quick.pending = false;
    if (result && result.status === "submitted") {
      // Handed to the production focus path — not confirmed, not acked. Main
      // keeps the quick host up until the native blur completes the handoff.
      setQuickFeedback("dashboardQuickSelectSubmitted");
    } else if (result && result.reason === "dropped-duplicate") {
      setQuickFeedback("dashboardQuickSelectAlreadyRequested");
    } else {
      setQuickFeedback("dashboardQuickSelectUnavailable");
    }
  }, QUICK_HANDOFF_QUIET_MS);
}

function handleQuickKeydown(event) {
  // Scroll intent first, and before the round check: this handler is on
  // document capture, so it is the one place that sees a scrolling key no
  // matter which element it is aimed at (the scroller itself is not focusable,
  // so such a key often targets body). It must never change what the mode does
  // with the key.
  const buttonSpace = event && (event.key === " " || event.key === "Spacebar")
    && event.target && event.target.tagName === "BUTTON";
  const macInputHome = MAC_INPUT_HOME_SCROLL && event && event.key === "Home"
    && event.target && event.target.tagName === "INPUT"
    && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (event && SCROLL_INTENT_KEYS.has(event.key)
    && !event.defaultPrevented && !event.isComposing && !composing && !buttonSpace
    && (macInputHome || (!isEditingBusy() && !isEditableElement(event.target)))) {
    noteScrollIntent();
  }
  if (!quick.active) {
    // A refused replacement leaves the borrowed editor intact. Once editing
    // is over Esc/Tab may close that shell, but digits never auto-arm again.
    if (quick.canDismissBorrow && (event.key === "Escape" || event.key === "Tab")
      && !event.isComposing && !isEditingBusy() && !isEditableElement(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      dismissQuickRound();
    }
    return;
  }
  if (event.isComposing || composing) {
    cancelPendingActivation();
    return;
  }
  // An empty round shows the Dashboard but captures no digits; only Esc/Tab
  // are meaningful, and every other key belongs to the page.
  if (!quick.capture) {
    if (event.key === "Escape" || event.key === "Tab") {
      if (isEditingBusy() || isEditableElement(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      dismissQuickRound();
    }
    return;
  }
  // Inputs, selects, contenteditable and an active alias edit keep their own
  // keyboard: the mode never swallows a keystroke it does not act on.
  if (isEditingBusy() || isEditableElement(event.target)) {
    cancelPendingActivation();
    return;
  }
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    dismissQuickRound();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const physicalKey = physicalDigit(event);
  if (!physicalKey) return;
  // With NumLock off, Chromium keeps `code: "Numpad2"` but reports the
  // navigation meaning in `key` (for example, "ArrowDown"). Leave those
  // navigation keys to the page instead of silently jumping to a session.
  // Main-row Digit codes remain layout-independent for AZERTY and peers.
  if (physicalKey.startsWith("Numpad") && !/^[1-9]$/.test(event.key)) return;
  // Shift is part of typing the digit on layouts such as AZERTY. Only accept
  // it when `code` proves which physical digit key was pressed; the key-only
  // fallback must keep modified shortcuts out of Quick Select.
  if (event.shiftKey && physicalKey.startsWith("key:")) return;
  const digit = Number(physicalKey.slice(-1));
  event.preventDefault();
  event.stopPropagation();
  quick.held.add(physicalKey);
  clearQuickTimer();
  // First target wins for the whole hold; auto-repeat never re-targets.
  if (quick.pending || event.repeat) return;
  const entry = quick.entries[digit - 1];
  if (!entry) return;
  if (!entry.canFocus) {
    setQuickFeedback("dashboardQuickSelectUnavailable");
    return;
  }
  quick.pending = true;
  quick.pendingId = entry.id;
  setQuickFeedback("");
}

function handleQuickKeyup(event) {
  if (!quick.active) return;
  const physicalKey = physicalDigit(event);
  if (!physicalKey) return;
  quick.held.delete(physicalKey);
  // Quiet period starts only once every digit key is up.
  armQuickHandoff();
}
// The manual Kimi quota refresh lives inside the Kimi quota section header
// (built by renderQuotaSummary), so these refs are re-pointed on every quota
// summary rebuild and stay null whenever the section is not rendered.
let kimiQuotaRefreshButtonEl = null;
let kimiQuotaRefreshFeedbackEl = null;

let kimiQuotaStatus = null;
let kimiQuotaRefreshBusy = false;

function t(key) {
  const dict = i18nPayload && i18nPayload.translations ? i18nPayload.translations : {};
  return dict[key] || key;
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 5) return t("sessionJustNow");
  if (sec < 60) return t("sessionHudElapsedSec").replace("{n}", sec);
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sessionMinAgo").replace("{n}", min);
  const hr = Math.floor(min / 60);
  return t("sessionHrAgo").replace("{n}", hr);
}

function formatTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";
  try {
    return new Intl.NumberFormat(i18nPayload.lang || "en").format(Math.round(n));
  } catch (_err) {
    return String(Math.round(n));
  }
}

function contextUsageText(session) {
  const usage = session && session.contextUsage;
  if (!usage || !Number.isFinite(Number(usage.used))) return "";
  const used = formatTokenCount(usage.used);
  if (Number.isFinite(Number(usage.limit))) {
    const limit = formatTokenCount(usage.limit);
    const percent = Number.isFinite(Number(usage.percent))
      ? ` (${Math.max(0, Math.min(100, Math.round(Number(usage.percent))))}%)`
      : "";
    return `${t("dashboardContextUsage")}: ${used} / ${limit}${percent}`;
  }
  return t("dashboardContextUsageUnknownLimit").replace("{used}", used);
}

// Account-wide rate-limit quota, shown once at the top of the dashboard -
// grouped per reporting source (this machine + one group per remote host;
// snapshot.accountQuota, fed by src/state-account-quota.js), because local
// and remote can be different subscriptions. Freshest-wins applies within
// a source only. Provider sections cover Antigravity's own /usage (Gemini +
// Claude/GPT-via-agy), Claude Code's rate_limits, Codex's generic rollout
// rate_limits, and Dashboard-only Codex Spark quota.
// Severity thresholds mirror the Orbit coins (quota-ring-renderer.js): a bar
// and a ring must agree on what counts as warn (60) and hot (85), otherwise
// the same bucket reads as alarming in one surface and fine in the other.
// test/quota-palette.test.js pins the mirror.
const QUOTA_WARN_AT = 60;
const QUOTA_HOT_AT = 85;

function quotaSeverityClass(usedPercent) {
  const p = Number(usedPercent);
  if (!Number.isFinite(p)) return "sev-ok";
  if (p > QUOTA_HOT_AT) return "sev-hot";
  if (p >= QUOTA_WARN_AT) return "sev-warn";
  return "sev-ok";
}
// A source that has not confirmed its numbers recently gets an explicit
// "as of N ago" label instead of presenting old numbers as live.
const DEFAULT_QUOTA_STALE_AFTER_MS = 5 * 60 * 1000;
const PROVIDER_STALE_AFTER_MS = Object.freeze({
  kimiQuota: 7 * 60 * 1000,
});

function quotaStaleAfterMs(providerKey) {
  return PROVIDER_STALE_AFTER_MS[providerKey] || DEFAULT_QUOTA_STALE_AFTER_MS;
}

function isKimiQuotaConnected() {
  return !!(
    kimiQuotaStatus
    && kimiQuotaStatus.status === "ok"
    && kimiQuotaStatus.configured === true
    && kimiQuotaStatus.collectionEnabled === true
  );
}

// Feedback is kept as data (not just written into the span) so it survives
// the quota summary rebuild that a fresh snapshot triggers right after a
// refresh completes.
let kimiQuotaRefreshFeedbackState = { text: "", isError: false };

function applyKimiQuotaRefreshFeedback() {
  const el = kimiQuotaRefreshFeedbackEl;
  if (!el) return;
  const { text, isError } = kimiQuotaRefreshFeedbackState;
  el.textContent = text;
  el.title = text;
  el.className = isError
    ? "quota-refresh-feedback error"
    : "quota-refresh-feedback";
  el.hidden = !text;
}

function setKimiQuotaRefreshFeedback(message, isError = false) {
  kimiQuotaRefreshFeedbackState = { text: message || "", isError: !!isError };
  applyKimiQuotaRefreshFeedback();
}

function syncKimiQuotaRefreshControl() {
  const button = kimiQuotaRefreshButtonEl;
  if (!button) return;
  button.disabled = kimiQuotaRefreshBusy
    || !kimiQuotaStatus
    || kimiQuotaStatus.decryptable !== true
    || kimiQuotaStatus.agentEnabled === false;
  button.className = kimiQuotaRefreshBusy
    ? "quota-refresh-button is-refreshing"
    : "quota-refresh-button";
  const label = t(
    kimiQuotaRefreshBusy ? "dashboardKimiQuotaRefreshing" : "dashboardKimiQuotaRefresh"
  );
  button.title = label;
  button.setAttribute("aria-label", label);
  applyKimiQuotaRefreshFeedback();
}

// Icon-only refresh action for the Kimi quota section header; repoints the
// module-level refs on every quota summary rebuild.
function buildKimiQuotaRefreshControl() {
  const feedback = document.createElement("span");
  feedback.className = "quota-refresh-feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  feedback.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quota-refresh-button";
  const icon = document.createElement("span");
  icon.className = "quota-refresh-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "↻";
  button.appendChild(icon);
  const label = document.createElement("span");
  label.className = "quota-refresh-label";
  label.textContent = t("dashboardKimiQuotaRefreshShort");
  button.appendChild(label);
  button.addEventListener("click", refreshKimiQuotaFromDashboard);
  kimiQuotaRefreshFeedbackEl = feedback;
  kimiQuotaRefreshButtonEl = button;
  syncKimiQuotaRefreshControl();
  return [feedback, button];
}

async function reloadKimiQuotaStatus() {
  if (!window.dashboardAPI || typeof window.dashboardAPI.getKimiQuotaStatus !== "function") {
    kimiQuotaStatus = null;
  } else {
    try { kimiQuotaStatus = await window.dashboardAPI.getKimiQuotaStatus(); }
    catch { kimiQuotaStatus = null; }
  }
  // The connected flag feeds the quota summary signature, so this rebuilds
  // (showing/hiding the section-header refresh) only when it flipped.
  renderQuotaSummary(snapshot);
  syncKimiQuotaRefreshControl();
  return kimiQuotaStatus;
}

// Identity of the live session set. Only a change here can add or remove a
// resumable row, so it gates the disk read.
function liveSessionKey(value) {
  const sessions = value && Array.isArray(value.sessions) ? value.sessions : [];
  return sessions.map((session) => (session && session.id) || "").sort().join("\u0000");
}

function snapshotHasKimiQuota(value) {
  const accountQuota = Array.isArray(value && value.accountQuota) ? value.accountQuota : [];
  return accountQuota.some((entry) => entry && entry.kimiQuota && entry.kimiQuota.group);
}

async function refreshKimiQuotaFromDashboard() {
  if (kimiQuotaRefreshBusy || !window.dashboardAPI
      || typeof window.dashboardAPI.refreshKimiQuota !== "function") return;
  kimiQuotaRefreshBusy = true;
  setKimiQuotaRefreshFeedback("");
  syncKimiQuotaRefreshControl();
  let result;
  try { result = await window.dashboardAPI.refreshKimiQuota(); }
  catch { result = { status: "error", reason: "runtime-unavailable" }; }
  kimiQuotaRefreshBusy = false;
  await reloadKimiQuotaStatus();
  if (result && result.status === "ok") {
    setKimiQuotaRefreshFeedback(t("dashboardKimiQuotaUpdated"));
  } else {
    const reason = (result && (result.reason || result.message)) || "unknown-error";
    setKimiQuotaRefreshFeedback(
      t("dashboardKimiQuotaRefreshFailed").replace("{reason}", String(reason)),
      true
    );
  }
  syncKimiQuotaRefreshControl();
}

function formatDurationHM(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0
    ? t("dashboardQuotaResetHoursMinutes").replace("{h}", hours).replace("{m}", minutes)
    : t("dashboardQuotaResetMinutes").replace("{m}", minutes);
}

function formatResetIn(resetAt) {
  const n = Number(resetAt);
  if (!Number.isFinite(n)) return "";
  const secondsLeft = Math.round((n - Date.now()) / 1000);
  if (secondsLeft < 0) return "";
  return formatDurationHM(Math.round(secondsLeft / 60));
}

function formatAsOf(updatedAt) {
  const n = Number(updatedAt);
  if (!Number.isFinite(n)) return "";
  const agoMinutes = Math.round((Date.now() - n) / 60000);
  if (agoMinutes < 1) return "";
  return t("dashboardQuotaAsOf").replace("{time}", formatDurationHM(agoMinutes));
}

// The rate-limit windows reset on wall clock regardless of CLI activity, so
// a bucket whose resetAt has passed would show the pre-reset high - worse
// than showing nothing. The store already drops expired buckets at snapshot
// time; this guard covers buckets that expire between snapshots (the
// dashboard rerenders on its own tick).
function isExpiredBucket(bucket) {
  return Number.isFinite(bucket.resetAt) && bucket.resetAt <= Date.now();
}

function liveBucket(group, field) {
  const bucket = group && group[field];
  if (!bucket || typeof bucket !== "object") return null;
  // Window reset on wall clock: render as 0% (nothing reported since the
  // reset) rather than the pre-reset high or a vanished bar.
  if (bucket.expired === true || isExpiredBucket(bucket)) {
    return { ...bucket, usedPercent: 0, expired: true };
  }
  return bucket;
}

function formatQuotaWindowLabel(bucket, fallbackLabel) {
  const minutes = Number(bucket && bucket.windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

function quotaResetStyle(bucket, fallbackStyle) {
  const minutes = Number(bucket && bucket.windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackStyle;
  return minutes >= 24 * 60 ? "date" : "countdown";
}

// renderQuotaSummary can run once a second (see the setInterval(render, 1000)
// tick below) - cache the formatter per lang instead of constructing a new
// Intl.DateTimeFormat on every call.
let resetDateFormatterLang = null;
let resetDateFormatter = null;

function formatResetDate(resetAt) {
  const n = Number(resetAt);
  if (!Number.isFinite(n)) return "";
  const lang = (i18nPayload && i18nPayload.lang) || "en";
  try {
    if (!resetDateFormatter || resetDateFormatterLang !== lang) {
      resetDateFormatter = new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" });
      resetDateFormatterLang = lang;
    }
    return resetDateFormatter.format(n);
  } catch (_err) {
    return "";
  }
}

// One row (or two for Antigravity) per source that has live data for the
// provider. Source labels appear only when they carry information: a single
// local-only source renders exactly the compact pre-grouping layout, and a
// fresh source shows no "as of" suffix.
function buildQuotaSourceHeader(sourceEntry, providerEntry, baseLabel, providerKey) {
  const parts = [];
  const multiSource = sourceEntry.multiSource === true;
  if (multiSource) {
    parts.push(sourceEntry.host || t("dashboardQuotaSourceLocal"));
  }
  if (baseLabel) parts.push(baseLabel);
  // lastSeenAt (last confirmation), not updatedAt (last value change): a
  // reporter confirming the same numbers every minute is alive, not stale.
  // Fallback covers snapshots that predate lastSeenAt.
  const seenAt = Number(providerEntry.lastSeenAt ?? providerEntry.updatedAt ?? 0);
  const age = Date.now() - seenAt;
  if (Number.isFinite(age) && age > quotaStaleAfterMs(providerKey)) {
    const asOf = formatAsOf(seenAt);
    if (asOf) parts.push(asOf);
  }
  return parts.length ? parts.join(" · ") : null;
}

function buildQuotaHalfBar(labelText, bucket, resetStyle, providerKey, ringSlot) {
  const half = document.createElement("div");
  half.className = "quota-half";

  const labelRow = document.createElement("div");
  labelRow.className = "quota-label-row";
  labelRow.appendChild(createText("span", "quota-label", labelText));
  const percentText = `${bucket.usedPercent}%`;
  let resetText = "";
  if (Number.isFinite(bucket.resetAt)) {
    resetText = resetStyle === "date"
      ? t("dashboardQuotaResetOn").replace("{date}", formatResetDate(bucket.resetAt))
      : t("dashboardQuotaResetIn").replace("{time}", formatResetIn(bucket.resetAt));
  }
  const bucketSeenAt = Number(bucket.lastSeenAt);
  const asOf = Number.isFinite(bucketSeenAt)
    && Date.now() - bucketSeenAt > quotaStaleAfterMs(providerKey)
    ? formatAsOf(bucketSeenAt)
    : "";
  const details = [percentText, resetText, asOf].filter(Boolean).join(" · ");
  labelRow.appendChild(createText("span", "quota-percent", details));
  half.appendChild(labelRow);

  const track = document.createElement("div");
  track.className = "quota-bar-track";
  const fill = document.createElement("div");
  // Identity classes (pv-/rg-) paint the bar in the provider+window hue the
  // Orbit coin uses for the same logical window; the sev- class overrides it
  // on warning/hot, again exactly like the coin's fill.
  fill.className = `quota-bar-fill pv-${providerKey} rg-${ringSlot} ${quotaSeverityClass(bucket.usedPercent)}`;
  fill.style.width = `${Math.max(0, Math.min(100, bucket.usedPercent))}%`;
  track.appendChild(fill);
  half.appendChild(track);

  return half;
}

function buildQuotaGroupRow(headerText, fiveHourBucket, weeklyBucket, providerKey) {
  if (!fiveHourBucket && !weeklyBucket) return null;
  const row = document.createElement("div");
  row.className = "quota-group-row";
  if (headerText) row.appendChild(createText("div", "quota-group-header", headerText));
  const halves = document.createElement("div");
  halves.className = "quota-halves";
  if (fiveHourBucket) {
    halves.appendChild(buildQuotaHalfBar(
      formatQuotaWindowLabel(fiveHourBucket, t("dashboardQuotaFiveHour")),
      fiveHourBucket,
      quotaResetStyle(fiveHourBucket, "countdown"),
      providerKey,
      "outer"
    ));
  }
  if (weeklyBucket) {
    halves.appendChild(buildQuotaHalfBar(
      formatQuotaWindowLabel(weeklyBucket, t("dashboardQuotaWeekly")),
      weeklyBucket,
      quotaResetStyle(weeklyBucket, "date"),
      providerKey,
      "inner"
    ));
  }
  row.appendChild(halves);
  return row;
}

function buildQuotaSection(headerKey, rows, headerExtras = []) {
  const usableRows = rows.filter(Boolean);
  if (!usableRows.length && !headerExtras.length) return null;
  const section = document.createElement("div");
  section.className = "quota-section";
  if (headerExtras.length) {
    const titlebar = document.createElement("div");
    titlebar.className = "quota-section-titlebar";
    titlebar.appendChild(createText("div", "quota-section-header", t(headerKey)));
    for (const el of headerExtras) titlebar.appendChild(el);
    section.appendChild(titlebar);
  } else {
    section.appendChild(createText("div", "quota-section-header", t(headerKey)));
  }
  for (const row of usableRows) section.appendChild(row);
  return section;
}

// render() re-invokes renderQuotaSummary every second so the "resets in Xh
// Ym" countdowns stay live even between real quota updates, but that only
// needs to touch the DOM once a minute (formatResetIn's granularity) or when
// the underlying quota/lang actually changes - not on every tick. Skipping
// the rebuild otherwise avoids rebuilding the whole subtree (and re-running
// every Intl.DateTimeFormat/formatResetIn call inside it) 59 times a minute
// for nothing.
let lastQuotaSummarySignature = null;

function computeQuotaSummarySignature(accountQuota) {
  return JSON.stringify({
    lang: (i18nPayload && i18nPayload.lang) || "en",
    minute: accountQuota.length ? Math.floor(Date.now() / 60000) : null,
    accountQuota,
    // The Kimi section header hosts the manual refresh while connected, so a
    // connection flip must force a rebuild even when the data is unchanged.
    kimiRefresh: isKimiQuotaConnected(),
  });
}

function renderQuotaSummary(snapshot) {
  if (!quotaSummaryEl) return;
  const accountQuota = Array.isArray(snapshot && snapshot.accountQuota) ? snapshot.accountQuota : [];

  const signature = computeQuotaSummarySignature(accountQuota);
  if (signature === lastQuotaSummarySignature) return;
  lastQuotaSummarySignature = signature;
  // Stale until the Kimi section (re)creates them below.
  kimiQuotaRefreshButtonEl = null;
  kimiQuotaRefreshFeedbackEl = null;

  const multiSource = accountQuota.length > 1;
  const sources = accountQuota.map((entry) => ({ ...entry, multiSource }));

  const sections = [];

  const antigravityRows = [];
  for (const source of sources) {
    const provider = source.antigravityQuota;
    const group = provider && provider.group;
    if (!group) continue;
    antigravityRows.push(
      buildQuotaGroupRow(
        buildQuotaSourceHeader(source, provider, t("dashboardQuotaGroupGemini"), "antigravityQuota"),
        liveBucket(group, "geminiFiveHour"),
        liveBucket(group, "geminiWeekly"),
        "antigravityQuota"
      ),
      buildQuotaGroupRow(
        buildQuotaSourceHeader(source, provider, t("dashboardQuotaGroupThirdParty"), "antigravityQuota"),
        liveBucket(group, "thirdPartyFiveHour"),
        liveBucket(group, "thirdPartyWeekly"),
        "antigravityQuota"
      )
    );
  }
  const antigravitySection = buildQuotaSection("dashboardQuotaSectionAntigravity", antigravityRows);
  if (antigravitySection) sections.push(antigravitySection);

  const claudeRows = sources.map((source) => {
    const provider = source.claudeQuota;
    const group = provider && provider.group;
    if (!group) return null;
    return buildQuotaGroupRow(
      buildQuotaSourceHeader(source, provider, null, "claudeQuota"),
      liveBucket(group, "claudeFiveHour"),
      liveBucket(group, "claudeWeekly"),
      "claudeQuota"
    );
  });
  const claudeSection = buildQuotaSection("dashboardQuotaSectionClaudeCode", claudeRows);
  if (claudeSection) sections.push(claudeSection);

  const codexRows = sources.map((source) => {
    const provider = source.codexQuota;
    const group = provider && provider.group;
    if (!group) return null;
    return buildQuotaGroupRow(
      buildQuotaSourceHeader(source, provider, null, "codexQuota"),
      liveBucket(group, "codexFiveHour"),
      liveBucket(group, "codexWeekly"),
      "codexQuota"
    );
  });
  const codexSection = buildQuotaSection("dashboardQuotaSectionCodex", codexRows);
  if (codexSection) sections.push(codexSection);

  const codexSparkRows = sources.map((source) => {
    const provider = source.codexSparkQuota;
    const group = provider && provider.group;
    if (!group) return null;
    return buildQuotaGroupRow(
      buildQuotaSourceHeader(source, provider, null, "codexSparkQuota"),
      liveBucket(group, "codexFiveHour"),
      liveBucket(group, "codexWeekly"),
      "codexSparkQuota"
    );
  });
  const codexSparkSection = buildQuotaSection(
    "dashboardQuotaSectionCodexSpark",
    codexSparkRows
  );
  if (codexSparkSection) sections.push(codexSparkSection);

  const kimiRows = sources.map((source) => {
    const provider = source.kimiQuota;
    const group = provider && provider.group;
    if (!group) return null;
    return buildQuotaGroupRow(
      buildQuotaSourceHeader(source, provider, null, "kimiQuota"),
      liveBucket(group, "kimiFiveHour"),
      liveBucket(group, "kimiWeekly"),
      "kimiQuota"
    );
  });
  const kimiConnected = isKimiQuotaConnected();
  if (kimiConnected && !kimiRows.some(Boolean)) {
    // Connected but nothing reported yet: keep the section visible so the
    // manual refresh that fetches the first numbers has a home.
    kimiRows.push(createText("div", "quota-empty-hint", t("dashboardKimiQuotaEmpty")));
  }
  const kimiSection = buildQuotaSection(
    "dashboardQuotaSectionKimiCode",
    kimiRows,
    kimiConnected ? buildKimiQuotaRefreshControl() : []
  );
  if (kimiSection) sections.push(kimiSection);

  if (!sections.length) {
    quotaSummaryEl.hidden = true;
    quotaSummaryEl.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const section of sections) fragment.appendChild(section);
  quotaSummaryEl.replaceChildren(fragment);
  quotaSummaryEl.hidden = false;
}

// ── Trellis tasks panel ────────────────────────────────────────────────────
// Read-only project of the per-session `trellis` bindings already riding
// the snapshot (no new channel, no watcher): deduplicated per task by
// aggregateTrellisTasks, rendered under the header like the quota summary,
// and hidden entirely when no live session carries a binding. Expanded
// multi-session rows survive the rebuild the same way HUD detail rows do
// (module Set keyed by taskPath, re-read on every rebuild). The archive
// browser now lives in the independent Trellis view below, not here.
const expandedTrellisTasks = new Set();
let lastTrellisPanelSignature = null;
// Collapsed phase sections (plan/execute/check…) in the session trellis
// panel — survives the 1s rebuild because the signature ignores it.
const collapsedTrellisPhases = new Set();

// Independent Trellis view state (module-level, same lifetime policy as
// expandedTrellisTasks): roots/active/archive are each fetched on demand
// (view switch + explicit refresh buttons, never polled), with seq guards
// so a stale IPC reply can never overwrite newer UI. openMonths keeps the
// month-collapse state of the archive browser (null = all collapsed).
let activeView = "sessions";
let lastTrellisViewSignature = null;
const trellisView = {
  roots: [],
  picks: [],
  rootsLoaded: false,
  rootsError: false,
  // One-shot hint after picking a folder that contains no trellis
  // projects (directly or as children); cleared on next roots refresh.
  noProjectsHint: false,
  // Session-level UI state, never persisted: null = merged "all"
  // view, otherwise the registered root the lists are filtered to.
  selectedRoot: null,
  // v7 R8: the three project-level drawers (⚙ manage roots, ⛓ network
  // overview, 📐 spec map) share one exclusive slot. Session-level, not
  // persisted; opening one closes the others.
  panelOpen: null, // null | "network" | "spec" (root manage moved to Settings)
  active: { loading: false, seq: 0, loaded: false, tasks: [], error: false },
  archive: { loading: false, seq: 0, loaded: false, tasks: [], error: false, openMonths: null },
};

function computeTrellisPanelSignature(tasks) {
  return JSON.stringify({
    lang: (i18nPayload && i18nPayload.lang) || "en",
    tasks,
    expanded: [...expandedTrellisTasks].sort(),
  });
}

function trellisTaskRowTitle(task) {
  return t("sessionHudTrellisTooltip")
    .replace("{title}", task.title || task.taskPath)
    .replace("{phase}", t(TRELLIS_PHASE_BADGE[task.phase].labelKey));
}

function createTrellisSessionChip(binding) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = binding.canFocus
    ? "trellis-session-chip"
    : "trellis-session-chip trellis-session-chip-unfocusable";
  chip.textContent = binding.displayTitle;
  chip.title = binding.displayTitle;
  if (!binding.canFocus) {
    chip.disabled = true;
    chip.setAttribute("aria-disabled", "true");
  }
  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    window.dashboardAPI.focusSession(binding.id);
  });
  return chip;
}

// v4-c R3: mini tick bar next to the numeric progress. Totals above the
// tick cap degrade proportionally (12 ticks, filled = ratio) so a 40-step
// checklist cannot blow up the row width. Returns null when there is
// nothing meaningful to draw (no progress / zero total).
const TRELLIS_PROGRESS_TICK_MAX = 12;

function buildTrellisProgressTicks(progress) {
  if (!progress || typeof progress.done !== "number" || typeof progress.total !== "number") {
    return null;
  }
  if (progress.total <= 1) return null;
  const ticks = Math.min(progress.total, TRELLIS_PROGRESS_TICK_MAX);
  const filled = ticks === progress.total
    ? Math.min(progress.done, ticks)
    : Math.min(Math.round((progress.done / progress.total) * ticks), ticks);
  const wrap = document.createElement("span");
  wrap.className = "trellis-progress-ticks";
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `${progress.done}/${progress.total}`);
  for (let i = 0; i < ticks; i++) {
    const tick = document.createElement("span");
    tick.className = i < filled ? "trellis-progress-tick is-filled" : "trellis-progress-tick";
    wrap.appendChild(tick);
  }
  return wrap;
}

function appendTrellisProgressWithTicks(main, progress) {
  if (!progress) return;
  const text = createText("span", "trellis-task-progress", `${progress.done}/${progress.total}`);
  const ticks = buildTrellisProgressTicks(progress);
  if (ticks) {
    const group = document.createElement("span");
    group.className = "trellis-progress-cell";
    group.appendChild(ticks);
    group.appendChild(text);
    main.appendChild(group);
  } else {
    main.appendChild(text);
  }
}

function createTrellisPhaseSection(phase, label, count) {
  const section = document.createElement("button");
  section.type = "button";
  section.className = "trellis-phase-section";
  if (collapsedTrellisPhases.has(phase)) section.classList.add("is-collapsed");
  const caret = document.createElement("span");
  // Same bare caret icon as left-rail phase heads (R7): one caret family.
  caret.className = "trellis-phase-section-caret";
  caret.appendChild(iconSvg("caret", 12));
  section.appendChild(caret);
  section.appendChild(createText("span", "trellis-phase-section-label", label));
  section.appendChild(createText("span", "trellis-phase-section-count", String(count)));
  const key = `trellisPhaseSection:${phase}`;
  section.setAttribute("aria-expanded", collapsedTrellisPhases.has(phase) ? "false" : "true");
  section.setAttribute("aria-label", label);
  section.dataset.phaseKey = key;
  section.addEventListener("click", () => {
    if (collapsedTrellisPhases.has(phase)) collapsedTrellisPhases.delete(phase);
    else collapsedTrellisPhases.add(phase);
    lastTrellisPanelSignature = null;
    renderTrellisPanel();
  });
  return section;
}

function createTrellisTaskRow(groupRow) {
  const task = groupRow.task;
  const row = document.createElement("div");
  row.className = "trellis-task-row";
  if (groupRow.depth > 0) row.classList.add("trellis-task-row-child");
  if (groupRow.hasChildren) row.classList.add("trellis-task-row-group");
  row.title = trellisTaskRowTitle(task);

  const main = document.createElement("div");
  main.className = "trellis-task-main";
  main.appendChild(createText("span", "trellis-task-title", task.title || task.taskPath));

  const badge = TRELLIS_PHASE_BADGE[task.phase];
  const phaseEl = createText("span", `trellis-phase-badge ${badge.cls}`, t(badge.labelKey));
  main.appendChild(phaseEl);

  // A parent row with live children shows the subtree summary instead of
  // its own step count (the group is what the row now answers for);
  // childless rows keep the plain task progress.
  if (groupRow.childSummary) {
    main.appendChild(createText(
      "span",
      "trellis-task-group-summary",
      t("dashboardTrellisGroupProgress")
        .replace("{done}", String(groupRow.childSummary.done))
        .replace("{total}", String(groupRow.childSummary.total))
    ));
  } else if (task.progress) {
    appendTrellisProgressWithTicks(main, task.progress);
  }
  if (task.sessions.length > 1) {
    main.appendChild(createText(
      "span",
      "trellis-task-count",
      t("dashboardTrellisBoundSessions").replace("{n}", String(task.sessions.length))
    ));
  }
  // Row-tail detail button: opens the on-demand task-detail card. The row
  // itself keeps its v1 click semantics (single binding → focus, several →
  // expand chips), so the button stops propagation before anything else.
  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "trellis-task-detail-btn";
  detailBtn.textContent = "ⓘ";
  detailBtn.title = t("dashboardTrellisDetailOpen");
  detailBtn.setAttribute("aria-label", t("dashboardTrellisDetailOpen"));
  detailBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    void openTrellisDetail(task);
  });
  main.appendChild(detailBtn);
  row.appendChild(main);

  // One focusable binding: the whole row is the jump target, reusing the
  // card's existing focus path. Several bindings: the row expands into
  // session chips and each chip owns its own focus call.
  row.addEventListener("click", () => {
    if (task.sessions.length > 1) {
      if (expandedTrellisTasks.has(task.taskPath)) expandedTrellisTasks.delete(task.taskPath);
      else expandedTrellisTasks.add(task.taskPath);
      lastTrellisPanelSignature = null;
      renderTrellisPanel();
      return;
    }
    const only = task.sessions[0];
    if (only && only.canFocus) window.dashboardAPI.focusSession(only.id);
  });

  if (expandedTrellisTasks.has(task.taskPath)) {
    const chips = document.createElement("div");
    chips.className = "trellis-task-sessions";
    for (const binding of task.sessions) chips.appendChild(createTrellisSessionChip(binding));
    row.appendChild(chips);
    row.classList.add("trellis-task-row-expanded");
  }

  return row;
}

function renderTrellisPanel() {
  if (!trellisPanelEl) return;
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  const tasks = aggregateTrellisTasks(sessions);
  const signature = computeTrellisPanelSignature(tasks);
  if (signature === lastTrellisPanelSignature) return;
  lastTrellisPanelSignature = signature;

  if (!tasks.length) {
    expandedTrellisTasks.clear();
    trellisPanelEl.hidden = true;
    trellisPanelEl.replaceChildren();
    return;
  }

  const livePaths = new Set(tasks.map((task) => task.taskPath));
  for (const taskPath of expandedTrellisTasks) {
    if (!livePaths.has(taskPath)) expandedTrellisTasks.delete(taskPath);
  }

  const fragment = document.createDocumentFragment();
  fragment.appendChild(createText("div", "trellis-panel-title", t("dashboardTrellisSectionTitle")));
  // Phase-grouped card tree (09-25 apple-design): plan → execute → check …
  // sections are light collapsible dividers, task cards stay in the same
  // visual layer as session cards. Children ALWAYS travel with their root
  // ancestor's phase — splitting a subtree across sections breaks the
  // parent→child order contract (see dashboard-trellis-panel tests).
  const rows = groupTrellisTasks(tasks);
  const phaseOrder = Object.keys(TRELLIS_PHASE_BADGE);
  // Single walk: a depth-0 row sets the current phase; every child inherits
  // its root ancestor's phase. Bucket order === tree order, so the
  // parent→child order contract survives phase grouping.
  const byPhase = new Map();
  let currentPhase = null;
  for (const groupRow of rows) {
    if (groupRow.depth === 0) {
      currentPhase = Object.prototype.hasOwnProperty.call(TRELLIS_PHASE_BADGE, groupRow.task.phase)
        ? groupRow.task.phase
        : "other";
    }
    if (!currentPhase) continue; // defensive: orphan before any root
    if (!byPhase.has(currentPhase)) byPhase.set(currentPhase, []);
    byPhase.get(currentPhase).push(groupRow);
  }
  const orderedPhases = [
    ...phaseOrder.filter((phase) => byPhase.has(phase) && byPhase.get(phase).length),
    ...(byPhase.has("other") && byPhase.get("other").length ? ["other"] : []),
  ];
  for (const phase of orderedPhases) {
    const phaseRows = byPhase.get(phase);
    const label = phase === "other" ? "…" : t(TRELLIS_PHASE_BADGE[phase].labelKey);
    // Phase = first-class CARD (R7): the head lives INSIDE the card as its
    // header — same anatomy as left-rail .trellis-split-phase-card. Folding
    // skips the rows (never hides the whole card — the head must stay
    // clickable to unfold; also avoids the [hidden]-on-container trap).
    const wrap = document.createElement("div");
    wrap.className = "trellis-phase-rows";
    wrap.appendChild(createTrellisPhaseSection(phase, label, phaseRows.filter((r) => r.depth === 0).length));
    if (!collapsedTrellisPhases.has(phase)) {
      for (const groupRow of phaseRows) wrap.appendChild(createTrellisTaskRow(groupRow));
    }
    fragment.appendChild(wrap);
  }
  trellisPanelEl.replaceChildren(fragment);
  trellisPanelEl.hidden = false;
}

// ── Trellis independent view ───────────────────────────────────────────────
// Project-centric browsing that works with no live session at all: the
// registered-roots panel (add via the main-side directory picker, remove
// per row), the active-task list and the archive browser, each fed by a
// one-shot IPC read (view switch + explicit refresh, never a poll).

async function refreshTrellisViewRoots() {
  let result = null;
  try {
    if (typeof window.dashboardAPI.listTrellisRoots !== "function") {
      throw new Error("bridge-unavailable");
    }
    result = await window.dashboardAPI.listTrellisRoots();
  } catch {
    result = null;
  }
  if (result && typeof result === "object" && result.status === "ok" && Array.isArray(result.roots)) {
    trellisView.roots = result.roots.filter((root) => typeof root === "string" && root);
    trellisView.picks = Array.isArray(result.picks)
      ? result.picks.filter((p) => p && typeof p === "object" && typeof p.picked === "string" && Array.isArray(p.roots))
      : [];
    trellisView.rootsLoaded = true;
    trellisView.rootsError = false;
    trellisView.noProjectsHint = false;
    // A removed root takes its filter selection with it — fall back to
    // the merged "all" view instead of filtering everything out.
    if (trellisView.selectedRoot !== null && !trellisView.roots.includes(trellisView.selectedRoot)) {
      trellisView.selectedRoot = null;
    }
  } else {
    trellisView.rootsError = true;
  }
  lastTrellisViewSignature = null;
  renderTrellisView();
}

async function refreshTrellisActive() {
  const state = trellisView.active;
  state.loading = true;
  state.error = false;
  state.seq += 1;
  const seq = state.seq;
  lastTrellisViewSignature = null;
  renderTrellisView();
  let result = null;
  try {
    if (typeof window.dashboardAPI.getTrellisActiveList !== "function") {
      throw new Error("bridge-unavailable");
    }
    result = await window.dashboardAPI.getTrellisActiveList();
  } catch {
    result = null;
  }
  if (seq !== state.seq) return;
  state.loading = false;
  if (result && typeof result === "object" && result.status === "ok" && Array.isArray(result.tasks)) {
    state.tasks = result.tasks;
    state.loaded = true;
    state.error = false;
  } else {
    state.error = true;
  }
  lastTrellisViewSignature = null;
  renderTrellisView();
}

async function refreshTrellisViewArchive() {
  const state = trellisView.archive;
  state.loading = true;
  state.error = false;
  state.seq += 1;
  const seq = state.seq;
  lastTrellisViewSignature = null;
  renderTrellisView();
  let result = null;
  try {
    if (typeof window.dashboardAPI.getTrellisArchiveList !== "function") {
      throw new Error("bridge-unavailable");
    }
    result = await window.dashboardAPI.getTrellisArchiveList();
  } catch {
    result = null;
  }
  if (seq !== state.seq) return;
  state.loading = false;
  if (result && typeof result === "object" && result.status === "ok" && Array.isArray(result.tasks)) {
    state.tasks = result.tasks;
    state.loaded = true;
    state.error = false;
    // First successful load: open the newest month by default so rows are
    // immediately visible; older months stay collapsed behind their headers.
    if (state.openMonths === null && state.tasks.length) {
      const groups = groupTrellisArchiveByMonth(state.tasks);
      if (groups.length) state.openMonths = new Set([groups[0].month]);
    }
  } else {
    state.error = true;
  }
  lastTrellisViewSignature = null;
  renderTrellisView();
}

function refreshTrellisView() {
  void refreshTrellisViewRoots();
  void refreshTrellisActive();
  void refreshTrellisViewArchive();
  lastTrellisViewSignature = null;
  renderTrellisView();
}

// Split rows share the tree rows' detail-open payload shape: archived
// tasks go through the cwd-carrying shape, active ones pass the row task.
// The ⓘ row-tail button keeps the OVERLAY form (full-width card) while
// row clicks use the embedded pane — both hosts stay reachable in v7.
function openTrellisDetailFromTask(task) {
  if (!task) return;
  if (task.completedAt) {
    void openTrellisDetail({
      taskPath: task.taskPath,
      title: task.title || "",
      cwd: task.cwd || "",
      sessions: [],
      progress: null,
    });
    return;
  }
  void openTrellisDetail(task);
}

function buildTrellisRootsSection() {
  const section = document.createElement("div");
  section.className = "trellis-view-section trellis-roots-section";
  // Root management moved OUT of the dashboard (09-25): add/remove lives in
  // Settings → Trellis. This section only renders error / empty hints; with
  // healthy roots it stays empty — the chip bar is the primary UI.
  if (trellisView.rootsError) {
    section.appendChild(createText("div", "trellis-view-error", t("dashboardTrellisRootsError")));
  } else if (trellisView.noProjectsHint) {
    section.appendChild(createText("div", "trellis-view-empty", t("dashboardTrellisRootsNoProjects")));
  } else if (!trellisView.roots.length) {
    section.appendChild(createText("div", "trellis-view-empty", t("dashboardTrellisRootsEmptyHint")));
  }
  return section;
}

// Shared per-row origin tag: the disambiguated root label, but only in
// the merged "all" view and only for rows that actually belong to a
// registered root (session-resolved unregistered projects stay untagged
// rather than showing a misleading cwd basename).
function trellisRowProjectLabel(task, labels) {
  if (trellisView.selectedRoot !== null) return null;
  const owner = trellisTaskOwningRoot(task && task.cwd, trellisView.roots);
  return owner ? labels.get(owner) || owner : null;
}

// Project filter chip row (between the roots manager and the task lists):
// "All projects" + one chip per registered root, labeled by the root's
// (disambiguated) basename with its live-task count. Pure render-layer
// state — clicking only re-filters what is already in memory.
// v5-b: switch the Trellis view display mode (tree ⇄ board). Cached in
// localStorage for reloads of the same window; never leaves the renderer.
// View-level rebuild entry: invalidates the *view* signature (not the panel
// one) so renderTrellisView() re-renders body + toggles even when panel data
// is unchanged. All view-state mutations (mode, split selection, archive
// fold) must go through this, never through renderTrellisView() directly.
function renderTrellisViewBody() {
  lastTrellisViewSignature = null;
  renderTrellisView();
}

// An in-place (LOCAL) fold updates the DOM without going through
// renderTrellisView — but `collapsedPaths` / `archive.openMonths` still
// live in the structural signature. Leaving it stale makes the next 1s
// tick read the stored state as "new structure" and rebuild the whole
// list, which silently undoes the point of the local path (in-flight CSS
// transitions are cut, row nodes / focus are thrown away). Refreshing the
// signature after a successful local mutation keeps it describing the
// LIVE DOM, so a rebuild really only happens when the DATA changed (A1).
function syncTrellisViewSignature() {
  lastTrellisViewSignature = computeTrellisViewSignature();
}

// v6 master-detail split state. Session-level, never persisted. Entry
// stagger is one-shot (flag consumed by the builder); archive group starts
// collapsed every session.
const trellisSplit = {
  selectedTaskPath: null,
  // "All projects" mode merges roots: the same taskPath can appear in
  // multiple roots, so selection identity is (path, cwd) — matching on
  // path alone highlights every same-named sibling at once.
  selectedTaskCwd: null,
  archiveOpen: false,
  entryPending: false,
  // Expanded-by-default hierarchy: paths in this set are COLLAPSED.
  collapsedPaths: new Set(),
  // Left-rail PHASE groups (plan/execute/check…) fold here — default OPEN.
  collapsedPhases: new Set(),
  // taskPath -> panel task object (flat, both groups); lets the detail
  // card reopen from selection alone without re-deriving from the tree.
  tasksByPath: new Map(),
  // v7 R10: spec docs and task relations are LEFT-COLUMN GROUPS now
  // (below plan/execute/check/done), each starting collapsed with a
  // lazy first-expand fetch. Right-pane content routes on detailKind.
  specGroupOpen: false,
  networkGroupOpen: false,
  detailKind: "task", // "task" | "spec" | "network"
  networkGroupKey: null, // "v|<parent>" | "s|<relPath>" | "p|<prdPath>"
};

// Embedded detail-card host inside the split right pane. Reassigned by
// buildTrellisSplitDetailPane on every list rebuild; null when no pane.
let trellisSplitDetailHostEl = null;

// Selection-only fast path (09-25 split polish): swap the is-selected
// class between rows and rebuild JUST the right detail pane, leaving the
// left list DOM untouched — no flicker, no scroll jump, no focus loss
// when a right-pane reference re-selects a row. Available only when the
// structural view signature is still current (filter chips, folds,
// archive toggle, list/drawer data changes make it stale on purpose) and
// the live DOM exposes the query APIs (the test sandbox does not, so it
// keeps exercising the full-rebuild path). Returns false when the fast
// path cannot run — callers fall back to the full renderTrellisViewBody().
// Row lookup for post-rebuild selection reveal: mirrors the class-swap
// selection predicate used by renderTrellisSplitSelectionOnly (task /
// spec / network rows, kind-aware) so a structural rebuild scrolls to
// exactly the row the fast path would have highlighted.
// "All projects" merges roots: tasksByPath keys are (taskPath, cwd) so
// same-named tasks from different roots never overwrite each other.
function trellisTaskKey(taskPath, cwd) {
  return `${taskPath}\u0000${cwd || ""}`;
}

// LOCAL-fold visibility (09-25 motion fix, take 3): rows ALWAYS mount now,
// so `querySelectorAll` keeps handing back folded rows — `display:none`
// does not remove a node from the tree. Two class roles, deliberately
// separate (merging them would break either hiding or rotation):
//   - HIDING: `.is-subtree-folded` / `.is-month-folded` on the row,
//     `.is-folded` on the owning phase card (child selector).
//   - ROTATION: `.is-collapsed` on the row (CSS anchor is
//     `.trellis-split-row.is-collapsed .trellis-split-caret`).
// A folded phase card hides by CHILD selector, hence the ancestor walk;
// parentNode is missing on detached/vm-stub nodes, so it is probed.
function isTrellisRowVisible(row) {
  if (!row || !row.classList) return false;
  if (row.classList.contains("is-subtree-folded") || row.classList.contains("is-month-folded")) return false;
  let node = row.parentNode || null;
  while (node) {
    if (node.classList && node.classList.contains("trellis-split-phase-card")
      && node.classList.contains("is-folded")) return false;
    node = node.parentNode || null;
  }
  return true;
}

function visibleTrellisRows(rows) {
  return Array.from(rows || []).filter(isTrellisRowVisible);
}

// Sibling walk for a LOCAL subtree fold (09-25 motion fix, take 3): the
// real Electron DOM hands out an HTMLCollection — `Array.isArray()` is
// ALWAYS false and there is no `indexOf`, which is exactly why the first
// attempt silently fell back to a full tree rebuild (no caret rotation).
// `Array.from()` normalizes both an HTMLCollection and a plain array.
// Returns the rows it touched (classList is the only side effect) so the
// scan stays directly testable with an array-like stub.
function applySubtreeFold(childrenLike, row, folded) {
  const touched = [];
  if (!row) return touched;
  const siblings = Array.from(childrenLike || []);
  const start = siblings.indexOf(row) + 1;
  if (start <= 0) return touched;
  const myDepth = Number(row.dataset.depth || "0");
  for (let k = start; k < siblings.length; k++) {
    const node = siblings[k];
    if (!node || !node.classList || !node.classList.contains("trellis-split-row")) break;
    if (Number(node.dataset.depth || "0") <= myDepth) break;
    node.classList.toggle("is-subtree-folded", folded);
    touched.push(node);
  }
  return touched;
}

// Task-row query shared by the keyboard cursor, Enter activation and the
// post-rebuild focus re-query. Returns [] (never throws) in the vm sandbox.
function readTrellisTaskRows() {
  if (!trellisViewEl || typeof trellisViewEl.querySelectorAll !== "function") return [];
  return trellisViewEl.querySelectorAll(".trellis-split-row[data-task-path]");
}

function findTrellisSelectedRow() {
  if (!trellisViewEl || typeof trellisViewEl.querySelectorAll !== "function") return null;
  for (const row of trellisViewEl.querySelectorAll(".trellis-split-row")) {
    // Folded rows are still mounted: never reveal/scroll/focus one.
    if (!isTrellisRowVisible(row)) continue;
    if (row.dataset.taskPath !== undefined) {
      if (
        trellisSplit.detailKind === "task"
        && row.dataset.taskPath === trellisSplit.selectedTaskPath
        && (row.dataset.taskCwd || "") === (trellisSplit.selectedTaskCwd || "")
      ) return row;
    } else if (row.dataset.specPath !== undefined) {
      if (trellisSplit.detailKind === "spec" && row.dataset.specPath === trellisSpec.selected) return row;
    } else if (row.dataset.networkKey !== undefined) {
      if (trellisSplit.detailKind === "network" && row.dataset.networkKey === trellisSplit.networkGroupKey) return row;
    }
  }
  return null;
}

function renderTrellisSplitSelectionOnly() {
  if (!trellisViewEl || activeView !== "trellis") return false;
  if (typeof trellisViewEl.querySelectorAll !== "function"
    || typeof trellisViewEl.querySelector !== "function") return false;
  if (computeTrellisViewSignature() !== lastTrellisViewSignature) return false;
  const section = trellisViewEl.querySelector(".trellis-split-section");
  const pane = trellisViewEl.querySelector(".trellis-split-detail");
  if (!section || !pane || typeof pane.replaceWith !== "function") return false;

  // 1) Class swap only: task / spec / network rows toggle is-selected,
  // the row nodes themselves are never replaced.
  let targetRow = null;
  for (const row of trellisViewEl.querySelectorAll(".trellis-split-row")) {
    let selected = false;
    if (row.dataset.taskPath !== undefined) {
      selected = trellisSplit.detailKind === "task"
        && row.dataset.taskPath === trellisSplit.selectedTaskPath
        && (row.dataset.taskCwd || "") === (trellisSplit.selectedTaskCwd || "");
    } else if (row.dataset.specPath !== undefined) {
      selected = trellisSplit.detailKind === "spec"
        && row.dataset.specPath === trellisSpec.selected;
    } else if (row.dataset.networkKey !== undefined) {
      selected = trellisSplit.detailKind === "network"
        && row.dataset.networkKey === trellisSplit.networkGroupKey;
    }
    row.classList.toggle("is-selected", selected);
    // Only a VISIBLE row becomes the scroll/focus target — a selected row
    // inside a folded subtree must not steal the focus ring.
    if (selected && isTrellisRowVisible(row)) targetRow = row;
  }

  // 2) Rebuild just the right pane. Same builder as the full path, so
  // buildTrellisDetailCard stays the single source for task cards; the
  // module-level host reference is reassigned with the new pane.
  const task = trellisSplit.detailKind === "task" && trellisSplit.selectedTaskPath
    ? trellisSplit.tasksByPath.get(trellisTaskKey(trellisSplit.selectedTaskPath, trellisSplit.selectedTaskCwd)) || null
    : null;
  pane.replaceWith(buildTrellisSplitDetailPane(task));

  // 3) Reveal + focus the target row: scroll ONLY when it sits outside
  // the list viewport (stable when already visible); focus is scroll-free
  // so viewport alignment stays owned by the scrollIntoView above. Both
  // guarded — sandbox elements carry neither method.
  if (targetRow) {
    const list = section.querySelector(".trellis-split-list");
    const rowRect = typeof targetRow.getBoundingClientRect === "function"
      ? targetRow.getBoundingClientRect() : null;
    const listRect = list && typeof list.getBoundingClientRect === "function"
      ? list.getBoundingClientRect() : null;
    if (rowRect && listRect && (rowRect.top < listRect.top || rowRect.bottom > listRect.bottom)
      && typeof targetRow.scrollIntoView === "function") {
      targetRow.scrollIntoView({ block: "nearest" });
    }
    // Focus only when the keyboard cursor already lives in the split
    // section (keyboard navigation). Clicking a reference in the right
    // pane keeps focus where the user clicked — no focus-ring jump.
    const owner = typeof document !== "undefined" ? document.activeElement : null;
    if (owner && typeof section.contains === "function" && section.contains(owner)
      && typeof targetRow.focus === "function") {
      targetRow.focus({ preventScroll: true });
    }
  }
  return true;
}

function selectTrellisSplitTask(taskPath, taskCwd) {
  const next = typeof taskPath === "string" ? taskPath : null;
  const nextCwd = next === null ? null : typeof taskCwd === "string" ? taskCwd : null;
  // Idempotent re-click: only early-return when the detail card is already
  // showing for this selection (or both are empty). A same-path click with
  // a closed card (fetch failed / closed) must retry the open.
  if (
    next === trellisSplit.selectedTaskPath &&
    nextCwd === trellisSplit.selectedTaskCwd &&
    (next === null ? !(trellisDetail.open || trellisDetail.embedded) : trellisDetail.open)
  ) {
    return;
  }
  trellisSplit.selectedTaskPath = next;
  trellisSplit.selectedTaskCwd = nextCwd;
  trellisSplit.detailKind = "task";
  trellisSplit.networkGroupKey = null;
  // The detail card lifecycle follows the selection: any stale embedded
  // card is reset first, then the selection-only fast path (class swap +
  // pane rebuild, left list DOM untouched) or — when the structure went
  // stale — the full body rebuild re-opens the FULL detail card inside
  // the pane for the new selection (no overlay).
  resetTrellisDetailState();
  if (renderTrellisSplitSelectionOnly()) return;
  lastTrellisPanelSignature = null;
  renderTrellisViewBody();
}

function toggleTrellisSplitArchive() {
  trellisSplit.archiveOpen = !trellisSplit.archiveOpen;
  lastTrellisPanelSignature = null;
  renderTrellisViewBody();
}

// Left-rail phase groups (plan/execute/check…) fold LOCALLY (09-25 motion
// fix): the card stays mounted, only the fold class flips — the caret
// rotates via CSS transition and rows collapse. No tree rebuild, so the
// scroll position and any in-flight CSS transitions survive.
function toggleTrellisSplitPhase(phase) {
  if (trellisSplit.collapsedPhases.has(phase)) trellisSplit.collapsedPhases.delete(phase);
  else trellisSplit.collapsedPhases.add(phase);
  const folded = trellisSplit.collapsedPhases.has(phase);
  // Class-scan instead of a `[data-phase]` attribute selector: the phase
  // ids are a closed set, and the vm sandbox has no CSS.escape.
  const cards = trellisViewEl && typeof trellisViewEl.querySelectorAll === "function"
    ? trellisViewEl.querySelectorAll(".trellis-split-phase-card")
    : [];
  let card = null;
  for (const el of cards) {
    if (el.dataset && el.dataset.phase === phase) card = el;
  }
  if (card) {
    // Row HIDING is the CARD class; caret ROTATION is written on the head
    // AND its toggle button — both are live CSS anchors (dashboard.html
    // .trellis-split-group-head.is-collapsed and
    // .trellis-split-group-toggle.is-collapsed), and the rebuild path
    // writes both too.
    card.classList.toggle("is-folded", folded);
    const writeCaretState = (el) => {
      if (el) el.classList.toggle("is-collapsed", folded);
    };
    if (typeof card.querySelector === "function") {
      writeCaretState(card.querySelector(".trellis-split-group-head"));
    }
    const toggle = typeof card.querySelector === "function"
      ? card.querySelector(".trellis-split-group-toggle")
      : null;
    writeCaretState(toggle);
    if (toggle) toggle.setAttribute("aria-expanded", String(!folded));
    syncTrellisViewSignature();
    return;
  }
  // Card not mounted yet (first render races) — fall back to a rebuild.
  lastTrellisPanelSignature = null;
  renderTrellisViewBody();
}

// Keyboard navigation across the VISIBLE rows in group order — derived
// from the DOM so it can never drift from what is actually rendered.
// Rows are always MOUNTED since the local-fold fix, so "visible" has to be
// computed: folded subtrees, folded months and rows inside a folded phase
// card are skipped (otherwise ↓ selects a display:none row and the list
// looks frozen while the right pane silently swaps).
function moveTrellisSplitSelection(delta) {
  const rows = visibleTrellisRows(readTrellisTaskRows());
  if (rows.length === 0) return;
  const paths = rows.map((r) => r.dataset.taskPath);
  const cwds = rows.map((r) => r.dataset.taskCwd || "");
  const index = paths.findIndex(
    (p, i) => p === trellisSplit.selectedTaskPath && cwds[i] === (trellisSplit.selectedTaskCwd || "")
  );
  const nextIndex = index === -1
    ? (delta > 0 ? 0 : paths.length - 1)
    : Math.min(Math.max(index + delta, 0), paths.length - 1);
  if (paths[nextIndex] !== trellisSplit.selectedTaskPath) {
    selectTrellisSplitTask(paths[nextIndex], cwds[nextIndex]);
    // Focus the newly selected row so the :focus-visible outline tracks
    // the keyboard cursor. On the selection-only fast path the row node
    // is NOT rebuilt and the fast path already focused it (guarded: the
    // test sandbox elements have no focus()); this query re-focuses the
    // node in place after a structural fallback rebuild, and is an
    // idempotent no-op otherwise.
    const focused = visibleTrellisRows(readTrellisTaskRows())[nextIndex] || null;
    if (focused && typeof focused.focus === "function") focused.focus();
  }
}

// Inline SVG icon vocabulary (UI redesign 09-24 Batch C): a small curated
// set of stroke icons replaces the ad-hoc unicode glyphs (▾ ⛓ ↻ ✕) so
// every marker renders identically across platforms and inherits color
// from `currentColor`. Built with pure DOM calls (no innerHTML) so the
// test sandbox's fake document keeps working; when createElementNS is
// unavailable (sandbox), the fallback element still carries the shape
// attributes for assertions.
const TRELLIS_ICON_PATHS = {
  caret: ["m6 9 6 6 6-6"],
  gear: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  ],
  link: [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  ],
  refresh: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
  close: ["M18 6 6 18", "m6 6 12 12"],
};

function iconSvg(name, size = 12) {
  const ns = "http://www.w3.org/2000/svg";
  const make = (tag) => (typeof document.createElementNS === "function"
    ? document.createElementNS(ns, tag)
    : document.createElement(tag));
  const svg = make("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of TRELLIS_ICON_PATHS[name] || []) {
    const path = make("path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  }
  return svg;
}

function buildTrellisSplitRow(task, meta, labels, archived = false) {
  const row = document.createElement("div");
  row.className = "trellis-split-row";
  // Subtree membership for LOCAL folds (09-25): flat rows carry their
  // depth so a fold can walk following siblings without rebuilding.
  row.dataset.depth = String(meta ? meta.depth : 0);
  // Focusable for keyboard navigation only (not in the Tab order): ↑/↓
  // move the selection AND the DOM focus so :focus-visible outlines the
  // keyboard-active row (UI redesign 09-24 Batch B).
  row.setAttribute("tabindex", "-1");
  row.dataset.taskPath = task.taskPath || "";
  row.dataset.taskCwd = task.cwd || "";
  // Mirror the selection-only fast path (renderTrellisSplitSelectionOnly):
  // a task row is only highlighted when the detail kind is actually "task";
  // otherwise a network-group selection would double-highlight after a
  // structural rebuild. Cwd must match too — same path in another root is a
  // DIFFERENT task ("all projects" merges roots with duplicate names).
  if (
    task.taskPath === trellisSplit.selectedTaskPath &&
    (task.cwd || "") === (trellisSplit.selectedTaskCwd || "") &&
    trellisSplit.detailKind === "task"
  ) {
    row.classList.add("is-selected");
  }
  // Archive rows keep their original phase field, so month-group rows
  // pass archived=true explicitly; done-phase actives keep the fallback.
  if (archived || task.phase === "done") row.classList.add("is-archived");
  // Hierarchy cues (v6.1): indent children under their parent; expose
  // hasChildren so a parent row reads as a group head at a glance.
  const depth = meta && Number.isFinite(meta.depth) ? meta.depth : 0;
  if (depth > 0) {
    row.classList.add("is-child");
    row.style.setProperty("--split-depth", String(Math.min(depth, 3)));
  }
  if (meta && meta.hasChildren) {
    row.classList.add("is-parent");
    if (trellisSplit.collapsedPaths.has(task.taskPath)) {
      row.classList.add("is-collapsed");
    }
  }

  // Leading caret slot: 16px for every row (empty for leaves) so dots and
  // titles stay column-aligned between parents and children. The caret is
  // a real button in normal flow — no negative margins pulling it over the
  // row edge.
  const slot = document.createElement("span");
  slot.className = "trellis-split-caret-slot";
  if (meta && meta.hasChildren) {
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "trellis-split-caret";
    // Fold-state mirror for expand/collapse-all LOCAL paths (09-25):
    // hasChildren rides on the row so bulk folds can find group heads.
    row.dataset.hasChildren = "true";
    caret.setAttribute("aria-label", t("dashboardTrellisSplitToggle"));
    caret.setAttribute("aria-expanded", String(!trellisSplit.collapsedPaths.has(task.taskPath)));
    caret.appendChild(iconSvg("caret", 12));
    caret.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const nowFolded = !trellisSplit.collapsedPaths.has(task.taskPath);
      if (nowFolded) trellisSplit.collapsedPaths.add(task.taskPath);
      else trellisSplit.collapsedPaths.delete(task.taskPath);
      // Caret ROTATION anchors on the ROW (dashboard.html:
      // `.trellis-split-row.is-collapsed .trellis-split-caret`); the caret
      // button itself only carries the aria state.
      row.classList.toggle("is-collapsed", nowFolded);
      caret.setAttribute("aria-expanded", String(!nowFolded));
      // LOCAL fold (09-25 motion fix, take 3): walk the parent's children.
      // `parent.children` is an HTMLCollection on the real Electron DOM and
      // applySubtreeFold normalizes it via Array.from. A detached row (vm
      // sandbox) has no parentNode — rebuild there: correct behavior, just
      // without the in-place motion.
      const parent = row.parentNode;
      if (parent && parent.children) {
        applySubtreeFold(parent.children, row, nowFolded);
        syncTrellisViewSignature();
        return;
      }
      lastTrellisPanelSignature = null;
      renderTrellisViewBody();
    });
    slot.appendChild(caret);
  }
  row.appendChild(slot);

  // Three-segment row (noty-ui structure): state dot / main / side.
  const dot = document.createElement("span");
  dot.className = `trellis-split-row-dot is-${task.phase || "plan"}`;
  row.appendChild(dot);

  const main = document.createElement("div");
  main.className = "trellis-split-row-main";
  // Title line: the title owns the full head width (native title tooltip
  // reveals the full name on hover since the ellipsis can hide it).
  const headRow = document.createElement("div");
  headRow.className = "trellis-split-row-head";
  const titleText = task.title || task.taskPath || "?";
  const titleEl = createText("span", "trellis-split-row-title", titleText);
  titleEl.title = titleText;
  headRow.appendChild(titleEl);
  main.appendChild(headRow);
  const subBits = [];
  if (task.sessions && task.sessions.length > 0) {
    subBits.push(t("dashboardTrellisBoundSessions").replace("{n}", String(task.sessions.length)));
  }
  const childCount = meta && meta.hasChildren && Number.isFinite(meta.childCount) ? meta.childCount : null;
  if (meta && meta.hasChildren) {
    subBits.push(t("dashboardTrellisSplitChildren").replace("{n}", String(childCount != null ? childCount : "")));
  }
  // Origin tag: merged "all" view only, and only for rows that belong to
  // a registered root — same semantics and class as the v6 tree rows
  // (trellis-task-project), so disambiguated labels survive the split
  // migration while filtered / session-resolved rows stay untagged.
  // Archived duration + completion date ride the SAME sub line (09-25 R6):
  // one card = one text line — nothing gets a dedicated second row.
  if (task.completedAt || typeof task.completedAtMs === "number") {
    const durationMs = typeof task.durationMs === "number" ? task.durationMs : null;
    subBits.push(formatTrellisArchiveDuration(durationMs));
    const completed = trellisArchiveCompletedLabel(task);
    if (completed) subBits.push(completed);
  }
  // Rides the SUB line (09-25 split polish) so the title keeps its width.
  const originLabel = trellisRowProjectLabel(task, labels);
  // Priority chip (v7 R7) rides the sub line, ahead of the metadata bits:
  // P0/P1 highlight, P2 stays muted. The chip text is the badge itself
  // (locale-independent), the modifier class carries the rank.
  const priority = normalizeTrellisPriority(task.priority);
  if (priority || originLabel || subBits.length > 0) {
    const sub = document.createElement("div");
    sub.className = "trellis-split-row-sub";
    if (priority) {
      const chip = createText("span", `trellis-priority pri-${priority}`, priority.toUpperCase());
      chip.setAttribute("aria-label", t("dashboardTrellisPriority").replace("{p}", priority.toUpperCase()));
      sub.appendChild(chip);
    }
    if (originLabel) {
      sub.appendChild(createText("span", "trellis-task-project", originLabel));
    }
    if (subBits.length > 0) {
      sub.appendChild(createText("span", "trellis-split-row-sub-text", subBits.join(" · ")));
    }
    main.appendChild(sub);
  }
  row.appendChild(main);

  if (task.progress) {
    row.appendChild(createText(
      "span",
      "trellis-split-row-side",
      `${task.progress.done}/${task.progress.total}`
    ));
  }

  row.addEventListener("click", () => {
    selectTrellisSplitTask(task.taskPath, task.cwd);
  });
  row.addEventListener("dblclick", () => {
    // v6.1: full detail renders IN the right pane — no overlay popup.
    selectTrellisSplitTask(task.taskPath, task.cwd);
  });
  return row;
}

// Narrow-window mode (09-25): below the 720px CSS breakpoint the right
// pane is display:none — selections must open the full-screen OVERLAY
// instead of embedding into a hidden host. No matchMedia in the vm test
// sandbox → default to embedded (wide) behavior, tests unaffected.
function trellisUseEmbeddedDetail() {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return !window.matchMedia("(max-width: 720px)").matches;
    }
  } catch { /* sandbox */ }
  return true;
}

function buildTrellisSplitDetailPane(task) {
  const pane = document.createElement("div");
  pane.className = "trellis-split-detail";
  // Module-level host reference: renderTrellisDetail() targets this pane
  // instead of querying the DOM, so the embedded path works in test
  // sandboxes without document.querySelector.
  trellisSplitDetailHostEl = pane;
  // v7 R10: the right pane hosts three content kinds — task detail (the
  // default), a spec document, or a network group. Selection routing is
  // `trellisSplit.detailKind`.
  if (trellisSplit.detailKind === "spec" && trellisSpec.selected) {
    pane.appendChild(buildTrellisSpecDocContent(trellisSpec.selected));
    return pane;
  }
  if (trellisSplit.detailKind === "network" && trellisSplit.networkGroupKey) {
    pane.appendChild(buildTrellisNetworkGroupContent(trellisSplit.networkGroupKey));
    return pane;
  }
  if (!task) {
    // Empty state: oversized state-dot + guide text (noty-ui flavor).
    const empty = document.createElement("div");
    empty.className = "trellis-split-detail-empty";
    const orb = document.createElement("span");
    orb.className = "trellis-split-empty-orb";
    empty.appendChild(orb);
    empty.appendChild(createText("p", "trellis-split-empty-text", t("dashboardTrellisSplitEmpty")));
    pane.appendChild(empty);
    return pane;
  }
  // The pane is a plain HOST: the full detail card (same component the
  // overlay uses) is injected here via renderTrellisDetail(). Two cases:
  //  1. selection matches an open embedded card (rebuild during fetch):
  //     synchronously inline the card so the rebuild doesn't blank it.
  //  2. otherwise (fresh selection just set it): openTrellisDetail will
  //     render into this host on its first renderTrellisDetail() pass.
  const embeddedMode = trellisUseEmbeddedDetail();
  if (
    embeddedMode &&
    trellisDetail.open &&
    trellisDetail.embedded &&
    trellisDetail.request &&
    trellisDetail.request.taskPath === task.taskPath
  ) {
    pane.appendChild(buildTrellisDetailCard());
  } else {
    // Narrow window forces overlay mode: the embedded host is hidden by
    // CSS and an inline card would be invisible.
    void openTrellisDetail(task, { embedded: embeddedMode });
  }
  return pane;
}


// ↻ archive refresh button (v7 R3): migrates the retired archive section's
// reload entry into the split list's DONE group head. stopPropagation keeps
// the group-toggle handler out of the click.
function buildTrellisSplitRefreshBtn() {
  // Global refresh (09-25): refreshes roots + active + archive at once.
  // Lives in the filter chip bar next to 管理 — a view-wide affordance
  // does not belong to the archive head alone.
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "trellis-filter-refresh";
  refresh.appendChild(iconSvg("refresh", 14));
  refresh.title = t("dashboardTrellisRefreshAll");
  refresh.setAttribute("aria-label", t("dashboardTrellisRefreshAll"));
  refresh.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // Spin feedback only when a real timer exists (vm test sandbox has
    // none — the refresh itself still runs).
    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      refresh.classList.add("is-spinning");
      window.setTimeout(() => refresh.classList.remove("is-spinning"), 600);
    }
    void refreshTrellisView();
  });
  return refresh;
}

function buildTrellisSplitSection(activeTasks, archiveTasks) {
  const section = document.createElement("div");
  section.className = "trellis-view-section trellis-split-section";
  if (trellisSplit.entryPending) {
    section.classList.add("is-entering");
    trellisSplit.entryPending = false;
  }

  let selectedTask = null;
  // v6.1: hierarchy info for the master list — depth / hasChildren come
  // from the same pure grouping fn the tree view uses. Only ACTIVE tasks
  // nest (archived children render flat, matching archive design).
  // v6.1: real hierarchy — subtasks nest under their parent with a
  // click-to-expand caret. Roots are bucketed by phase; each root keeps
  // its whole subtree (a contiguous DFS slice) so expanding reveals all
  // descendants in order. Archive rows keep hierarchy too.
  const rootsByPhase = (rows, forcedPhase) => {
    const map = new Map();
    let i = 0;
    while (i < rows.length) {
      const rootDepth = rows[i].depth;
      let end = i + 1;
      while (end < rows.length && rows[end].depth > rootDepth) end += 1;
      // Archive rows ALWAYS bucket to "done" regardless of their phase
      // field (archiving is a status, not a phase transition).
      const phase = forcedPhase || rows[i].task.phase || "plan";
      if (!map.has(phase)) map.set(phase, []);
      map.get(phase).push(rows.slice(i, end));
      i = end;
    }
    return map;
  };
  // Cross-list parenting (v6 tree semantics): an ARCHIVED task whose
  // parent is still ACTIVE renders greyed under the live parent instead
  // of the archive months. Base names are the join key, same as the
  // panel's grouping fn.
  const nameOf = (p) => String(p || "").split("/").filter(Boolean).pop() || p;
  const activeNames = new Set(activeTasks.map((task) => nameOf(task.taskPath)));
  const adoptedKids = [];
  const keptArchive = [];
  for (const task of archiveTasks) {
    const parent = task.parent && task.parent.trim();
    if (parent && activeNames.has(parent)) adoptedKids.push({ ...task, crossList: true });
    else keptArchive.push(task);
  }
  const activeRoots = rootsByPhase(groupTrellisTasks([...activeTasks, ...adoptedKids]));
  const archiveRoots = rootsByPhase(groupTrellisTasks(keptArchive), "done");

  // Origin labels for the merged "all" view: same disambiguating
  // per-root labels the v6 tree rows used (trellisRowProjectLabel below
  // consumes them; scoped view returns null and rows stay untagged).
  const splitLabels = buildTrellisRootLabels(trellisView.roots);

  const listPane = document.createElement("div");
  listPane.className = "trellis-split-list";
  // All parent taskPaths in the current dataset (v7 R4): drives the
  // expand-all / collapse-all buttons in the foot bar. Roots are appended
  // by the group loop below.
  const parentPaths = [];
  const groups = [
    { phase: "plan", labelKey: "dashboardTrellisPhasePlan" },
    { phase: "execute", labelKey: "dashboardTrellisPhaseExecute" },
    { phase: "check", labelKey: "dashboardTrellisPhaseCheck" },
    { phase: "finish", labelKey: "dashboardTrellisPhaseFinish" },
    { phase: "done", labelKey: "dashboardTrellisPhaseArchived" },
  ];
  let groupIndex = 0;
  let activeCount = 0;
  let archiveCount = 0;
  trellisSplit.tasksByPath.clear();

  // Render rows[startIdx..] while depth > rootDepth; returns next index.
  // Descendants render only when every ancestor above them is expanded.
  // Per-group card container (09-25 apple-design R7): each phase section
  // (plan/execute/check/archive) is one CARD — the head and all task rows
  // live inside it, so the section reads as a single object instead of a
  // floating divider above disconnected rows. renderSubtree appends into
  // the CURRENT group container.
  let groupEl = listPane;
  const renderSubtree = (subtree, startIdx, rootDepth, ancestorsExpanded, archived = false, monthOpen = true, monthRowsSink = null) => {
    let i = startIdx;
    while (i < subtree.length && subtree[i].depth > rootDepth) {
      const rowMeta = subtree[i];
      {
        // Rows ALWAYS mount (09-25 motion fix): subtree folds hide via a
        // class on the row so fold/unfold animates without a rebuild.
        trellisSplit.tasksByPath.set(trellisTaskKey(rowMeta.task.taskPath, rowMeta.task.cwd), rowMeta.task);
        if (
          rowMeta.task.taskPath === trellisSplit.selectedTaskPath
          && (rowMeta.task.cwd || "") === (trellisSplit.selectedTaskCwd || "")
        ) selectedTask = rowMeta.task;
        const childRow = buildTrellisSplitRow(rowMeta.task, rowMeta, splitLabels, archived);
        if (!ancestorsExpanded) childRow.classList.add("is-subtree-folded");
        if (!monthOpen) childRow.classList.add("is-month-folded");
        if (monthRowsSink) monthRowsSink.push(childRow);
        groupEl.appendChild(childRow);
      }
      if (rowMeta.hasChildren) parentPaths.push(rowMeta.task.taskPath);
      i = renderSubtree(
        subtree,
        i + 1,
        subtree[i].depth,
        ancestorsExpanded && !trellisSplit.collapsedPaths.has(rowMeta.task.taskPath),
        archived,
        monthOpen,
        monthRowsSink
      );
    }
    return i;
  };

  for (const group of groups) {
    // Section = one card (R7): head + rows share a bordered surface, the
    // same visual family as session/task cards — one layer, inherited UI.
    groupEl = document.createElement("section");
    groupEl.className = "trellis-split-phase-card";
    groupEl.dataset.phase = group.phase;
    const subtrees = (group.phase === "done" ? archiveRoots : activeRoots).get(group.phase) || [];
    if (group.phase === "done") {
      for (const subtree of subtrees) archiveCount += subtree.length;
    } else {
      activeCount += subtrees.length;
    }
    // finish (completed-but-unarchived) is practically always empty in
    // this repo's flow — a permanently empty placeholder reads as noise.
    if (group.phase === "finish" && subtrees.length === 0) continue;
    // Same for an EMPTY archive (R7): no archived roots and nothing to
    // say (no fetch error/loading) → skip the card entirely instead of
    // appending an empty bordered placeholder.
    if (group.phase === "done" && subtrees.length === 0
      && !trellisView.archive.error && !trellisView.archive.loading) {
      continue;
    }
    if (group.phase === "done" && !trellisSplit.archiveOpen && subtrees.length > 0) {
      const collapsedHead = document.createElement("div");
      // `is-collapsed` stays on the HEAD (v7 contract: tests + CSS target
      // the group head, not the inner toggle button). The click/keyboard
      // handler lives on the toggle BUTTON (UI redesign 09-24 Batch B):
      // a real button carries focus, :focus-visible and :active for free;
      // stopPropagation keeps the click from reaching the head.
      collapsedHead.className = "trellis-split-group-head is-collapsed";
      collapsedHead.style.setProperty("--split-group-index", String(groupIndex));
      const collapsedToggle = document.createElement("button");
      collapsedToggle.type = "button";
      collapsedToggle.className = "trellis-split-group-toggle is-collapsed";
      collapsedToggle.setAttribute("aria-expanded", "false");
      const collapsedCaret = document.createElement("span");
      collapsedCaret.className = "trellis-split-group-caret";
      collapsedCaret.appendChild(iconSvg("caret", 12));
      collapsedToggle.appendChild(collapsedCaret);
      collapsedToggle.appendChild(createText("span", "trellis-split-group-title", t(group.labelKey)));
      collapsedToggle.appendChild(createText("span", "trellis-split-group-count", String(subtrees.length)));
      collapsedToggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleTrellisSplitArchive();
      });
      collapsedHead.appendChild(collapsedToggle);
      groupEl.appendChild(collapsedHead);
      listPane.appendChild(groupEl);
      groupIndex += 1;
      continue;
    }
    // Render the head when there are roots OR the list state still has
    // something to say (done-list fetch failure needs the error hint +
    // retry even with zero rows).
    const doneListSpeaks = group.phase === "done"
      && (trellisView.archive.error || trellisView.archive.loading);
    if (subtrees.length > 0 || group.phase !== "done" || doneListSpeaks) {
      const head = document.createElement("div");
      head.className = "trellis-split-group-head";
      head.style.setProperty("--split-group-index", String(groupIndex));
      let headToggle = head;
      if (group.phase === "done" && trellisSplit.archiveOpen) {
        // Same rule as the collapsed head: the handler sits on the toggle
        // button; title/count ride inside it so the whole label is the
        // click target (stopPropagation keeps the head out of it).
        headToggle = document.createElement("button");
        headToggle.type = "button";
        headToggle.className = "trellis-split-group-toggle";
        headToggle.setAttribute("aria-expanded", "true");
        const openCaret = document.createElement("span");
        openCaret.className = "trellis-split-group-caret";
        openCaret.appendChild(iconSvg("caret", 12));
        headToggle.appendChild(openCaret);
        headToggle.addEventListener("click", (ev) => {
          ev.stopPropagation();
          toggleTrellisSplitArchive();
        });
        head.appendChild(headToggle);
      } else if (group.phase !== "done") {
        // Non-done phase groups fold too (09-25 apple-design R6): default
        // open, caret rotates, whole label is the click target — same
        // affordance as the archive head, one layer, no boxed controls.
        const phaseCollapsed = trellisSplit.collapsedPhases.has(group.phase);
        if (phaseCollapsed) head.classList.add("is-collapsed");
        headToggle = document.createElement("button");
        headToggle.type = "button";
        headToggle.className = "trellis-split-group-toggle";
        if (phaseCollapsed) headToggle.classList.add("is-collapsed");
        headToggle.setAttribute("aria-expanded", phaseCollapsed ? "false" : "true");
        const phaseCaret = document.createElement("span");
        phaseCaret.className = "trellis-split-group-caret";
        phaseCaret.appendChild(iconSvg("caret", 12));
        headToggle.appendChild(phaseCaret);
        headToggle.addEventListener("click", (ev) => {
          ev.stopPropagation();
          toggleTrellisSplitPhase(group.phase);
        });
        head.appendChild(headToggle);
      }
      headToggle.appendChild(createText("span", "trellis-split-group-title", t(group.labelKey)));
      if (subtrees.length > 0) {
        // Group count shows ROOT tasks — children live behind carets.
        headToggle.appendChild(createText("span", "trellis-split-group-count", String(subtrees.length)));
      }
      if (group.phase === "done") {
        // Error / loading hints next to the (now global) refresh button
        // that lives in the chip bar (v7 R3, migrated from the retired
        // archive section).
        const archiveState = trellisView.archive;
        if (archiveState.error) {
          head.appendChild(createText("span", "trellis-split-archive-hint is-error", t("dashboardTrellisArchivedError")));
          const archiveRetry = document.createElement("button");
          archiveRetry.type = "button";
          archiveRetry.className = "trellis-split-retry";
          archiveRetry.textContent = t("dashboardTrellisArchivedRetry");
          archiveRetry.addEventListener("click", (ev) => {
            ev.stopPropagation();
            void refreshTrellisViewArchive();
          });
          head.appendChild(archiveRetry);
        } else if (archiveState.loading) {
          head.appendChild(createText("span", "trellis-split-archive-hint", t("dashboardTrellisArchivedLoading")));
        }
      } else if (trellisView.active.error) {
        // Active-list fetch failure: inline hint + retry button (v7 R3
        // parity with the archive tools; both refetch via the module
        // loaders, not a raw render).
        head.appendChild(createText("span", "trellis-split-archive-hint is-error", t("dashboardTrellisActiveError")));
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "trellis-split-retry";
        retry.textContent = t("dashboardTrellisActiveRetry");
        retry.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void refreshTrellisActive();
        });
        head.appendChild(retry);
      }
      groupEl.appendChild(head);
    }
    if (group.phase === "done" && trellisSplit.archiveOpen) {
      // Month sub-groups inside the archive (v7 R3): roots bucket by
      // completed-at month (trellisArchiveMonthOf), each month folds
      // independently via archive state openMonths (null = all open).
      const byMonth = new Map();
      for (const subtree of subtrees) {
        const month = trellisArchiveMonthOf(subtree[0].task.taskPath);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push(subtree);
      }
      const months = [...byMonth.keys()].sort().reverse();
      for (const month of months) {
        const monthOpen = trellisView.archive.openMonths === null
          || trellisView.archive.openMonths.has(month);
        const monthHead = document.createElement("div");
        // Same contract as the phase-group heads (Batch B): the fold
        // handler and aria-expanded live on the inner toggle button;
        // `is-collapsed` stays on the head for CSS + tests. The caret is
        // an SVG that rotates via CSS — no glyph flipping in JS.
        monthHead.className = "trellis-split-month-head" + (monthOpen ? "" : " is-collapsed");
        const monthToggle = document.createElement("button");
        monthToggle.type = "button";
        monthToggle.className = "trellis-split-month-toggle";
        monthToggle.setAttribute("aria-expanded", String(monthOpen));
        const monthCaret = document.createElement("span");
        // Same bare caret class as phase heads (R7 alignment): the old
        // bordered 15px toggle box read as a different control family.
        monthCaret.className = "trellis-split-group-caret";
        monthCaret.appendChild(iconSvg("caret", 12));
        monthToggle.appendChild(monthCaret);
        monthToggle.appendChild(createText(
          "span",
          "trellis-split-month-label",
          month || t("dashboardTrellisArchivedUnknownMonth")
        ));
        // Count pill reuses the phase-head count class — dates inherit the
        // exact same anatomy (auto-right pill) as 计划/执行/检查 heads.
        monthToggle.appendChild(createText(
          "span",
          "trellis-split-group-count",
          String(byMonth.get(month).length)
        ));
        monthToggle.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const state = trellisView.archive;
          if (state.openMonths === null) state.openMonths = new Set(months);
          if (state.openMonths.has(month)) {
            state.openMonths.delete(month);
          } else {
            state.openMonths.add(month);
          }
          // LOCAL fold (09-25 motion fix): flip classes on the collected
          // rows — caret rotates via CSS transition, rows collapse. No
          // rebuild, no sibling-walk (sandbox-safe).
          const open = state.openMonths.has(month);
          monthHead.classList.toggle("is-collapsed", !open);
          monthToggle.setAttribute("aria-expanded", String(open));
          for (const r of monthRows) r.classList.toggle("is-month-folded", !open);
          syncTrellisViewSignature();
        });
        monthHead.appendChild(monthToggle);
        // 09-25 motion fix, sandbox-safe: collect THIS month's rows in a
        // closure at build time — no nextElementSibling walk (the vm test
        // DOM lacks it). The array dies with this DOM generation; the next
        // rebuild re-collects.
        const monthRows = [];
        groupEl.appendChild(monthHead);
        for (const subtree of byMonth.get(month)) {
          const rootMeta = subtree[0];
          trellisSplit.tasksByPath.set(trellisTaskKey(rootMeta.task.taskPath, rootMeta.task.cwd), rootMeta.task);
          if (rootMeta.task.taskPath === trellisSplit.selectedTaskPath && (rootMeta.task.cwd || "") === (trellisSplit.selectedTaskCwd || "")) selectedTask = rootMeta.task;
          const row = buildTrellisSplitRow(rootMeta.task, rootMeta, splitLabels, true);
          if (!monthOpen) row.classList.add("is-month-folded");
          monthRows.push(row);
          groupEl.appendChild(row);
          if (rootMeta.hasChildren) parentPaths.push(rootMeta.task.taskPath);
          // Archive sub-rows follow the SAME collapsedPaths contract as the
          // active branch: passing a constant `true` leaked the direct
          // children of a folded archive root back into view after any
          // rebuild (poll / chip switch / refresh) while deeper rows stayed
          // hidden (09-25 review).
          renderSubtree(
            subtree,
            1,
            rootMeta.depth,
            !trellisSplit.collapsedPaths.has(rootMeta.task.taskPath),
            true,
            monthOpen,
            monthRows
          );
        }
      }
      listPane.appendChild(groupEl);
      groupIndex += 1;
      continue;
    }
    if (group.phase !== "done" && trellisSplit.collapsedPhases.has(group.phase)) {
      // Folded phase card (09-25 motion fix): rows still RENDER (display
      // controlled by .is-folded on the card) so the fold can animate on
      // class toggle without a tree rebuild; keyboard nav map stays hot.
      groupEl.classList.add("is-folded");
    }
    for (const subtree of subtrees) {
      const rootMeta = subtree[0];
      trellisSplit.tasksByPath.set(trellisTaskKey(rootMeta.task.taskPath, rootMeta.task.cwd), rootMeta.task);
      if (rootMeta.task.taskPath === trellisSplit.selectedTaskPath && (rootMeta.task.cwd || "") === (trellisSplit.selectedTaskCwd || "")) selectedTask = rootMeta.task;
      groupEl.appendChild(buildTrellisSplitRow(rootMeta.task, rootMeta, splitLabels));
      if (rootMeta.hasChildren) parentPaths.push(rootMeta.task.taskPath);
      renderSubtree(subtree, 1, rootMeta.depth, !trellisSplit.collapsedPaths.has(rootMeta.task.taskPath));
    }
    listPane.appendChild(groupEl);
    groupIndex += 1;
  }

  // (09-25) The empty-state hint texts are RETIRED — the phase cards'
  // own heads + counts already communicate emptiness; a free-floating
  // "no active tasks" line read as clutter and collided with the archive
  // card's sticky head on expand.
  // (09-25 review) The reveal-on-expand hook (`pendingPhaseReveal`) went
  // with it: folds are LOCAL now (no rebuild → no scroll loss), and
  // renderTrellisView already saves/restores `.trellis-split-list`
  // scrollTop across the rebuilds that remain.
  const foot = document.createElement("div");
  foot.className = "trellis-split-foot";
  foot.appendChild(createText(
    "span",
    "trellis-split-foot-stat",
    t("dashboardTrellisSplitStat")
      .replace("{active}", String(activeCount))
      .replace("{archive}", String(archiveCount))
  ));
  const footTools = document.createElement("span");
  footTools.className = "trellis-split-foot-tools";
  const expandAll = document.createElement("button");
  expandAll.type = "button";
  expandAll.className = "trellis-split-foot-btn";
  expandAll.textContent = t("dashboardTrellisTreeExpandAll");
  expandAll.title = t("dashboardTrellisTreeExpandAll");
  expandAll.addEventListener("click", () => {
    trellisSplit.collapsedPaths.clear();
    // LOCAL unfold (09-25 motion fix): flip classes on mounted rows — no
    // rebuild, so carets rotate and rows come back in place. Row HIDING
    // (`.is-subtree-folded`) and caret ROTATION (`.is-collapsed` on the
    // row) are SEPARATE classes; both must clear or the caret keeps
    // pointing at the folded state after expand-all.
    if (trellisViewEl && typeof trellisViewEl.querySelectorAll === "function") {
      for (const row of trellisViewEl.querySelectorAll(".trellis-split-row")) {
        row.classList.remove("is-subtree-folded");
        if (row.dataset.hasChildren !== "true") continue;
        row.classList.remove("is-collapsed");
        const caret = typeof row.querySelector === "function"
          ? row.querySelector(".trellis-split-caret")
          : null;
        if (caret) caret.setAttribute("aria-expanded", "true");
      }
      syncTrellisViewSignature();
      return;
    }
    lastTrellisPanelSignature = null;
    renderTrellisViewBody();
  });
  footTools.appendChild(expandAll);
  const collapseAll = document.createElement("button");
  collapseAll.type = "button";
  collapseAll.className = "trellis-split-foot-btn";
  collapseAll.textContent = t("dashboardTrellisTreeCollapseAll");
  collapseAll.title = t("dashboardTrellisTreeCollapseAll");
  collapseAll.addEventListener("click", () => {
    for (const p of parentPaths) trellisSplit.collapsedPaths.add(p);
    // LOCAL fold (09-25 motion fix): row HIDING = `.is-subtree-folded` on
    // every nested row; caret ROTATION = `.is-collapsed` on the parent rows
    // themselves (CSS anchors the rotation on the row, not the caret).
    if (trellisViewEl && typeof trellisViewEl.querySelectorAll === "function") {
      for (const row of trellisViewEl.querySelectorAll(".trellis-split-row")) {
        if (Number(row.dataset.depth || "0") > 0) row.classList.add("is-subtree-folded");
        if (row.dataset.hasChildren !== "true") continue;
        row.classList.add("is-collapsed");
        const caret = typeof row.querySelector === "function"
          ? row.querySelector(".trellis-split-caret")
          : null;
        if (caret) caret.setAttribute("aria-expanded", "false");
      }
      syncTrellisViewSignature();
      return;
    }
    lastTrellisPanelSignature = null;
    renderTrellisViewBody();
  });
  footTools.appendChild(collapseAll);
  foot.appendChild(footTools);
  listPane.appendChild(foot);

  // v7 R10: spec docs and task relations as left-column groups below the
  // phase groups — same head anatomy, collapsed by default, first expand
  // triggers the one-shot fetch. Wrapped in phase CARDS (R7) so every
  // left-rail section shares one card family.
  const specCard = document.createElement("section");
  specCard.className = "trellis-split-phase-card";
  specCard.appendChild(buildTrellisSpecListGroup());
  listPane.appendChild(specCard);
  const networkCard = document.createElement("section");
  networkCard.className = "trellis-split-phase-card";
  networkCard.appendChild(buildTrellisNetworkListGroup());
  listPane.appendChild(networkCard);

  section.appendChild(listPane);

  // Draggable left-rail width (09-25 polish): pointer-capture resize,
  // clamped 240–480px, persisted to localStorage. The 1s rebuild recreates
  // listPane, so applyPersistedTrellisSplitWidth re-applies the width at
  // the top of this builder (see below).
  const resizer = document.createElement("div");
  resizer.className = "trellis-split-resizer";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    try { resizer.setPointerCapture(ev.pointerId); } catch { /* jsdom */ }
    const startWidth = listPane.getBoundingClientRect().width;
    const startX = ev.clientX;
    const onMove = (e) => {
      const w = Math.min(480, Math.max(240, startWidth + e.clientX - startX));
      listPane.style.flexBasis = `${w}px`;
    };
    const onUp = () => {
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      resizer.removeEventListener("pointercancel", onUp);
      try {
        const w = listPane.getBoundingClientRect().width;
        if (typeof localStorage !== "undefined" && w >= 240 && w <= 480) {
          localStorage.setItem("clawd.trellisSplitListWidth", String(Math.round(w)));
        }
      } catch { /* storage unavailable */ }
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
  });
  section.appendChild(resizer);
  applyPersistedTrellisSplitWidth(listPane);

  // Selection may point at a task that filters just removed — show the
  // empty pane rather than a stale card.
  section.appendChild(buildTrellisSplitDetailPane(selectedTask));
  return section;
}

// Restores the persisted left-rail width (no-op without localStorage,
// e.g. the vm sandbox in tests — flex clamp in CSS remains the default).
function applyPersistedTrellisSplitWidth(listPane) {
  try {
    if (typeof localStorage === "undefined") return;
    const v = Number(localStorage.getItem("clawd.trellisSplitListWidth"));
    if (Number.isFinite(v) && v >= 240 && v <= 480) listPane.style.flexBasis = `${v}px`;
  } catch { /* storage unavailable */ }
}

// ── v7 R10: spec list group (left column, below DONE) ──
// The project scope the spec/relations groups follow: the selected chip,
// or the first registered root in the merged "all" view.
function currentTrellisScopeRoot() {
  return trellisView.selectedRoot || trellisView.roots[0] || null;
}

// Reset the spec group for a (possibly new) scope root and refetch. Used
// both by the first expand and by scope switches while it stays open.
function refetchTrellisSpecForScope() {
  const root = currentTrellisScopeRoot();
  if (!root) return;
  trellisSpec.open = true;
  trellisSpec.loading = true;
  trellisSpec.seq += 1;
  trellisSpec.root = root;
  trellisSpec.files = [];
  trellisSpec.truncated = false;
  trellisSpec.selected = null;
  trellisSpecDocs.clear();
  lastTrellisSpecSignature = null;
  void fetchTrellisSpecTree(root);
}

function refetchTrellisNetworkForScope() {
  const root = currentTrellisScopeRoot();
  if (!root) return;
  trellisNetwork.open = true;
  trellisNetwork.loading = true;
  trellisNetwork.seq += 1;
  trellisNetwork.root = root;
  trellisNetwork.result = null;
  lastTrellisNetworkSignature = null;
  void fetchTrellisNetworkOverview();
}

// v7 R10fix: the two extra groups follow the project filter. A rebuild
// with a changed scope (chip click, root unregister fallback) resets the
// cached content and refetches while the group stays expanded — otherwise
// every project would keep showing the first-loaded root's data.
function syncTrellisPanelScopes() {
  const root = currentTrellisScopeRoot();
  if (!root) return;
  if (trellisSplit.specGroupOpen && trellisSpec.open && trellisSpec.root !== root
    && !trellisSpec.loading) {
    refetchTrellisSpecForScope();
  }
  if (trellisSplit.networkGroupOpen && trellisNetwork.open && trellisNetwork.root !== root
    && !trellisNetwork.loading) {
    refetchTrellisNetworkForScope();
  }
}

function toggleTrellisSpecGroup() {
  trellisSplit.specGroupOpen = !trellisSplit.specGroupOpen;
  lastTrellisPanelSignature = null;
  if (trellisSplit.specGroupOpen && !trellisSpec.loading
    && (trellisSpec.root === null || trellisSpec.files.length === 0)) {
    // First expand (or a previously empty scope): lazy-load the tree.
    refetchTrellisSpecForScope();
  }
  renderTrellisViewBody();
}

function toggleTrellisNetworkGroup() {
  trellisSplit.networkGroupOpen = !trellisSplit.networkGroupOpen;
  lastTrellisPanelSignature = null;
  if (trellisSplit.networkGroupOpen && !trellisNetwork.loading
    && (trellisNetwork.root === null || !trellisNetwork.result)) {
    refetchTrellisNetworkForScope();
  }
  renderTrellisViewBody();
}

function buildTrellisSpecListGroup() {
  // The head is a real <button> (UI redesign 09-24 Batch B): same class
  // contract (head + toggle double class), native focus/keyboard support.
  const head = document.createElement("button");
  head.type = "button";
  head.className = "trellis-split-group-head trellis-split-group-toggle"
    + (trellisSplit.specGroupOpen ? "" : " is-collapsed");
  head.setAttribute("aria-expanded", trellisSplit.specGroupOpen ? "true" : "false");
  const specCaret = document.createElement("span");
  specCaret.className = "trellis-split-group-caret";
  specCaret.appendChild(iconSvg("caret", 12));
  head.appendChild(specCaret);
  head.appendChild(createText("span", "trellis-split-group-title", t("dashboardTrellisSpecGroup")));
  const files = trellisSpec.open ? trellisSpec.files : [];
  if (!trellisSpec.loading && files.length > 0) {
    head.appendChild(createText("span", "trellis-split-group-count", String(files.length)));
  }
  head.addEventListener("click", toggleTrellisSpecGroup);
  const wrap = document.createElement("div");
  wrap.className = "trellis-split-group trellis-spec-group";
  wrap.appendChild(head);
  if (!trellisSplit.specGroupOpen) {
    return wrap;
  }
  if (trellisSpec.loading) {
    wrap.appendChild(createText("div", "trellis-split-archive-hint", t("dashboardTrellisArchivedLoading")));
    return wrap;
  }
  if (trellisSpec.error || (!trellisSpec.truncated && files.length === 0 && trellisSpec.open)) {
    wrap.appendChild(createText("div", "trellis-split-archive-hint", t("dashboardTrellisSpecEmpty")));
    return wrap;
  }
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "trellis-split-row trellis-spec-row";
    if (file.relPath === trellisSpec.selected && trellisSplit.detailKind === "spec") {
      row.classList.add("is-selected");
    }
    if (file.filled === false) row.classList.add("is-empty-spec");
    row.dataset.specPath = file.relPath;
    const main = document.createElement("div");
    main.className = "trellis-split-row-main";
    const specTitle = createText("span", "trellis-split-row-title", file.relPath);
    specTitle.title = file.relPath;
    main.appendChild(specTitle);
    const side = document.createElement("div");
    side.className = "trellis-split-row-side trellis-spec-row-side";
    if (file.filled === false) {
      side.appendChild(createText("span", "trellis-spec-file-empty", t("dashboardTrellisSpecEmptyDoc")));
    } else if (typeof file.lines === "number" && file.lines > 0) {
      side.appendChild(createText(
        "span",
        "trellis-spec-file-lines",
        t("dashboardTrellisSpecLines").replace("{n}", String(file.lines))
      ));
    }
    if (file.refCount > 0) {
      const refs = document.createElement("span");
      refs.className = "trellis-spec-file-refs";
      refs.appendChild(iconSvg("link", 12));
      refs.appendChild(document.createTextNode(String(file.refCount)));
      refs.setAttribute("title", t("dashboardTrellisSpecRefs").replace("{n}", String(file.refCount)));
      side.appendChild(refs);
    }
    row.appendChild(main);
    row.appendChild(side);
    row.addEventListener("click", () => {
      trellisSplit.detailKind = "spec";
      selectTrellisSpecDoc(file.relPath);
    });
    wrap.appendChild(row);
  }
  if (trellisSpec.truncated) {
    wrap.appendChild(createText("div", "trellis-split-archive-hint", t("dashboardTrellisArchivedTruncated")));
  }
  return wrap;
}

// ── v7 R10: network relations group (left column, below spec) ──
function trellisNetworkGroups() {
  const result = trellisNetwork.result;
  if (!result || result.status !== "ok") return [];
  const groups = [];
  const edges = Array.isArray(result.edges) ? result.edges : [];
  const byParent = new Map();
  for (const edge of edges) {
    if (!byParent.has(edge.parentTaskPath)) byParent.set(edge.parentTaskPath, []);
    byParent.get(edge.parentTaskPath).push(edge.childTaskPath);
  }
  const nodeByTaskPath = new Map(
    (Array.isArray(result.nodes) ? result.nodes : []).map((n) => [n.taskPath, n])
  );
  const refOf = (taskPath) => {
    const node = nodeByTaskPath.get(taskPath);
    return node
      ? { taskPath, title: node.title, archived: node.archived }
      : { taskPath, title: taskPath, archived: String(taskPath).includes("/archive/"), missing: true };
  };
  for (const [parentTaskPath, children] of [...byParent.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    groups.push({
      key: `v|${parentTaskPath}`,
      label: t("dashboardTrellisLinksChildren").replace("{n}", String(children.length)),
      sub: parentTaskPath || t("dashboardTrellisLinksMissing"),
      members: [
        ...(parentTaskPath ? [refOf(parentTaskPath)] : []),
        ...children.map(refOf),
      ],
    });
  }
  for (const group of Array.isArray(result.specGroups) ? result.specGroups : []) {
    groups.push({
      key: `s|${group.specPath}`,
      label: t("dashboardTrellisLinksSharedSpec"),
      sub: group.specPath,
      members: group.tasks.slice(),
    });
  }
  for (const group of Array.isArray(result.prdGroups) ? result.prdGroups : []) {
    groups.push({
      key: `p|${group.prdPath}`,
      label: t("dashboardTrellisLinksSharedPrd"),
      sub: group.prdPath,
      members: [group.owner, ...group.tasks],
    });
  }
  return groups;
}

function buildTrellisNetworkListGroup() {
  // Real <button> head, same class contract as the spec group above.
  const head = document.createElement("button");
  head.type = "button";
  head.className = "trellis-split-group-head trellis-split-group-toggle"
    + (trellisSplit.networkGroupOpen ? "" : " is-collapsed");
  head.setAttribute("aria-expanded", trellisSplit.networkGroupOpen ? "true" : "false");
  const networkCaret = document.createElement("span");
  networkCaret.className = "trellis-split-group-caret";
  networkCaret.appendChild(iconSvg("caret", 12));
  head.appendChild(networkCaret);
  head.appendChild(createText("span", "trellis-split-group-title", t("dashboardTrellisLinksGroup")));
  const groups = trellisNetwork.open ? trellisNetworkGroups() : [];
  if (!trellisNetwork.loading && groups.length > 0) {
    head.appendChild(createText("span", "trellis-split-group-count", String(groups.length)));
  }
  head.addEventListener("click", toggleTrellisNetworkGroup);
  const wrap = document.createElement("div");
  wrap.className = "trellis-split-group trellis-network-group-list";
  wrap.appendChild(head);
  if (!trellisSplit.networkGroupOpen) {
    return wrap;
  }
  if (trellisNetwork.loading) {
    wrap.appendChild(createText("div", "trellis-split-archive-hint", t("dashboardTrellisArchivedLoading")));
    return wrap;
  }
  if (groups.length === 0) {
    wrap.appendChild(createText("div", "trellis-split-archive-hint", t("dashboardTrellisLinksEmpty")));
    return wrap;
  }
  for (const group of groups) {
    const row = document.createElement("div");
    row.className = "trellis-split-row trellis-network-row";
    if (group.key === trellisSplit.networkGroupKey && trellisSplit.detailKind === "network") {
      row.classList.add("is-selected");
    }
    row.dataset.networkKey = group.key;
    const main = document.createElement("div");
    main.className = "trellis-split-row-main";
    const groupTitle = createText("span", "trellis-split-row-title", group.label);
    groupTitle.title = group.label;
    main.appendChild(groupTitle);
    main.appendChild(createText("span", "trellis-split-row-sub", group.sub));
    row.appendChild(main);
    row.appendChild(createText("span", "trellis-split-row-side", String(group.members.length)));
    row.addEventListener("click", () => {
      trellisSplit.detailKind = "network";
      trellisSplit.networkGroupKey = group.key;
      // Same selection-only fast path as task/spec rows: class swap +
      // right-pane rebuild, full rebuild only when stale/sandboxed.
      if (!renderTrellisSplitSelectionOnly()) {
        lastTrellisPanelSignature = null;
        renderTrellisViewBody();
      }
    });
    wrap.appendChild(row);
  }
  return wrap;
}

function buildTrellisFilterChips(labels, activeCounts, archiveCounts) {
  const chips = document.createElement("div");
  chips.className = "trellis-filter-chips";

  // Global refresh LEADS the chip bar (09-25): ↻ sits before "全部项目".
  // Appended FIRST so plain appendChild ordering puts it in front — the
  // vm test DOM has no insertBefore/prepend.
  chips.appendChild(buildTrellisSplitRefreshBtn());

  const chip = (next, label, count, empty) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "trellis-filter-chip";
    if (empty) el.classList.add("trellis-filter-chip-empty");
    if (next === trellisView.selectedRoot) el.classList.add("is-active");
    el.setAttribute("aria-pressed", next === trellisView.selectedRoot ? "true" : "false");
    el.appendChild(createText("span", "trellis-filter-chip-label", label));
    el.appendChild(createText("span", "trellis-filter-count", String(count)));
    el.addEventListener("click", () => {
      trellisView.selectedRoot = next;
      lastTrellisViewSignature = null;
      renderTrellisView();
    });
    return el;
  };

  chips.appendChild(chip(null, t("dashboardTrellisFilterAll"), trellisView.active.tasks.length, false));
  for (const root of trellisView.roots) {
    const count = activeCounts.get(root) || 0;
    const empty = count === 0 && (archiveCounts.get(root) || 0) === 0;
    // Tooltip carries the full path (same convention as the roots rows);
    // empty roots dim but stay clickable — the empty view is the point.
    const el = chip(root, labels.get(root) || root, count, empty);
    el.title = root;
    chips.appendChild(el);
  }
  return chips;
}

// v7 R5 — the single project bar that replaces the old roots card plus
// its separate filter card: title, chips, the spec-map entry and the ⚙
// toggle that reveals the manage drawer below it.
function buildTrellisProjectBar() {
  if (trellisView.rootsError || !trellisView.roots.length) return null;

  const labels = buildTrellisRootLabels(trellisView.roots);
  const activeCounts = new Map();
  for (const task of trellisView.active.tasks) {
    const owner = trellisTaskOwningRoot(task && task.cwd, trellisView.roots);
    if (owner) activeCounts.set(owner, (activeCounts.get(owner) || 0) + 1);
  }
  const archiveCounts = new Map();
  for (const task of trellisView.archive.tasks) {
    const owner = trellisTaskOwningRoot(task && task.cwd, trellisView.roots);
    if (owner) archiveCounts.set(owner, (archiveCounts.get(owner) || 0) + 1);
  }

  const section = document.createElement("div");
  section.className = "trellis-view-section trellis-filter-section";

  const selected = trellisView.selectedRoot;
  // "全部项目" redundant (chips already show every root; the section title
  // says it again) — the title row only exists when a root is selected.
  if (selected !== null) {
    const titleRow = document.createElement("div");
    titleRow.className = "trellis-view-section-title";
    titleRow.appendChild(createText(
      "span",
      "trellis-filter-title",
      labels.get(selected) || selected
    ));
    section.appendChild(titleRow);
  }

  const chipsRow = buildTrellisFilterChips(labels, activeCounts, archiveCounts);
  section.appendChild(chipsRow);
  return section;
}

function computeTrellisViewSignature() {
  return JSON.stringify({
    lang: (i18nPayload && i18nPayload.lang) || "en",
    roots: trellisView.roots,
    picks: trellisView.picks,
    rootsLoaded: trellisView.rootsLoaded,
    rootsError: trellisView.rootsError,
    noProjectsHint: trellisView.noProjectsHint,
    selectedRoot: trellisView.selectedRoot,
    panelOpen: trellisView.panelOpen,
    // v7 R8 drawers carry their own async state — a loading→result flip
    // must rerender the view even when nothing else changed. NOTE: the
    // spec group's SELECTED doc is deliberately absent — selection changes
    // take the selection-only fast path (see renderTrellisSplitSelectionOnly)
    // and must not invalidate this structural signature.
    network: trellisNetwork.open
      ? { loading: trellisNetwork.loading, root: trellisNetwork.root, result: trellisNetwork.result }
      : null,
    spec: trellisSpec.open
      ? { loading: trellisSpec.loading, root: trellisSpec.root }
      : null,
    // v7 R10: the two extra groups are list-body state — a flip must
    // rerender even when lists did not change. detailKind /
    // networkGroupKey are selection state (fast path), NOT structure.
    specGroupOpen: trellisSplit.specGroupOpen,
    networkGroupOpen: trellisSplit.networkGroupOpen,
    // Split-list structure (09-25 split polish): archive fold + collapse
    // set live here instead of relying on every mutation site clearing
    // the signature — cross-entry jumps (jumpToTrellisNetworkTask) mutate
    // them directly before selecting, and the fast path must see the
    // structure go stale and fall back to the full rebuild.
    archiveOpen: trellisSplit.archiveOpen,
    collapsedPaths: [...trellisSplit.collapsedPaths].sort(),
    active: {
      loading: trellisView.active.loading,
      loaded: trellisView.active.loaded,
      error: trellisView.active.error,
      tasks: trellisView.active.tasks,
    },
    archive: {
      loading: trellisView.archive.loading,
      loaded: trellisView.archive.loaded,
      error: trellisView.archive.error,
      openMonths: trellisView.archive.openMonths
        ? [...trellisView.archive.openMonths].sort()
        : null,
      tasks: trellisView.archive.tasks,
    },
  });
}

function renderTrellisView() {
  if (!trellisViewEl || activeView !== "trellis") return;
  const signature = computeTrellisViewSignature();
  if (signature === lastTrellisViewSignature) {
    // Nothing rebuilds — drop a stale entry animation arm so a later fold
    // never replays the first-mount stagger (UI redesign 09-24 Batch D).
    trellisSplit.entryPending = false;
    return;
  }
  lastTrellisViewSignature = signature;

  // Preserve the left-list scroll across structural rebuilds (folds,
  // refreshes, cross-group jumps): the split list owns the scrolling and
  // freshly built nodes would otherwise clamp it back to the top.
  let savedScroll = null;
  if (typeof trellisViewEl.querySelector === "function") {
    const oldList = trellisViewEl.querySelector(".trellis-split-list");
    if (oldList && Number.isFinite(oldList.scrollTop)) savedScroll = oldList.scrollTop;
  }

  const fragment = document.createDocumentFragment();
  // v7 R10fix: an open spec/relations group follows the project scope —
  // a chip switch (or unregister fallback) that reaches this rebuild
  // resets and refetches both groups instead of showing the old root.
  syncTrellisPanelScopes();
  const projectBar = buildTrellisProjectBar();
  if (projectBar) fragment.appendChild(projectBar);
  const rootsSection = buildTrellisRootsSection();
  if (rootsSection) fragment.appendChild(rootsSection);
  // The filter is render-layer only: the full lists stay in memory and
  // each rebuild slices them down to the selected root BEFORE the tree is
  // built, so the nesting always reflects the filtered view (a parent
  // filtered out flattens its orphaned children back to roots).
  const selectedRoot = trellisView.selectedRoot;
  const activeFiltered = filterTrellisTasksByRoot(trellisView.active.tasks, trellisView.roots, selectedRoot);
  const archiveFiltered = filterTrellisTasksByRoot(trellisView.archive.tasks, trellisView.roots, selectedRoot);
  // v7: the split list is the single view — flat depth-annotated rows
  // (left groups) with the selection detail pane on the right. R10 adds
  // the spec + relations groups below the phase groups in the SAME list.
  fragment.appendChild(buildTrellisSplitSection(activeFiltered, archiveFiltered));
  trellisViewEl.replaceChildren(fragment);

  if (typeof trellisViewEl.querySelector === "function") {
    const newList = trellisViewEl.querySelector(".trellis-split-list");
    if (newList) {
      if (savedScroll !== null) {
        const maxScroll = newList.scrollHeight - newList.clientHeight;
        const cap = Number.isFinite(maxScroll) ? Math.max(0, maxScroll) : savedScroll;
        newList.scrollTop = Math.min(savedScroll, cap);
      }
      // After a structural rebuild that changed the selection (cross-group
      // jump from a network ref, archive expand, root switch), reveal the
      // newly selected row. scroll-keeping above wins when the row is
      // already visible; scrollIntoView(nearest) moves the minimum needed.
      if (trellisSplit.selectedTaskPath !== null || trellisSplit.networkGroupKey !== null
        || trellisSpec.selected !== null) {
        const selectedRow = findTrellisSelectedRow();
        if (selectedRow && typeof selectedRow.scrollIntoView === "function") {
          selectedRow.scrollIntoView({ block: "nearest" });
        }
      }
    }
  }
}

// ── Dashboard view switching ─────────────────────────────────────────────
// Sessions ↔ Trellis: a pure display flip between the two scroll areas
// (plus the sessions-only header extras). The active view is memory-only;
// nothing is persisted.

function switchDashboardView(view) {
  if (view !== "sessions" && view !== "trellis") return;
  if (view === activeView) return;
  activeView = view;
  const trellis = view === "trellis";
  if (viewSessionsTabEl) {
    viewSessionsTabEl.classList.toggle("is-active", !trellis);
    viewSessionsTabEl.setAttribute("aria-selected", trellis ? "false" : "true");
  }
  if (viewTrellisTabEl) {
    viewTrellisTabEl.classList.toggle("is-active", trellis);
    viewTrellisTabEl.setAttribute("aria-selected", trellis ? "true" : "false");
  }
  if (trellisViewEl) trellisViewEl.hidden = !trellis;
  if (contentEl) contentEl.classList.toggle("hidden", trellis);
  if (sessionsHeaderExtrasEl) sessionsHeaderExtrasEl.hidden = trellis;
  // Entry stagger plays on FIRST MOUNT only (UI redesign 09-24 Batch D):
  // arming the flag right before render() lets the initial section build
  // animate; every later rebuild (data ticks, selection, folds) is silent.
  if (trellis) trellisSplit.entryPending = true;
  render({ force: true });
  if (trellis) refreshTrellisView();
}

function initDashboardViewSwitch() {
  if (viewSessionsTabEl) {
    viewSessionsTabEl.addEventListener("click", () => switchDashboardView("sessions"));
  }
  if (viewTrellisTabEl) {
    viewTrellisTabEl.addEventListener("click", () => switchDashboardView("trellis"));
  }
}

// ── Trellis archived-tasks section (independent view) ───────────────────────
// The month-grouped browser: collapsed groups show just the header
// ("2026-09 · 12"), expanding reveals that month's rows. This keeps a
// 200-task archive navigable without an unbounded flat list. Each row opens
// the same detail overlay as live tasks — taskPath already points into
// tasks/archive/<month>/, which readTaskDetail answers.

// Priority badge (v7 R7). task.py writes "P0".."P2"; tolerate a bare
// digit from hand-written task.json files, and treat anything else as
// unset so the row never shows a rank it cannot order.
function normalizeTrellisPriority(value) {
  if (typeof value !== "string") return null;
  const match = /^p?([0-2])$/i.exec(value.trim());
  return match ? `p${match[1]}` : null;
}

function formatTrellisArchiveDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 60 * 60 * 1000) {
    return t("dashboardTrellisArchivedDurationMinutes")
      .replace("{n}", String(Math.max(1, Math.round(ms / (60 * 1000)))));
  }
  if (ms < 24 * 60 * 60 * 1000) {
    return t("dashboardTrellisArchivedDurationHours")
      .replace("{n}", String(Math.max(1, Math.round(ms / (60 * 60 * 1000)))));
  }
  return t("dashboardTrellisArchivedDurationDays")
    .replace("{n}", String(Math.ceil(ms / (24 * 60 * 60 * 1000))));
}

function trellisArchiveCompletedLabel(task) {
  if (task.completedAt) return task.completedAt;
  if (typeof task.completedAtMs === "number" && Number.isFinite(task.completedAtMs)) {
    // App language, not the system locale — same rule as formatResetDate.
    try {
      return new Date(task.completedAtMs).toLocaleDateString((i18nPayload && i18nPayload.lang) || "en");
    } catch {
      return "";
    }
  }
  return "";
}

// ── Trellis task detail overlay ────────────────────────────────────────────
// Opened by the row-tail ⓘ button: a modal card inside the Dashboard window.
// Data is fetched once per open (single IPC round-trip, never polled); the
// binding-session list and the card title are frozen from the panel's own
// aggregate at open time, so the one-second rebuilds underneath do not churn
// the open card. Only the language participates in re-renders.
const trellisDetail = {
  open: false,
  loading: false,
  seq: 0,
  request: null, // { taskPath, title, cwd, sessions } — frozen at open time
  result: null,  // IPC reply { status, task? }
  activeTab: "overview", // "overview" | a doc name from result.task.docs
  embedded: false, // true = rendered inside the split detail pane (no overlay)
};
// Per-document read state, one entry per (taskPath, doc) pair. Contents are
// session-memory only: the cache dies with closeTrellisDetail() — never
// persisted, never logged (PRD: document contents are ephemeral).
const trellisDetailDocs = new Map(); // "taskPath\u0000doc" → { loading, result }
// ── v4-b task network ───────────────────────────────────────────────────
// Third overlay on the shared pattern: one task's structured linkage
// (parent / children from task.json) as clickable refs that jump straight
// into the task-detail overlay. Ephemeral; closing drops everything.
// ── ⛓ project-wide network overview (v7 R8) ─────────
// The relation graph is a project-level drawer now: one bounded IPC read
// (readTaskNetworkOverview) over every task in the selected root. The old
// single-task readTaskNetwork entry on detail cards is gone.

const trellisOverlayCloseTimers = new WeakMap();
const trellisCloseTimer = typeof setTimeout === "function" ? setTimeout : null;

function resetTrellisDetailState() {
  trellisDetail.open = false;
  trellisDetail.loading = false;
  trellisDetail.embedded = false;
  trellisDetail.request = null;
  trellisDetail.result = null;
  trellisDetail.activeTab = "overview";
  trellisDetailDocs.clear();
  lastTrellisDetailSignature = null;
}

// Close handler for cards rendered INSIDE the split detail pane: no overlay
// host is involved, so skip the close animation entirely.
function cancelTrellisOverlayClose(overlayEl) {
  if (!overlayEl) return;
  const pending = trellisOverlayCloseTimers.get(overlayEl);
  if (pending) {
    clearTimeout(pending);
    trellisOverlayCloseTimers.delete(overlayEl);
  }
  overlayEl.classList.remove("is-closing");
}

function animateTrellisOverlayClose(overlayEl, finish) {
  const reduced = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!overlayEl || overlayEl.hidden || reduced || !trellisCloseTimer) {
    finish();
    return;
  }
  cancelTrellisOverlayClose(overlayEl);
  overlayEl.classList.add("is-closing");
  trellisOverlayCloseTimers.set(
    overlayEl,
    trellisCloseTimer(() => {
      trellisOverlayCloseTimers.delete(overlayEl);
      overlayEl.classList.remove("is-closing");
      finish();
    }, 140)
  );
}

const trellisNetwork = {
  open: false,
  loading: false,
  seq: 0,
  root: null,
  result: null, // { status, nodes, edges, specGroups, prdGroups, truncated }
};
let lastTrellisNetworkSignature = null;

async function fetchTrellisNetworkOverview() {
  const seq = trellisNetwork.seq;
  const root = trellisNetwork.root;
  let result = null;
  try {
    result = await window.dashboardAPI.getTrellisNetworkOverview({ root });
  } catch {
    result = null;
  }
  if (!trellisNetwork.open || trellisNetwork.seq !== seq) return;
  trellisNetwork.loading = false;
  trellisNetwork.result = result && typeof result === "object" ? result : { status: "error" };
  lastTrellisNetworkSignature = null;
  lastTrellisViewSignature = null;
  renderTrellisViewBody();
}

// Clicking a task inside the overview jumps to it in the split list: make
// sure its root is selected (a different chip hides it) and archived tasks
// need the DONE group open, then select — the detail pane follows.
function jumpToTrellisNetworkTask(taskPath, taskCwd) {
  if (typeof taskPath !== "string" || !taskPath) return;
  const overviewRoot = trellisNetwork.root;
  if (overviewRoot && trellisView.selectedRoot !== null && trellisView.selectedRoot !== overviewRoot) {
    trellisView.selectedRoot = overviewRoot;
  }
  if (taskPath.includes("/archive/") && !trellisSplit.archiveOpen) {
    trellisSplit.archiveOpen = true;
  }
  if (trellisSplit.collapsedPaths) trellisSplit.collapsedPaths.delete(taskPath);
  // Composite key partner (09-25): overview nodes don't carry cwd — the
  // overview was fetched FOR trellisNetwork.root, so that root IS the
  // missing cwd scope in multi-root lists.
  const resolvedCwd = typeof taskCwd === "string" && taskCwd ? taskCwd : overviewRoot || null;
  selectTrellisSplitTask(taskPath, resolvedCwd);
}

function trellisNetworkRefButton(ref) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "trellis-network-ref";
  if (ref && ref.taskPath && !ref.missing) {
    btn.appendChild(document.createTextNode(ref.title || ref.taskPath));
    if (ref.archived) {
      const badge = document.createElement("span");
      badge.className = "trellis-network-ref-badge";
      badge.appendChild(document.createTextNode(t("dashboardTrellisLinksArchived")));
      btn.appendChild(badge);
    }
    btn.addEventListener("click", () => {
      jumpToTrellisNetworkTask(ref.taskPath, ref.cwd);
    });
  } else {
    btn.disabled = true;
    btn.classList.add("is-missing");
    btn.setAttribute("aria-disabled", "true");
    btn.appendChild(document.createTextNode(
      (ref && (ref.title || ref.taskPath || ref.name)) || t("dashboardTrellisLinksMissing")
    ));
    const badge = document.createElement("span");
    badge.className = "trellis-network-ref-badge";
    badge.appendChild(document.createTextNode(t("dashboardTrellisLinksMissing")));
    btn.appendChild(badge);
  }
  return btn;
}


// ── end task network ──────────────────────────────────────────────────────

let lastTrellisDetailSignature = null;

// ── v4-a spec map ──────────────────────────────────────────────────────────
// A second overlay on the same pattern as the task-detail card: a left
// file list over readSpecTree, a right pane rendering readSpecDoc through
// the same whitelisted builder as task docs. Session-memory only; every
// cached document dies with closeTrellisSpec().
const trellisSpec = {
  open: false,
  loading: false,
  seq: 0,
  root: null, // registered root whose .trellis/spec is being browsed
  files: [], // [{ relPath, group }] from readSpecTree
  truncated: false,
  selected: null, // relPath of the doc shown in the right pane
};
const trellisSpecDocs = new Map(); // "root\u0000relPath" → { loading, result }
let lastTrellisSpecSignature = null;

function trellisSpecDocKey(root, relPath) {
  return `${root}\u0000${relPath}`;
}

function openTrellisSpec(root) {
  // v7 R10fix: opening is just "expand the spec group" — the group then
  // lazy-loads for the CURRENT scope root (chip selection or first root).
  if (!trellisSplit.specGroupOpen) {
    toggleTrellisSpecGroup();
  }
}


function closeTrellisSpec() {
  // v7 R10fix: closing = fold the spec group; selection/doc cache drops
  // with the next expand (scope switch or re-open refetches).
  if (trellisSplit.specGroupOpen) {
    toggleTrellisSpecGroup();
  }
}


function switchTrellisSpecRoot(root) {
  if (!trellisSpec.open || typeof root !== "string" || !root || root === trellisSpec.root) return;
  trellisSpec.root = root;
  trellisSpec.files = [];
  trellisSpec.truncated = false;
  trellisSpec.selected = null;
  trellisSpecDocs.clear();
  lastTrellisSpecSignature = null;
  renderTrellisSpec();
  void fetchTrellisSpecTree(root);
}

function selectTrellisSpecDoc(relPath) {
  if (typeof relPath !== "string" || !relPath) return;
  trellisSpec.selected = relPath;
  trellisSplit.detailKind = "spec";
  trellisSplit.selectedTaskPath = null;
  trellisSplit.networkGroupKey = null;
  // Selection-only fast path (09-25 split polish): swap the spec row's
  // is-selected class and rebuild just the right pane (spec doc content
  // renders from the cache / loading hint). Structural fallback keeps
  // the full rebuild for a stale signature or sandbox DOM.
  if (!renderTrellisSplitSelectionOnly()) {
    lastTrellisSpecSignature = null;
    lastTrellisPanelSignature = null;
    renderTrellisViewBody();
  }
  void fetchTrellisSpecDoc(relPath);
}


async function fetchTrellisSpecTree(root) {
  if (typeof window.dashboardAPI.getTrellisSpecTree !== "function") return;
  const seq = trellisSpec.seq;
  trellisSpec.loading = true;
  lastTrellisSpecSignature = null;
  renderTrellisSpec();
  let result = null;
  try {
    result = await window.dashboardAPI.getTrellisSpecTree({ root });
  } catch {
    result = null;
  }
  // Stale guard: a reply for a closed panel or a superseded root is dropped.
  if (!trellisSpec.open || trellisSpec.root !== root || trellisSpec.seq !== seq) return;
  trellisSpec.loading = false;
  if (result && typeof result === "object" && result.status === "ok" && Array.isArray(result.files)) {
    trellisSpec.files = result.files.filter(
      (f) => f && typeof f === "object" && typeof f.relPath === "string" && f.relPath
    );
    trellisSpec.truncated = result.truncated === true;
  } else {
    trellisSpec.files = [];
    trellisSpec.truncated = false;
  }
  lastTrellisSpecSignature = null;
  renderTrellisSpec();
}

async function fetchTrellisSpecDoc(relPath) {
  const root = trellisSpec.root;
  if (!root || typeof window.dashboardAPI.getTrellisSpecDoc !== "function") return;
  const key = trellisSpecDocKey(root, relPath);
  if (trellisSpecDocs.has(key)) return;
  trellisSpecDocs.set(key, { loading: true, result: null });
  // Doc loading state only affects the RIGHT pane — keep the left list
  // untouched: same fast path as selection changes (class swap is an
  // idempotent no-op here, pane gets rebuilt, focus/scroll stay put).
  // Fall back to the full spec render when the pane is not live yet.
  if (!renderTrellisSplitSelectionOnly()) {
    lastTrellisSpecSignature = null;
    renderTrellisSpec();
  }
  let result = null;
  try {
    result = await window.dashboardAPI.getTrellisSpecDoc({ root, relPath });
  } catch {
    result = null;
  }
  const entry = trellisSpecDocs.get(key);
  if (!entry) return; // closed / switched root dropped the cache
  entry.loading = false;
  entry.result = result && typeof result === "object" ? result : { status: "error" };
  if (!renderTrellisSplitSelectionOnly()) {
    lastTrellisSpecSignature = null;
    renderTrellisSpec();
  }
}

// v7 R10: spec document content for the RIGHT pane (detail slot), driven
// by the spec group row click. Reuses the same doc cache and whitelisted
// markdown renderer the old spec card used.
function buildTrellisSpecDocContent(relPath) {
  const pane = document.createElement("div");
  pane.className = "trellis-spec-doc-content";
  pane.appendChild(createText("h3", "trellis-detail-title", relPath));
  const entry = trellisSpecDocs.get(trellisSpecDocKey(trellisSpec.root, relPath));
  if (!entry || entry.loading) {
    pane.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisDetailLoading")));
    return pane;
  }
  if (entry.result && entry.result.status === "ok") {
    const rendered = renderMarkdownDoc(trellisDocBuilder, entry.result.content || "");
    pane.appendChild(rendered.root);
    // R4 fix: spec-doc pane never wired collapse handlers — headings in
    // spec files rendered via this path were not clickable at all.
    wireTrellisDocCollapse(rendered.root);
    if (rendered.truncated) {
      pane.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisDocTruncated")));
    }
    return pane;
  }
  pane.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisSpecLoadFailed")));
  return pane;
}

// v7 R10: one network group's content for the RIGHT pane — label, sub and
// member rows; clicking a member jumps to that task in the split list.
function buildTrellisNetworkGroupContent(key) {
  const pane = document.createElement("div");
  pane.className = "trellis-network-group-content";
  const group = trellisNetworkGroups().find((g) => g.key === key);
  if (!group) {
    pane.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisLinksEmpty")));
    return pane;
  }
  pane.appendChild(createText("h3", "trellis-detail-title", group.label));
  if (group.sub) {
    pane.appendChild(createText("div", "trellis-detail-hint", group.sub));
  }
  const wrap = document.createElement("div");
  wrap.className = "trellis-network-group";
  for (const ref of group.members) {
    wrap.appendChild(trellisNetworkRefButton(ref));
  }
  pane.appendChild(wrap);
  return pane;
}


function renderTrellisSpec() {
  if (!trellisSpec.open) {
    lastTrellisSpecSignature = null;
    return;
  }
  const signature = JSON.stringify([
    trellisSpec.loading,
    trellisSpec.root,
    trellisSpec.files.map((f) => `${f.group}|${f.relPath}|${f.filled}|${f.lines}|${f.refCount}`),
    trellisSpec.truncated,
    trellisSpec.selected,
    [...trellisSpecDocs.entries()].map(([k, v]) => [k, v.loading, v.result && v.result.status, v.result && v.result.truncated]),
    trellisView.roots,
  ]);
  if (signature === lastTrellisSpecSignature) return;
  lastTrellisSpecSignature = signature;
  // v7 R10: spec state drives the LEFT group rows and the RIGHT pane —
  // rerender the split body (not the whole view header).
  lastTrellisPanelSignature = null;
  renderTrellisViewBody();
}

// ── end spec map ───────────────────────────────────────────────────────────

function trellisDetailDocKey(taskPath, doc) {
  return `${taskPath}\u0000${doc}`;
}

// Signature stays cheap on purpose: a 1 MB document must not be re-stringified
// every second, so cached docs contribute a fingerprint (state + length), not
// their content — the content of a cached doc never changes after landing.
function trellisDetailDocsFingerprint() {
  const out = [];
  for (const [key, entry] of trellisDetailDocs) {
    const result = entry && entry.result;
    out.push([
      key,
      entry ? entry.loading : null,
      result ? result.status : null,
      result && typeof result.content === "string" ? result.content.length : null,
      result ? result.truncated : null,
    ]);
  }
  return out;
}

function computeTrellisDetailSignature() {
  return JSON.stringify({
    lang: (i18nPayload && i18nPayload.lang) || "en",
    open: trellisDetail.open,
    loading: trellisDetail.loading,
    embedded: trellisDetail.embedded,
    request: trellisDetail.request,
    result: trellisDetail.result,
    tab: trellisDetail.activeTab,
    docs: trellisDetailDocsFingerprint(),
  });
}

async function openTrellisDetail(task, opts) {
  if (!trellisDetailOverlayEl || !task) return;
  const sessions = Array.isArray(task.sessions) ? task.sessions : [];
  const cwdSource = sessions.find((binding) => binding && binding.cwd);
  trellisDetail.open = true;
  trellisDetail.loading = true;
  trellisDetail.seq += 1;
  const seq = trellisDetail.seq;
  trellisDetail.embedded = Boolean(opts && opts.embedded);
  trellisDetail.request = {
    taskPath: task.taskPath,
    title: task.title || "",
    // Archived rows carry the cwd their archive scan resolved (no live
    // binding exists to donate one); live rows keep the first bound cwd.
    cwd: task.cwd || (cwdSource ? cwdSource.cwd : ""),
    sessions: sessions.slice(),
  };
  trellisDetail.result = null;
  trellisDetail.activeTab = "overview";
  // Opening another card without closing this one (same overlay) must not
  // keep the previous task's cached documents alive: contents are ephemeral
  // per open card, and the fingerprint must not carry stale keys forever.
  trellisDetailDocs.clear();
  lastTrellisDetailSignature = null;
  renderTrellisDetail();

  let result = null;
  try {
    if (typeof window.dashboardAPI.getTrellisTaskDetail !== "function") {
      throw new Error("bridge-unavailable");
    }
    result = await window.dashboardAPI.getTrellisTaskDetail({
      taskPath: trellisDetail.request.taskPath,
      cwd: trellisDetail.request.cwd,
    });
  } catch {
    result = null;
  }
  // Stale guard: another detail was opened (or this one closed) while the
  // read was in flight — drop the reply instead of overwriting newer UI.
  if (!trellisDetail.open || seq !== trellisDetail.seq) return;
  trellisDetail.loading = false;
  trellisDetail.result = result && typeof result === "object" ? result : { status: "error" };
  lastTrellisDetailSignature = null;
  renderTrellisDetail();
}

function closeTrellisDetail() {
  if (!trellisDetail.open) return;
  if (trellisDetail.embedded) {
    // Embedded card lives inside the split detail pane: closing equals
    // clearing the master-list selection (pane rebuilds to the empty
    // state and quietly drops the card). Fallback covers external close
    // calls while no row is selected.
    if (trellisSplit.selectedTaskPath !== null) {
      selectTrellisSplitTask(null);
    } else {
      resetTrellisDetailState();
      renderTrellisViewBody();
    }
    return;
  }
  trellisDetail.loading = false;
  trellisDetail.request = null;
  trellisDetail.result = null;
  trellisDetail.activeTab = "overview";
  // Ephemeral by contract: closing the card drops every cached document
  // content along with the card itself.
  trellisDetailDocs.clear();
  lastTrellisDetailSignature = null;
  trellisDetail.open = false;
  animateTrellisOverlayClose(trellisDetailOverlayEl, renderTrellisDetail);
}

// Tab switch inside an open card. "overview" is always available; a doc
// tab lazily fetches its content once (the cache entry survives tab
// switches within the same open card).
function switchTrellisDetailTab(tab) {
  if (!trellisDetail.open || tab === trellisDetail.activeTab) return;
  if (tab !== "overview") {
    const request = trellisDetail.request;
    const detail = trellisDetail.result && trellisDetail.result.status === "ok"
      ? trellisDetail.result.task
      : null;
    if (!request || !detail || !Array.isArray(detail.docs)) return;
    if (!detail.docs.some((doc) => doc && doc.name === tab)) return;
  }
  trellisDetail.activeTab = tab;
  lastTrellisDetailSignature = null;
  renderTrellisDetail();
  if (tab !== "overview") void fetchTrellisDetailDoc(tab);
}

async function fetchTrellisDetailDoc(doc) {
  const request = trellisDetail.request;
  if (!request || typeof window.dashboardAPI.getTrellisTaskDoc !== "function") return;
  const key = trellisDetailDocKey(request.taskPath, doc);
  if (trellisDetailDocs.has(key)) return;
  trellisDetailDocs.set(key, { loading: true, result: null });
  lastTrellisDetailSignature = null;
  renderTrellisDetail();

  let result = null;
  try {
    result = await window.dashboardAPI.getTrellisTaskDoc({
      taskPath: request.taskPath,
      cwd: request.cwd,
      doc,
    });
  } catch {
    result = null;
  }
  // The cache is keyed by (taskPath, doc), so a reply for a card that was
  // closed (or superseded by another task) just lands in the cache unseen;
  // closeTrellisDetail() drops it with everything else.
  const entry = trellisDetailDocs.get(key);
  if (!entry) return;
  entry.loading = false;
  entry.result = result && typeof result === "object" ? result : { status: "error" };
  lastTrellisDetailSignature = null;
  renderTrellisDetail();
}

function createTrellisDetailCheckItem(item) {
  const li = document.createElement("li");
  li.className = item.checked
    ? "trellis-detail-check-item trellis-detail-check-item-done"
    : "trellis-detail-check-item";
  li.appendChild(createText("span", "trellis-detail-check-box", item.checked ? "☑" : "☐"));
  li.appendChild(createText("span", "trellis-detail-check-text", item.text));
  return li;
}

function appendTrellisDetailMeta(card, task) {
  const meta = document.createElement("div");
  meta.className = "trellis-detail-meta";
  // Priority (v7 R7) leads the meta row: it is the field that decides
  // whether the task gets looked at at all.
  const priority = normalizeTrellisPriority(task.priority);
  if (priority) {
    const chip = createText(
      "span",
      `trellis-detail-meta-item trellis-priority pri-${priority}`,
      priority.toUpperCase()
    );
    chip.setAttribute(
      "aria-label",
      t("dashboardTrellisDetailPriority").replace("{p}", priority.toUpperCase())
    );
    meta.appendChild(chip);
  }
  if (task.createdAt) {
    meta.appendChild(createText(
      "span",
      "trellis-detail-meta-item",
      t("dashboardTrellisDetailCreated").replace("{date}", task.createdAt)
    ));
  }
  if (task.completedAt) {
    meta.appendChild(createText(
      "span",
      "trellis-detail-meta-item",
      t("dashboardTrellisDetailCompleted").replace("{date}", task.completedAt)
    ));
  }
  if (task.checklist && task.checklist.total > 0) {
    meta.appendChild(createText(
      "span",
      "trellis-detail-meta-item",
      t("dashboardTrellisDetailSteps")
        .replace("{done}", String(task.checklist.done))
        .replace("{total}", String(task.checklist.total))
    ));
  }
  if (meta.children.length) card.appendChild(meta);

  if (task.checklist && task.checklist.total > 0) {
    // v6.1: segmented energy ticks (same component as the tree rows), one
    // cell per checklist step — replaces the continuous percentage bar.
    const bar = document.createElement("div");
    bar.className = "trellis-detail-progress";
    const ticks = buildTrellisProgressTicks(task.checklist);
    if (ticks) {
      ticks.classList.add("trellis-detail-progress-ticks");
      bar.appendChild(ticks);
    }
    bar.appendChild(createText(
      "span",
      "trellis-detail-progress-num",
      `${task.checklist.done}/${task.checklist.total}`
    ));
    card.appendChild(bar);
  }
}

function appendTrellisDetailChecklist(card, task) {
  const section = document.createElement("div");
  section.className = "trellis-detail-section";
  section.appendChild(createText(
    "div",
    "trellis-detail-section-title",
    t("dashboardTrellisDetailChecklist")
  ));
  const checklist = task.checklist;
  if (checklist && checklist.total > 0) {
    const list = document.createElement("ul");
    list.className = "trellis-detail-checklist";
    for (const item of checklist.items) list.appendChild(createTrellisDetailCheckItem(item));
    section.appendChild(list);
  } else {
    section.appendChild(createText("div", "trellis-detail-empty", t("dashboardTrellisDetailChecklistEmpty")));
  }
  card.appendChild(section);
}

function appendTrellisDetailSessions(card, request) {
  if (!request || !request.sessions.length) return;
  const section = document.createElement("div");
  section.className = "trellis-detail-section";
  section.appendChild(createText(
    "div",
    "trellis-detail-section-title",
    t("dashboardTrellisDetailSessions")
  ));
  const chips = document.createElement("div");
  chips.className = "trellis-task-sessions";
  for (const binding of request.sessions) chips.appendChild(createTrellisSessionChip(binding));
  section.appendChild(chips);
  card.appendChild(section);
}

// The doc renderer is a pure (builder → element) function; this adapter is
// the only DOM touchpoint, so tests can swap in a fake document wholesale.
const trellisDocBuilder = {
  createElement: (tag) => document.createElement(tag),
  createTextNode: (text) => document.createTextNode(text),
  createElementNS: (ns, tag) => (typeof document.createElementNS === "function"
    ? document.createElementNS(ns, tag)
    : document.createElement(tag)),
};

function trellisDocHeadingLevel(el) {
  for (let level = 1; level <= 4; level += 1) {
    if (el.classList && el.classList.contains(`md-h${level}`)) return level;
  }
  return 0;
}

// ANY heading (h1..h4) collapses on click: flip the class + hide following
// siblings up to (and excluding) the next same-or-higher heading. Default is
// fully expanded; a card rebuild resets collapse state, which only happens
// on tab or language changes — never on the periodic tick (signature guard).
function toggleTrellisDocHeading(docRoot, heading) {
  const level = trellisDocHeadingLevel(heading);
  if (!level) return;
  const collapsed = heading.classList.toggle("md-collapsed");
  heading.setAttribute("aria-expanded", collapsed ? "false" : "true");
  // The caret is an always-down SVG rotated via CSS (.md-collapsed rule)
  // — no glyph flipping here (UI redesign 09-24 Batch C).
  const siblings = docRoot.children;
  for (let i = siblings.length - 1; i >= 0; i -= 1) {
    if (siblings[i] === heading) {
      for (let j = i + 1; j < siblings.length; j += 1) {
        const elLevel = trellisDocHeadingLevel(siblings[j]);
        if (elLevel && elLevel <= level) break;
        siblings[j].hidden = collapsed;
      }
      return;
    }
  }
}

function wireTrellisDocCollapse(docRoot) {
  // querySelectorAll (not just top-level children): headings nested
  // inside lists/blockquotes were previously unclickable ("折叠无效").
  // Guard: the test sandbox DOM only implements children iteration.
  if (typeof docRoot.querySelectorAll === "function") {
    for (const el of docRoot.querySelectorAll(".md-heading-collapsible")) {
      el.addEventListener("click", () => toggleTrellisDocHeading(docRoot, el));
    }
    return;
  }
  for (const el of docRoot.children) {
    if (el.classList && el.classList.contains("md-heading-collapsible")) {
      el.addEventListener("click", () => toggleTrellisDocHeading(docRoot, el));
    }
  }
}

function appendTrellisDetailTabs(card, docs) {
  const tabs = document.createElement("div");
  tabs.className = "trellis-detail-tabs";
  tabs.setAttribute("role", "tablist");
  const makeTab = (name, label) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = trellisDetail.activeTab === name
      ? "trellis-detail-tab is-active"
      : "trellis-detail-tab";
    tab.textContent = label;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", trellisDetail.activeTab === name ? "true" : "false");
    tab.addEventListener("click", () => switchTrellisDetailTab(name));
    return tab;
  };
  tabs.appendChild(makeTab("overview", t("dashboardTrellisDetailTabOverview")));
  for (const doc of docs) {
    tabs.appendChild(makeTab(doc.name, doc.name.replace(/\.md$/, "")));
  }
  card.appendChild(tabs);
}

function appendTrellisDetailDocNote(container, key) {
  container.appendChild(createText("div", "trellis-detail-doc-note", t(key)));
}

function appendTrellisDetailDocView(card, docName) {
  const container = document.createElement("div");
  container.className = "trellis-detail-doc";
  const request = trellisDetail.request;
  const entry = request ? trellisDetailDocs.get(trellisDetailDocKey(request.taskPath, docName)) : null;
  if (!entry || entry.loading) {
    appendTrellisDetailDocNote(container, "dashboardTrellisDetailLoading");
    card.appendChild(container);
    return;
  }
  const result = entry.result;
  if (result && result.status === "ok" && typeof result.content === "string") {
    if (result.truncated) {
      appendTrellisDetailDocNote(container, "dashboardTrellisDocTruncated");
    }
    const { root, truncated } = renderMarkdownDoc(trellisDocBuilder, result.content);
    if (truncated) {
      appendTrellisDetailDocNote(container, "dashboardTrellisDocTruncated");
    }
    container.appendChild(root);
    wireTrellisDocCollapse(root);
  } else if (result && result.status === "missing") {
    appendTrellisDetailDocNote(container, "dashboardTrellisDocMissing");
  } else {
    appendTrellisDetailDocNote(container, "dashboardTrellisDocReadError");
  }
  card.appendChild(container);
}

function buildTrellisDetailCard() {
  const card = document.createElement("div");
  card.className = "trellis-detail-card";
  const request = trellisDetail.request || { title: "", taskPath: "", sessions: [] };

  const header = document.createElement("div");
  header.className = "trellis-detail-header";
  const heading = document.createElement("div");
  heading.className = "trellis-detail-heading";
  const result = trellisDetail.result;
  const detail = result && result.status === "ok" && result.task ? result.task : null;
  heading.appendChild(createText(
    "h2",
    "trellis-detail-title",
    (detail && detail.title) || request.title || request.taskPath
  ));
  if (detail) {
    const badge = TRELLIS_PHASE_BADGE[detail.phase];
    if (badge) {
      heading.appendChild(createText("span", `trellis-phase-badge ${badge.cls}`, t(badge.labelKey)));
    }
    if (detail.archived) {
      heading.appendChild(createText(
        "span",
        "trellis-detail-archived-badge",
        t("dashboardTrellisDetailArchived")
      ));
    }
  }
  header.appendChild(heading);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "trellis-detail-close";
  close.appendChild(iconSvg("close", 12));
  close.title = t("dashboardTrellisDetailClose");
  close.setAttribute("aria-label", t("dashboardTrellisDetailClose"));
  close.addEventListener("click", closeTrellisDetail);
  header.appendChild(close);

  // v7 R8: the ⛓ entry is gone from detail cards — the project bar's
  // network overview replaced the per-task drill-down.
  card.appendChild(header);

  if (trellisDetail.loading) {
    card.appendChild(createText("div", "trellis-detail-empty", t("dashboardTrellisDetailLoading")));
  } else if (detail) {
    const docs = Array.isArray(detail.docs)
      ? detail.docs.filter((doc) => doc && typeof doc.name === "string" && doc.name)
      : [];
    if (docs.length) appendTrellisDetailTabs(card, docs);
    if (docs.length && trellisDetail.activeTab !== "overview") {
      appendTrellisDetailDocView(card, trellisDetail.activeTab);
    } else {
      appendTrellisDetailMeta(card, detail);
      appendTrellisDetailChecklist(card, detail);
    }
  } else if (result && result.status === "missing") {
    card.appendChild(createText("div", "trellis-detail-empty", t("dashboardTrellisDetailMissing")));
  } else {
    card.appendChild(createText("div", "trellis-detail-empty", t("dashboardTrellisDetailError")));
  }

  if (!detail || trellisDetail.activeTab === "overview") {
    appendTrellisDetailSessions(card, request);
  }
  return card;
}

function renderTrellisDetail() {
  if (!trellisDetailOverlayEl) return;
  const signature = computeTrellisDetailSignature();
  if (signature === lastTrellisDetailSignature) return;
  lastTrellisDetailSignature = signature;
  if (!trellisDetail.open) {
    trellisDetailOverlayEl.hidden = true;
    trellisDetailOverlayEl.replaceChildren();
    return;
  }
  cancelTrellisOverlayClose(trellisDetailOverlayEl);
  const card = buildTrellisDetailCard();
  if (trellisDetail.embedded) {
    // Embedded mode: render into the split detail pane host instead of the
    // overlay. The overlay host stays hidden; card chrome (close button)
    // differs — see buildTrellisDetailCard embedded branch.
    trellisDetailOverlayEl.hidden = true;
    trellisDetailOverlayEl.replaceChildren();
    // Module-level host (set by buildTrellisSplitDetailPane) beats DOM
    // queries: works in test sandboxes without document.querySelector.
    const host = trellisSplitDetailHostEl || document.querySelector(".trellis-split-detail");
    if (host) {
      host.replaceChildren();
      host.appendChild(card);
    }
    return;
  }
  trellisDetailOverlayEl.replaceChildren(card);
  trellisDetailOverlayEl.hidden = false;
  trellisDetailOverlayEl.setAttribute("aria-label", t("dashboardTrellisDetailTitle"));
}

function badgeLabel(badge) {
  const key = {
    running: "sessionBadgeRunning",
    done: "sessionBadgeDone",
    interrupted: "sessionBadgeInterrupted",
    idle: "sessionBadgeIdle",
  }[badge] || "sessionBadgeIdle";
  return t(key);
}

function agentLabel(agentId, agentName) {
  return AGENT_LABELS[agentId] || agentName || agentId || t("dashboardUnknownAgent");
}

function agentFallback(agentId, agentName) {
  const label = agentLabel(agentId, agentName).trim();
  return label ? label.slice(0, 2).toUpperCase() : "?";
}

function createText(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text || "";
  return el;
}

function sessionTitleText(session) {
  return session.displayTitle || session.sessionTitle || session.id || "";
}

function snapshotHasSession(currentSnapshot, sessionId) {
  const sessions = Array.isArray(currentSnapshot && currentSnapshot.sessions)
    ? currentSnapshot.sessions
    : [];
  return sessions.some((session) => session && session.id === sessionId);
}

function beginTitleEdit(session) {
  if (!session || !session.id) return;
  activeEdit = {
    sessionId: session.id,
    rawSessionId: session.rawSessionId || session.id,
    profileId: session.profileId || "local",
    agentId: session.agentId || null,
    host: session.host || null,
    cwd: session.cwd || "",
    initialDraft: sessionTitleText(session),
    draft: sessionTitleText(session),
    committing: false,
  };
  render({ force: true });
}

function cancelTitleEdit() {
  if (!activeEdit) return;
  activeEdit = null;
  render({ force: true });
}

async function commitTitleEdit() {
  if (!activeEdit || activeEdit.committing) return;
  const edit = activeEdit;
  if (edit.draft === edit.initialDraft) {
    activeEdit = null;
    render({ force: true });
    return;
  }
  edit.committing = true;
  try {
    const result = await window.dashboardAPI.setSessionAlias({
      host: edit.host,
      agentId: edit.agentId,
      sessionId: edit.sessionId,
      rawSessionId: edit.rawSessionId,
      profileId: edit.profileId,
      cwd: edit.cwd,
      alias: edit.draft,
    });
    if (!result || result.status !== "ok") {
      edit.committing = false;
      console.warn("session alias update failed:", result && result.message);
      render({ force: true });
      return;
    }
    if (activeEdit === edit) activeEdit = null;
    render({ force: true });
  } catch (err) {
    if (activeEdit === edit) {
      edit.committing = false;
      render({ force: true });
    }
    console.warn("session alias update threw:", err);
  }
}

function createTitle(session) {
  const text = sessionTitleText(session);
  if (activeEdit && activeEdit.sessionId === session.id) {
    const input = document.createElement("input");
    input.className = "session-title-input";
    input.type = "text";
    input.value = activeEdit.draft;
    input.addEventListener("input", () => {
      if (activeEdit && activeEdit.sessionId === session.id) {
        activeEdit.draft = input.value;
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitTitleEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelTitleEdit();
      }
    });
    input.addEventListener("blur", () => {
      commitTitleEdit();
    });
    requestAnimationFrame(() => {
      if (activeEdit && activeEdit.sessionId === session.id && document.contains(input)) {
        input.focus();
        input.select();
      }
    });
    return input;
  }

  const title = createText("div", "session-title", text);
  title.title = text;
  title.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    beginTitleEdit(session);
  });
  return title;
}

function appendMeta(main, session, now) {
  const meta = createText("div", "meta", "");
  const badge = document.createElement("span");
  badge.className = `badge badge-${session.badge || "idle"}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(badgeLabel(session.badge)));

  meta.appendChild(document.createTextNode(agentLabel(session.agentId, session.agentName)));
  meta.appendChild(document.createTextNode(" · "));
  meta.appendChild(badge);
  meta.appendChild(document.createTextNode(` · ${formatElapsed(now - session.updatedAt)}`));
  if (session.headless) {
    meta.appendChild(document.createTextNode(` · ${t("dashboardHeadless")}`));
  }
  if (session.startupRecovered) {
    meta.appendChild(document.createTextNode(" · "));
    const recoveryBadge = document.createElement("span");
    recoveryBadge.className = "recovery-badge";
    recoveryBadge.textContent = t("sessionRecovered");
    meta.appendChild(recoveryBadge);
  }
  // Source badge: show where this session runs (WSL, SSH)
  if (session.sourceType && session.sourceType !== "local") {
    meta.appendChild(document.createTextNode(" · "));
    const sourceBadge = document.createElement("span");
    sourceBadge.className = `source-badge source-${session.sourceType}`;
    sourceBadge.title = session.sourceDisplayLabel || session.sourceLabel || "";
    sourceBadge.textContent = session.sourceDisplayLabel || session.sourceLabel;
    meta.appendChild(sourceBadge);
  }
  main.appendChild(meta);
}

function appendPath(main, session) {
  const pathText = session.cwd || t("dashboardNoPath");
  const pathEl = createText("div", "path", pathText);
  if (session.cwd) pathEl.title = session.cwd;
  main.appendChild(pathEl);
}

function appendEvent(main, session, now) {
  if (!session.lastEvent) return;
  const eventLabel = session.lastEvent.labelKey
    ? t(session.lastEvent.labelKey)
    : (session.lastEvent.rawEvent || "");
  if (!eventLabel) return;
  const eventAt = Number(session.lastEvent.at) || session.updatedAt;
  main.appendChild(createText(
    "div",
    "event-row",
    `${t("dashboardLastEventPrefix")}: ${eventLabel} · ${formatElapsed(now - eventAt)}`
  ));
}

// Own row, not a chip in `.meta`: that row is a single clipped line, so at the
// default 480px width an appended chip is cut off before it can be read.
function appendModel(main, session) {
  if (!session.model) return;
  const row = createText("div", "model-row", `${t("dashboardModel")}: ${session.model}`);
  row.title = session.model;
  main.appendChild(row);
}

function appendContextUsage(main, session) {
  const text = contextUsageText(session);
  if (!text) return;
  main.appendChild(createText("div", "context-usage-row", text));
}

function createIcon(session) {
  if (session.iconUrl) {
    const img = document.createElement("img");
    img.className = "agent-icon";
    img.alt = "";
    img.src = session.iconUrl;
    img.addEventListener("error", () => {
      const fallback = createText("span", "agent-fallback", agentFallback(session.agentId, session.agentName));
      img.replaceWith(fallback);
    }, { once: true });
    return img;
  }
  return createText("span", "agent-fallback", agentFallback(session.agentId, session.agentName));
}

function createHideButton(session) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "hide-session-button";
  button.textContent = "\u00d7";
  button.title = t("dashboardHideSessionTitle");
  button.setAttribute("aria-label", t("dashboardHideSessionTitle"));
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!session || !session.id || !window.dashboardAPI.hideSession) return;
    button.disabled = true;
    try {
      const result = await window.dashboardAPI.hideSession(session.id);
      if (!result || (result.status !== "ok" && result.status !== "not-found")) {
        button.disabled = false;
        console.warn("hide session failed:", result && result.message);
      }
    } catch (err) {
      button.disabled = false;
      console.warn("hide session threw:", err);
    }
  });
  return button;
}

function focusUnavailableText(session) {
  return t(focusUnavailableReasonKey(session));
}

function openFolderFailureText(result) {
  if (result && result.status === "error" && result.message) {
    return t("sessionOpenFolderFailed").replace("{reason}", result.message);
  }
  return t("sessionOpenFolderUnavailable");
}

function pruneSessionFolderActionState(sessions, now) {
  const currentIds = new Set(sessions.map((session) => session && session.id).filter(Boolean));
  for (const [sessionId, state] of sessionFolderActionState) {
    if (!currentIds.has(sessionId)
        || (!state.pending && (!state.feedbackText || state.feedbackUntil <= now))) {
      sessionFolderActionState.delete(sessionId);
    }
  }
}

function beginSessionFolderAction(sessionId) {
  const current = sessionFolderActionState.get(sessionId);
  if (current && current.pending) return false;
  sessionFolderActionState.set(sessionId, {
    pending: true,
    feedbackText: "",
    feedbackUntil: 0,
  });
  return true;
}

function finishSessionFolderAction(sessionId, feedbackText = "") {
  if (!feedbackText) {
    sessionFolderActionState.delete(sessionId);
    return;
  }
  sessionFolderActionState.set(sessionId, {
    pending: false,
    feedbackText,
    feedbackUntil: Date.now() + SESSION_FOLDER_FEEDBACK_MS,
  });
}

let enteringSessionIds = new Set();
let knownSessionIds = null;
let firstFrameShown = false;
let firstFrameTimer = 0;
const firstFrameEnroll = typeof setTimeout === "function" ? setTimeout : null;
const firstFrameCancel = typeof clearTimeout === "function" ? clearTimeout : null;

// Marks newly-seen sessions for a one-shot enter animation and runs the
// first-frame stagger exactly once per window lifetime. Purely class
// bookkeeping — all interpolation lives in CSS.
function noteEnteringSessions(sessions) {
  const ids = new Set(sessions.map((session) => session.id));
  enteringSessionIds = knownSessionIds
    ? new Set(Array.from(ids).filter((id) => !knownSessionIds.has(id)))
    : new Set();
  knownSessionIds = ids;
  if (!firstFrameShown && sessions.length) {
    firstFrameShown = true;
    if (firstFrameEnroll && firstFrameCancel) {
      contentEl.classList.add("is-first-frame");
      firstFrameCancel(firstFrameTimer);
      firstFrameTimer = firstFrameEnroll(() => contentEl.classList.remove("is-first-frame"), 480);
    }
  }
}

function createCard(session, now) {
  const card = document.createElement("article");
  card.className = session.canFocus === true ? "card" : "card card-unfocusable";
  // Entering cards play their intro once; the next rebuild drops the class so
  // the one-second tick never re-runs the animation.
  if (enteringSessionIds.has(session.id)) card.classList.add("is-entering");

  // The digit badge is produced here, from the frozen round state, on every
  // rebuild. The one-second tick replaces the whole card tree, so anything
  // injected after a render would be wiped a second later.
  const digit = quickDigitForSession(session.id);
  if (digit) {
    card.classList.add("card-quick-numbered");
    const badge = createText("span", "quick-digit-badge", String(digit));
    badge.setAttribute("aria-hidden", "true");
    card.appendChild(badge);
  }

  if (session.id) {
    const idTail = String(session.id).slice(-3);
    card.appendChild(createText("span", "session-id-badge", `#${idTail}`));
    card.appendChild(createHideButton(session));
  }

  card.appendChild(createIcon(session));

  const main = document.createElement("div");
  main.className = "main";
  main.appendChild(createTitle(session));
  appendMeta(main, session, now);
  appendPath(main, session);
  appendModel(main, session);
  appendEvent(main, session, now);
  appendContextUsage(main, session);
  appendSessionAutomation(main, session);
  card.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "actions";
  const hideRemoteFocusButton = session.canFocus !== true
    && focusUnavailableReasonKey(session) === "sessionFocusUnavailableRemote";
  if (!hideRemoteFocusButton) {
    const button = document.createElement("button");
    button.type = "button";
    const focusTargetType = session.focusTarget && session.focusTarget.type;
    button.textContent = focusTargetType === "codex-thread"
      ? t("dashboardOpenCodexSession")
      : t("dashboardJumpTerminal");
    button.disabled = session.canFocus !== true;
    if (button.disabled) {
      button.title = focusUnavailableText(session);
    }
    button.addEventListener("click", async () => {
      window.dashboardAPI.focusSession(session.id);
      // Best-effort ack alongside focus. Most remote-Codex sessions have
      // canFocus=false (no terminal-jump target) and reach ack through the
      // Mark-read button instead, but local Codex Stop sessions can land
      // here so we ack on focus too.
      if (window.dashboardAPI && typeof window.dashboardAPI.ackCompletion === "function") {
        try { await window.dashboardAPI.ackCompletion(session.id); }
        catch (err) { console.warn("ack completion threw:", err); }
      }
    });
    actions.appendChild(button);
  }

  if (session.canFocus !== true) {
    const reason = focusUnavailableText(session);
    actions.appendChild(createText("span", "focus-unavailable-reason", reason));
    const folderState = sessionFolderActionState.get(session.id) || null;
    const feedback = createText(
      "span",
      "session-action-feedback",
      folderState && folderState.feedbackUntil > now ? folderState.feedbackText : ""
    );
    feedback.setAttribute("aria-live", "polite");
    actions.appendChild(feedback);

    if (canOfferLocalFolder(session)) {
      const openFolder = document.createElement("button");
      openFolder.type = "button";
      openFolder.className = "open-folder-button";
      openFolder.textContent = t("dashboardOpenFolder");
      openFolder.disabled = !!(folderState && folderState.pending);
      openFolder.addEventListener("click", async () => {
        if (!beginSessionFolderAction(session.id)) return;
        openFolder.disabled = true;
        feedback.textContent = "";
        render();
        try {
          const result = await window.dashboardAPI.openSessionFolder(session.id);
          if (!result || result.status !== "ok") {
            const message = openFolderFailureText(result);
            finishSessionFolderAction(session.id, message);
            feedback.textContent = message;
          } else {
            finishSessionFolderAction(session.id);
          }
        } catch (err) {
          const message = t("sessionOpenFolderFailed")
            .replace("{reason}", err && err.message ? err.message : String(err));
          finishSessionFolderAction(session.id, message);
          feedback.textContent = message;
          console.warn("open session folder threw:", err);
        }
        openFolder.disabled = false;
        render();
      });
      actions.appendChild(openFolder);
    }
  }

  if (session.requiresCompletionAck === true) {
    actions.appendChild(createMarkReadButton(session));
  }

  card.appendChild(actions);

  return card;
}

function automationActionKey(session) {
  return session && session.id ? `session:${session.id}` : "";
}

function automationActionState(key) {
  const state = key ? sessionAutomationActionState.get(key) : null;
  return state && typeof state === "object"
    ? state
    : { pending: false, feedbackText: "" };
}

function appendSessionAutomation(container, session) {
  if (!container || !session) return;
  if (session.canConfigureSessionAutomation !== true && !session.sessionAutomationGrantId) return;
  const row = document.createElement("div");
  row.className = "session-automation-row";
  const label = createText("span", "session-automation-label", t("sessionAutomationLabel"));
  const select = document.createElement("select");
  select.className = "session-automation-select";
  select.setAttribute("aria-label", t("sessionAutomationLabel"));

  const values = [
    ["inherit", t("sessionAutomationFollowGlobal")],
    ["off", t("sessionAutomationAsk")],
    ["auto-tools", t("sessionAutomationAutoTools")],
  ];
  for (const [value, text] of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    if (
      session.canConfigureSessionAutomation !== true
      && value !== "inherit"
    ) {
      option.disabled = true;
    }
    select.appendChild(option);
  }
  select.value = session.sessionAutomationMode || "inherit";
  const key = automationActionKey(session);
  const actionState = automationActionState(key);
  select.disabled = actionState.pending === true
    || (
      session.canConfigureSessionAutomation !== true
      && !session.sessionAutomationGrantId
    );
  if (session.canConfigureSessionAutomation !== true) {
    select.title = t("sessionAutomationUnavailable");
  }
  const feedback = createText(
    "span",
    "session-automation-feedback",
    actionState.feedbackText
  );
  select.addEventListener("change", async () => {
    if (!window.dashboardAPI) return;
    const previousValue = session.sessionAutomationMode || "inherit";
    const nextValue = select.value;
    sessionAutomationActionState.set(key, {
      pending: true,
      feedbackText: "",
    });
    select.disabled = true;
    feedback.textContent = "";
    let result;
    try {
      if (nextValue === "inherit") {
        result = session.sessionAutomationGrantId
          ? await window.dashboardAPI.clearSessionAutomationGrant({
            grantId: session.sessionAutomationGrantId,
          })
          : { status: "equivalent" };
      } else {
        result = await window.dashboardAPI.setSessionAutomationOverride({
          sessionId: session.id,
          mode: nextValue,
        });
      }
    } catch (err) {
      result = { status: "error", message: err && err.message };
    }
    if (!result || !["applied", "equivalent"].includes(result.status)) {
      select.value = previousValue;
      if (result && result.status === "cancelled") {
        sessionAutomationActionState.delete(key);
      } else {
        sessionAutomationActionState.set(key, {
          pending: false,
          feedbackText: t("sessionAutomationChangeFailed"),
        });
      }
    } else {
      sessionAutomationActionState.delete(key);
    }
    render();
  });
  row.appendChild(label);
  row.appendChild(select);
  row.appendChild(feedback);
  container.appendChild(row);
}

function createMarkReadButton(session) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mark-read-button";
  button.textContent = t("dashboardMarkRead");
  button.title = t("dashboardMarkReadTitle");
  button.setAttribute("aria-label", t("dashboardMarkReadTitle"));
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!session || !session.id || !window.dashboardAPI || typeof window.dashboardAPI.ackCompletion !== "function") return;
    button.disabled = true;
    try {
      const result = await window.dashboardAPI.ackCompletion(session.id);
      if (!result || (result.status !== "ok" && result.status !== "noop")) {
        // Failure path: re-enable so the user can try again. Successful
        // ack keeps the button disabled — the next forced snapshot will
        // strip requiresCompletionAck and the button disappears on
        // re-render.
        button.disabled = false;
        console.warn("ack completion failed:", result && result.message);
      }
    } catch (err) {
      button.disabled = false;
      console.warn("ack completion threw:", err);
    }
  });
  return button;
}

function deriveGroups(currentSnapshot) {
  return Array.isArray(currentSnapshot.groups) ? currentSnapshot.groups : [];
}

function renderEmpty() {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.appendChild(createText("div", "empty-title", t("dashboardEmpty")));
  empty.appendChild(createText("div", "empty-hint", t("dashboardEmptyHint")));
  // "No sessions running" is exactly when the resume list is most useful —
  // it is the state a machine comes back up in. With nothing to resume the
  // node tree stays exactly as it was before this section existed.
  if (!sessionHistory.length) {
    contentEl.replaceChildren(empty);
    return;
  }
  empty.classList.add("empty-with-history");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(empty);
  appendSessionHistory(fragment, Date.now());
  contentEl.replaceChildren(fragment);
}

function createSessionAutomationOrphan(record) {
  const card = document.createElement("article");
  card.className = "automation-orphan-card";
  const main = document.createElement("div");
  main.className = "automation-orphan-main";
  main.appendChild(createText(
    "div",
    "automation-orphan-title",
    record.displayLabel || record.sessionId || record.agentId
  ));
  main.appendChild(createText(
    "div",
    "automation-orphan-meta",
    `${AGENT_LABELS[record.agentId] || record.agentId} · ${
      record.mode === "auto-tools"
        ? t("sessionAutomationAutoTools")
        : t("sessionAutomationAsk")
    }`
  ));
  card.appendChild(main);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t("sessionAutomationRevoke");
  const key = `grant:${record.sessionAutomationGrantId}`;
  const actionState = automationActionState(key);
  button.disabled = actionState.pending === true;
  main.appendChild(createText(
    "div",
    "session-automation-feedback",
    actionState.feedbackText
  ));
  button.addEventListener("click", async () => {
    if (!record.sessionAutomationGrantId) return;
    sessionAutomationActionState.set(key, {
      pending: true,
      feedbackText: "",
    });
    button.disabled = true;
    let result;
    try {
      result = await window.dashboardAPI.clearSessionAutomationGrant({
        grantId: record.sessionAutomationGrantId,
      });
    } catch (err) {
      console.warn("clear orphan session automation grant threw:", err);
      result = { status: "error" };
    }
    if (result && ["applied", "equivalent"].includes(result.status)) {
      sessionAutomationActionState.delete(key);
    } else {
      sessionAutomationActionState.set(key, {
        pending: false,
        feedbackText: t("sessionAutomationChangeFailed"),
      });
    }
    render();
  });
  card.appendChild(button);
  return card;
}

function appendSessionAutomationOrphans(fragment) {
  const orphans = Array.isArray(snapshot.sessionAutomationOrphans)
    ? snapshot.sessionAutomationOrphans
    : [];
  if (!orphans.length) return;
  const section = document.createElement("section");
  section.className = "group automation-orphans";
  section.appendChild(createText("h2", "group-title", t("sessionAutomationOrphansTitle")));
  section.appendChild(createText(
    "p",
    "automation-orphans-hint",
    t("sessionAutomationOrphansHint")
  ));
  const cards = document.createElement("div");
  cards.className = "cards";
  for (const record of orphans) cards.appendChild(createSessionAutomationOrphan(record));
  section.appendChild(cards);
  fragment.appendChild(section);
}

// ── Session history ──────────────────────────────────────────────────────
// Rows come from ~/.clawd/session-history-v1 via main. render() runs on a
// one-second tick and rebuilds the whole tree, so the list is fetched into
// this cache and re-read only on real changes — never once per frame.
let sessionHistory = [];
let sessionHistoryPending = false;
let sessionHistoryReloadRequested = false;
const sessionHistoryActionState = new Map();

function historyKey(row) {
  return row.historyKey;
}

async function reloadSessionHistory(options = {}) {
  if (!window.dashboardAPI || typeof window.dashboardAPI.getSessionHistory !== "function") return;
  if (sessionHistoryPending) {
    sessionHistoryReloadRequested = true;
    return;
  }
  sessionHistoryPending = true;
  try {
    do {
      sessionHistoryReloadRequested = false;
      const rows = await window.dashboardAPI.getSessionHistory();
      sessionHistory = Array.isArray(rows) ? rows : [];
    } while (sessionHistoryReloadRequested);
  } catch {
    sessionHistory = [];
  } finally {
    sessionHistoryPending = false;
  }
  // Drop feedback for rows that are gone so it cannot outlive its card.
  const live = new Set(sessionHistory.map(historyKey));
  for (const key of sessionHistoryActionState.keys()) {
    if (!live.has(key)) sessionHistoryActionState.delete(key);
  }
  for (const row of sessionHistory) {
    if (row.resumePending && !sessionHistoryActionState.has(historyKey(row))) {
      sessionHistoryActionState.set(historyKey(row), {
        status: "submitted", retryAt: row.resumeRetryAt,
      });
    }
  }
  if (options.rerender !== false) render();
}

function isHistoryResumePending(state, now = Date.now()) {
  return !!state && (state.status === "pending"
    || (state.status === "submitted" && now < state.retryAt));
}

async function resumeHistoryRow(row) {
  if (row.resumeDisabledReason) return;
  const key = historyKey(row);
  if (isHistoryResumePending(sessionHistoryActionState.get(key))) return;
  sessionHistoryActionState.set(key, { status: "pending" });
  render({ force: true });
  let result = null;
  try {
    result = await window.dashboardAPI.resumeSession({
      agentId: row.agentId,
      historyKey: row.historyKey,
    });
  } catch {
    result = null;
  }
  if (result && result.status === "submitted") {
    sessionHistoryActionState.set(key, { status: "submitted", retryAt: result.retryAt });
    render({ force: true });
    return;
  }
  if (result && result.status === "already-running") {
    sessionHistoryActionState.delete(key);
    sessionHistory = sessionHistory.filter((item) => historyKey(item) !== key);
    await reloadSessionHistory();
    return;
  }
  sessionHistoryActionState.set(key, { status: "error" });
  render({ force: true });
}

function createSessionHistoryCard(row, now) {
  const card = document.createElement("article");
  card.className = "session-history-card";

  const main = document.createElement("div");
  main.className = "session-history-main";
  main.appendChild(createText(
    "div",
    "session-history-title",
    row.title || row.sessionId
  ));

  const meta = document.createElement("div");
  meta.className = "session-history-meta";
  if (row.interrupted) {
    meta.appendChild(createText("span", "session-history-flag", t("dashboardHistoryInterrupted")));
  }
  // null means the probe could not tell; only a confident false warns.
  if (row.transcriptPresent === false) {
    meta.appendChild(createText(
      "span",
      "session-history-flag is-missing",
      t("dashboardHistoryTranscriptMissing")
    ));
  }
  if (row.resumeDisabledReason === "profile-unverified") {
    meta.appendChild(createText(
      "span",
      "session-history-flag is-missing",
      t("dashboardHistoryProfileUnverified")
    ));
  }
  const folder = sessionHistoryFolderLabel(row.cwd);
  const elapsed = formatElapsed(Math.max(0, now - row.lastEventAt));
  meta.appendChild(document.createTextNode(folder ? `${folder} · ${elapsed}` : elapsed));
  main.appendChild(meta);
  card.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "session-history-actions";
  const state = sessionHistoryActionState.get(historyKey(row)) || null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-history-resume";
  const pending = isHistoryResumePending(state, now);
  button.textContent = pending
    ? t("dashboardHistoryResuming")
    : t("dashboardHistoryResume");
  button.disabled = pending || !!row.resumeDisabledReason;
  button.addEventListener("click", () => { void resumeHistoryRow(row); });
  actions.appendChild(button);
  if (state && (state.status === "error" || (state.status === "submitted" && !pending))) {
    actions.appendChild(createText(
      "div",
      "session-history-feedback",
      t(state.status === "error" ? "dashboardHistoryResumeFailed" : "dashboardHistoryNotConfirmed")
    ));
  }
  card.appendChild(actions);
  return card;
}

function sessionHistoryFolderLabel(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

function appendSessionHistory(fragment, now) {
  // A queued disk read can finish after the hook has already put a session
  // on screen. Always apply the current live snapshot at render time too.
  const activeIds = new Set((snapshot.sessions || [])
    .filter((session) => session.agentId === "claude-code"
      && (session.profileId || "local") === "local" && !session.host && !session.wslDistro)
    .map((session) => session.rawSessionId));
  const rows = sessionHistory.filter((row) => !activeIds.has(row.sessionId));
  for (const id of activeIds) sessionHistoryActionState.delete(`claude-code\u0000${id}`);
  if (!rows.length) return;
  const section = document.createElement("section");
  section.className = "group session-history";
  section.appendChild(createText("h2", "group-title", t("dashboardHistoryTitle")));
  section.appendChild(createText("p", "session-history-hint", t("dashboardHistoryHint")));
  const cards = document.createElement("div");
  cards.className = "cards";
  for (const row of rows) cards.appendChild(createSessionHistoryCard(row, now));
  section.appendChild(cards);
  fragment.appendChild(section);
}

function createQuickTombstoneCard(entry, digit) {
  const card = document.createElement("article");
  card.className = "card card-unfocusable card-quick-tombstone";
  const badge = createText("span", "quick-digit-badge", String(digit));
  badge.setAttribute("aria-hidden", "true");
  card.appendChild(badge);
  const main = document.createElement("div");
  main.className = "main";
  main.appendChild(createText("div", "session-title", entry.title || entry.id));
  main.appendChild(createText("div", "meta", t("dashboardQuickSelectUnavailable")));
  card.appendChild(main);
  return card;
}

// Presentation skeleton for one round.
//
// Entering the mode must not rearrange the Dashboard the user is already
// looking at: the existing host groups, the order of the cards inside them and
// the scroll position all stay as they were. So the round snapshots the
// *presentation* (which group held which id, in which order) once, and renders
// from that for as long as the round lasts. Live fields still update every
// second; only the layout is pinned. Leaving the round drops the skeleton and
// the list goes back to following the shared snapshot's own ordering.
function captureQuickSkeleton() {
  const groups = deriveGroups(snapshot).map((group) => ({
    host: group.host || null,
    displayHost: group.displayHost || null,
    ids: (Array.isArray(group.ids) ? group.ids : []).slice(),
  }));
  const covered = new Set(groups.flatMap((group) => group.ids));
  // A numbered candidate can come from orderedIds/sessions without belonging
  // to any group; it still needs a stable home for the round.
  const ungrouped = quick.entries
    .map((entry) => entry && entry.id)
    .filter((id) => id && !covered.has(id));
  if (ungrouped.length) groups.push({ host: null, displayHost: null, ids: ungrouped });
  return { groups };
}

function quickGroupKey(group) {
  return (group && group.host) || "";
}

// One frozen group: its own ids in their frozen positions first, then any
// session that joined this group during the round appended after them.
function buildQuickFrozenGroup(frozen, currentGroup, byId, now, placed) {
  const cards = document.createElement("div");
  cards.className = "cards";
  let rendered = 0;

  for (const id of frozen.ids) {
    placed.add(id);
    const live = byId.get(id);
    if (live) {
      cards.appendChild(createCard(live, now));
      rendered += 1;
      continue;
    }
    // A numbered session that disappeared holds its own position as an
    // inactive placeholder, so nothing below it shifts up.
    const slot = quick.entries.findIndex((entry) => entry && entry.id === id);
    if (slot !== -1) {
      cards.appendChild(createQuickTombstoneCard(quick.entries[slot], slot + 1));
      rendered += 1;
    }
  }

  const currentIds = currentGroup && Array.isArray(currentGroup.ids) ? currentGroup.ids : [];
  for (const id of currentIds) {
    if (placed.has(id)) continue;
    placed.add(id);
    const live = byId.get(id);
    if (!live) continue;
    cards.appendChild(createCard(live, now));
    rendered += 1;
  }

  if (!rendered) return null;
  const section = document.createElement("section");
  section.className = "group";
  const host = (currentGroup && (currentGroup.displayHost || currentGroup.host))
    || frozen.displayHost
    || frozen.host
    || "";
  section.appendChild(createText("h2", "group-title", host || t("sessionLocal")));
  section.appendChild(cards);
  return section;
}

function appendPlainGroup(fragment, group, byId, now, placed) {
  const ids = Array.isArray(group.ids) ? group.ids : [];
  const groupSessions = ids
    .filter((id) => !placed || !placed.has(id))
    .map((id) => byId.get(id))
    .filter(Boolean);
  if (!groupSessions.length) return;
  if (placed) for (const session of groupSessions) placed.add(session.id);

  const section = document.createElement("section");
  section.className = "group";
  const host = group.displayHost || group.host || "";
  section.appendChild(createText("h2", "group-title", host || t("sessionLocal")));

  const cards = document.createElement("div");
  cards.className = "cards";
  for (const session of groupSessions) cards.appendChild(createCard(session, now));
  section.appendChild(cards);
  fragment.appendChild(section);
}

function appendSessionGroups(fragment, byId, now) {
  const skeleton = quick.active ? quick.skeleton : null;
  if (!skeleton) {
    for (const group of deriveGroups(snapshot)) {
      appendPlainGroup(fragment, group, byId, now, null);
    }
    return;
  }

  const currentGroups = deriveGroups(snapshot);
  const currentByKey = new Map(currentGroups.map((group) => [quickGroupKey(group), group]));
  const frozenKeys = new Set(skeleton.groups.map(quickGroupKey));
  const placed = new Set();

  for (const frozen of skeleton.groups) {
    const section = buildQuickFrozenGroup(
      frozen,
      currentByKey.get(quickGroupKey(frozen)),
      byId,
      now,
      placed
    );
    if (section) fragment.appendChild(section);
  }
  // Whole groups that appeared during the round are appended after the frozen
  // ones rather than pushing the existing context around.
  for (const group of currentGroups) {
    if (frozenKeys.has(quickGroupKey(group))) continue;
    appendPlainGroup(fragment, group, byId, now, placed);
  }
}

function hasFocusedSessionAutomationSelect() {
  const active = document.activeElement;
  return !!(
    active
    && active.tagName === "SELECT"
    && active.classList
    && active.classList.contains("session-automation-select")
    && contentEl.contains(active)
  );
}

function render(options = {}) {
  // A round that ended settles here if no scroll or layout signal closed it
  // first: the guard must never stay armed indefinitely.
  if (scrollGuard.settling) handleScrollSignal();
  // The one-second elapsed-time tick normally rebuilds the entire card tree.
  // Replacing a focused native <select> closes its open menu on Windows, so
  // defer ordinary snapshot/timer renders until the user finishes choosing.
  if ((activeEdit || hasFocusedSessionAutomationSelect()) && !options.force) return;
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const count = sessions.length;
  const now = Date.now();
  const liveAutomationActionKeys = new Set(
    sessions.map((session) => automationActionKey(session)).filter(Boolean)
  );
  for (const record of Array.isArray(snapshot.sessionAutomationOrphans)
    ? snapshot.sessionAutomationOrphans
    : []) {
    if (record && record.sessionAutomationGrantId) {
      liveAutomationActionKeys.add(`grant:${record.sessionAutomationGrantId}`);
    }
  }
  for (const key of sessionAutomationActionState.keys()) {
    if (!liveAutomationActionKeys.has(key)) sessionAutomationActionState.delete(key);
  }
  pruneSessionFolderActionState(sessions, now);
  if (activeView === "trellis") {
    titleEl.textContent = t("dashboardViewTrellis");
    countEl.textContent = "";
    document.title = t("dashboardViewTrellis");
  } else {
    titleEl.textContent = t("dashboardWindowTitle");
    countEl.textContent = t("dashboardCount").replace("{n}", count);
    document.title = t("dashboardWindowTitle");
  }
  if (viewSessionsTabEl) viewSessionsTabEl.textContent = t("dashboardViewSessions");
  if (viewTrellisTabEl) viewTrellisTabEl.textContent = t("dashboardViewTrellis");
  renderQuotaSummary(snapshot);
  renderTrellisPanel();
  renderTrellisDetail();
  renderTrellisView();

  renderQuickBanner();

  const orphanCount = Array.isArray(snapshot.sessionAutomationOrphans)
    ? snapshot.sessionAutomationOrphans.length
    : 0;
  // A round with a frozen presentation keeps rendering its own groups even if
  // every session in them disappeared — the numbered slots still belong to
  // this round and must not collapse into the generic empty state.
  if (count === 0 && orphanCount === 0 && !(quick.active && quick.skeleton)) {
    renderEmpty();
    return;
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const fragment = document.createDocumentFragment();

  // While a round is on, the groups come from its frozen presentation; the
  // ordinary dynamic ordering resumes as soon as it ends.
  appendSessionGroups(fragment, byId, now);
  appendSessionAutomationOrphans(fragment);
  appendSessionHistory(fragment, now);

  contentEl.replaceChildren(fragment);
  noteEnteringSessions(sessions);
}

async function init() {
  // Detail overlay dismissal: ESC (when the keyboard mode is not holding the
  // key) and a click on the dimmed backdrop outside the card.
  if (typeof document.addEventListener === "function") {
    document.addEventListener("keydown", (event) => {
      if (!trellisDetail.open && !trellisSpec.open && !trellisNetwork.open) return;
      if (quick.active || quick.pending) return;
      if (event.key === "Escape") {
        closeTrellisDetail();
      }
    });
  }
  // v6 split-mode keyboard navigation: ↑/↓ move the selection across the
  // visible rows in group order, Enter opens the full detail overlay, Esc
  // clears the selection (never the window). Only active while the split
  // view is the current tab and no overlay/quick mode holds the key.
  // Since v7 the detail card lives EMBEDDED in the split pane (open on
  // every selection) and spec/relations are left-column groups — none of
  // them owns the keyboard — so only a true overlay (non-embedded detail
  // card) or quick mode blocks navigation (09-25 split polish).
  if (typeof document.addEventListener === "function") {
    document.addEventListener("keydown", (event) => {
      if (activeView !== "trellis") return;
      if (trellisDetail.open && !trellisDetail.embedded) return;
      if (quick.active || quick.pending) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== "Escape") return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveTrellisSplitSelection(-1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        moveTrellisSplitSelection(1);
      } else if (event.key === "Enter") {
        const rows = visibleTrellisRows(readTrellisTaskRows());
        for (const row of rows) {
          if (row.classList.contains("is-selected")) {
            event.preventDefault();
            row.dispatchEvent(new CustomEvent("dblclick", { bubbles: false }));
            break;
          }
        }
      } else if (event.key === "Escape") {
        if (trellisSplit.selectedTaskPath !== null) {
          event.preventDefault();
          selectTrellisSplitTask(null);
        }
      }
    });
  }
  // v7 R8: the network overview is an inline drawer (no overlay host,
  // no backdrop); Esc above still closes it.
  if (trellisDetailOverlayEl && typeof trellisDetailOverlayEl.addEventListener === "function") {
    trellisDetailOverlayEl.addEventListener("click", (event) => {
      if (event.target === trellisDetailOverlayEl) closeTrellisDetail();
    });
  }
  window.dashboardAPI.onLangChange((payload) => {
    i18nPayload = payload || i18nPayload;
    render();
    syncKimiQuotaRefreshControl();
  });
  window.dashboardAPI.onSessionSnapshot((nextSnapshot) => {
    const hadKimiQuota = snapshotHasKimiQuota(snapshot);
    const previousSessionKey = liveSessionKey(snapshot);
    snapshot = nextSnapshot || snapshot;
    if (hadKimiQuota !== snapshotHasKimiQuota(snapshot)) {
      void reloadKimiQuotaStatus();
    }
    if (previousSessionKey !== liveSessionKey(snapshot)) {
      void reloadSessionHistory({ rerender: false });
    }
    if (activeEdit && !snapshotHasSession(snapshot, activeEdit.sessionId)) {
      activeEdit = null;
      render({ force: true });
      return;
    }
    render();
  });

  initDashboardViewSwitch();

  const [nextI18n, nextSnapshot, nextKimiQuotaStatus] = await Promise.all([
    window.dashboardAPI.getI18n(),
    window.dashboardAPI.getSnapshot(),
    window.dashboardAPI && typeof window.dashboardAPI.getKimiQuotaStatus === "function"
      ? window.dashboardAPI.getKimiQuotaStatus()
      : Promise.resolve(null),
  ]);
  i18nPayload = nextI18n || i18nPayload;
  snapshot = nextSnapshot || snapshot;
  kimiQuotaStatus = nextKimiQuotaStatus || null;
  render();
  void reloadSessionHistory();

  setInterval(render, 1000);

  initQuickMode();
}

function initQuickMode() {
  const api = window.dashboardAPI;
  // Linux never registers the shortcut and never exposes these channels; the
  // shared page simply stays an ordinary Dashboard there.
  if (!api || typeof api.quickEnter !== "function") return;

  // Anything that starts real text entry during the 120ms quiet period must
  // drop the queued jump: the user is typing, not navigating.
  document.addEventListener("compositionstart", () => {
    composing = true;
    cancelPendingActivation();
  });
  document.addEventListener("compositionend", () => { composing = false; });
  document.addEventListener("compositionupdate", cancelPendingActivation);
  document.addEventListener("focusin", (event) => {
    if (isEditableElement(event && event.target)) cancelPendingActivation();
  });
  document.addEventListener("input", cancelPendingActivation);
  // Capture phase so the mode sees keys before page controls, while still
  // deferring to any focused editable target.
  document.addEventListener("keydown", handleQuickKeydown, true);
  document.addEventListener("keyup", handleQuickKeyup, true);
  // A real page blur cancels an unsubmitted jump; main ends the round too.
  window.addEventListener("blur", cancelPendingActivation);
  window.addEventListener("beforeunload", cancelPendingActivation);

  // Scroll continuity (see the guard near the top of this file): these are the
  // signals a host transfer produces, plus the gestures that must always win
  // over the remembered offset. Scrolling keys are handled in
  // handleQuickKeydown, which is on document capture and therefore sees a key
  // whatever it is aimed at.
  if (contentEl && typeof contentEl.addEventListener === "function") {
    // Passive: these only read state, and a non-passive wheel listener would
    // make the compositor wait for JS on every scroll.
    contentEl.addEventListener(
      "scroll",
      () => { handleScrollSignal({ fromScrollEvent: true }); },
      { passive: true }
    );
    // Chromium fires `scrollend` once a scroll and any animation it started
    // have finished (shipped in Chrome 114; this app runs a much newer
    // Chromium). Where it is missing, a reversal still ends the gesture.
    contentEl.addEventListener("scrollend", endScrollGesture, { passive: true });
    contentEl.addEventListener("wheel", () => noteScrollIntent(), { passive: true });
    contentEl.addEventListener("pointerdown", () => { scrollGuard.held = true; }, { passive: true });
    // A drag usually ends outside the scroller, so the release is watched on
    // the document.
    document.addEventListener("pointerup", endScrollHold, { passive: true });
    document.addEventListener("pointercancel", endScrollHold, { passive: true });
    // A key that scrolls can be aimed anywhere, so it is marked from the
    // document-capture handler in handleQuickKeydown, not from here.
    if (typeof ResizeObserver === "function") {
      try {
        // Entering or leaving the mode re-lays the scroller out (the banner
        // alone changes its height), so this fires right after the layout that
        // could have dropped the offset.
        new ResizeObserver(() => { handleScrollSignal(); }).observe(contentEl);
      } catch { /* no observer: the scroll signal still covers the usual case */ }
    }
  }

  api.onQuickIntent((payload) => {
    void beginQuickRound(payload && payload.revision);
  });
  api.onQuickEntries((payload) => {
    if (!payload || !quick.active || payload.revision !== quick.revision) return;
    quick.entries = Array.isArray(payload.entries) ? payload.entries : [];
    render();
  });
  api.onQuickDismissed((payload) => {
    // Strictly the round that ended: a late dismissal cannot cancel a new one.
    if (!payload || payload.revision !== quick.revision) return;
    endQuickRound();
  });

  // A shortcut pressed while this page was still loading left a pending round.
  if (typeof api.quickPending === "function") {
    api.quickPending().then((result) => {
      if (result && result.status === "ok" && result.revision) {
        void beginQuickRound(result.revision);
      }
    }).catch(() => {});
  }
}

init().catch((err) => {
  contentEl.textContent = err && err.message ? err.message : String(err);
});
