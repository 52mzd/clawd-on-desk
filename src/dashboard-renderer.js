"use strict";

const { canOfferLocalFolder, focusUnavailableReasonKey } = globalThis.ClawdSessionFocusUnavailable;
const {
  aggregateTrellisTasks,
  groupTrellisTasks,
  groupTrellisArchiveByMonth,
  buildTrellisTree,
  trellisArchiveMonthOf,
  trellisTaskOwningRoot,
  filterTrellisTasksByRoot,
  buildTrellisRootLabels,
  bucketByBoardPhase,
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
const trellisSpecOverlayEl = document.getElementById("trellisSpecOverlay");
const trellisNetworkOverlayEl = document.getElementById("trellisNetworkOverlay");
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
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (!/^[1-9]$/.test(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const physicalKey = physicalDigit(event);
  if (physicalKey) quick.held.add(physicalKey);
  clearQuickTimer();
  // First target wins for the whole hold; auto-repeat never re-targets.
  if (quick.pending || event.repeat) return;
  const entry = quick.entries[Number(event.key) - 1];
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
  // v5-b display mode: "tree" (default, the classic nesting) or
  // "board" (phase columns). Session-level like selectedRoot — the
  // localStorage bridge below only caches it for reloads of the same
  // window; it never leaves the renderer.
  mode: (() => {
    try {
      // v6: "board" was the v5-b layout; read it back as "split" (the
      // master-detail successor). "tree" stays "tree".
      const stored = window.localStorage && window.localStorage.getItem("trellisViewMode");
      return stored === "board" || stored === "split" ? "split" : "tree";
    } catch {
      return "tree";
    }
  })(),
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
  if (!binding.canFocus) chip.disabled = true;
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
  for (const groupRow of groupTrellisTasks(tasks)) {
    fragment.appendChild(createTrellisTaskRow(groupRow));
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

async function addTrellisRootViaPicker() {
  let result = null;
  try {
    if (typeof window.dashboardAPI.addTrellisRoot !== "function") {
      throw new Error("bridge-unavailable");
    }
    result = await window.dashboardAPI.addTrellisRoot();
  } catch {
    result = null;
  }
  // A cancelled picker is silent; an actual failure surfaces as the roots
  // error row (same treatment as a failed roots-list read).
  if (result && typeof result === "object" && result.status === "ok") {
    refreshTrellisView();
  } else if (result && typeof result === "object" && result.status === "no-projects") {
    trellisView.rootsError = false;
    trellisView.noProjectsHint = true;
    lastTrellisViewSignature = null;
    renderTrellisView();
  } else if (result && typeof result === "object" && result.status === "limit") {
    trellisView.rootsError = true;
    lastTrellisViewSignature = null;
    renderTrellisView();
  }
}

async function removeTrellisRootFromRow(root) {
  let result = null;
  try {
    if (typeof window.dashboardAPI.removeTrellisRoot !== "function") {
      throw new Error("bridge-unavailable");
    }
    result = await window.dashboardAPI.removeTrellisRoot(root);
  } catch {
    result = null;
  }
  if (result && typeof result === "object" && result.status === "ok") {
    refreshTrellisView();
  } else {
    trellisView.rootsError = true;
    lastTrellisViewSignature = null;
    renderTrellisView();
  }
}

async function removeTrellisPickFromRow(picked) {
  let result = null;
  try {
    if (typeof window.dashboardAPI.removeTrellisPick !== "function") {
      throw new Error("bridge-unavailable");
    }
    result = await window.dashboardAPI.removeTrellisPick(picked);
  } catch {
    result = null;
  }
  if (result && typeof result === "object" && result.status === "ok") {
    refreshTrellisView();
  } else {
    trellisView.rootsError = true;
    lastTrellisViewSignature = null;
    renderTrellisView();
  }
}

// ── Trellis task tree (independent view) ───────────────────────────────
// One buildTrellisTree pass nests the (root-filtered) active + archive
// lists; rendering is recursive DOM — each node is a row plus a bordered
// children container (CSS indent + connector line), so collapsing a
// subtree means simply not building its container. Expansion lives in
// session memory keyed by taskPath: a Map of explicit overrides on top
// of the per-node default (active branches expand, archive branches
// start collapsed). Clicking a branch row (or its caret) toggles it;
// leaf rows keep the v2 click semantics (open the detail overlay), and
// the ⓘ button stays on every row so a collapsed branch still opens it.
const trellisTreeExpanded = new Map(); // taskPath → boolean override

function trellisTreeIsExpanded(node) {
  const override = trellisTreeExpanded.get(node.task.taskPath);
  if (typeof override === "boolean") return override;
  return !node.archived;
}

function toggleTrellisTreeNode(node) {
  trellisTreeExpanded.set(node.task.taskPath, !trellisTreeIsExpanded(node));
  lastTrellisViewSignature = null;
  renderTrellisView();
}

// expand-all / collapse-all: set the override on every branch node of the
// given roots (leaf overrides are meaningless), then repaint once.
function setTrellisTreeAllExpanded(roots, expanded) {
  const stack = [...roots];
  while (stack.length) {
    const node = stack.pop();
    if (node.children.length) trellisTreeExpanded.set(node.task.taskPath, expanded);
    stack.push(...node.children);
  }
  lastTrellisViewSignature = null;
  renderTrellisView();
}

function createTrellisTreeCaret(node) {
  const caret = document.createElement("button");
  caret.type = "button";
  caret.className = "trellis-tree-caret";
  caret.textContent = trellisTreeIsExpanded(node) ? "▾" : "▸";
  caret.setAttribute("aria-expanded", trellisTreeIsExpanded(node) ? "true" : "false");
  caret.setAttribute("data-open", trellisTreeIsExpanded(node) ? "true" : "false");
  const label = node.task.title || node.task.taskPath;
  caret.title = label;
  caret.setAttribute("aria-label", label);
  caret.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleTrellisTreeNode(node);
  });
  return caret;
}

function openTrellisDetailFromNode(node) {
  const task = node.task;
  if (node.archived) {
    // Archived rows carry the cwd their archive scan resolved; no live
    // binding exists to donate one (same payload as the v2 archive row).
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

// v5-b board cards: same detail-open payload as the tree rows — archived
// tasks go through the cwd-carrying shape, active ones pass the row task.
function openTrellisDetailFromTask(task) {
  if (!task) return;
  // v6.1: in split view the detail card renders INSIDE the right pane
  // (embedded); tree view keeps the overlay popup.
  const opts = trellisView.mode === "split" ? { embedded: true } : undefined;
  if (task.completedAt) {
    void openTrellisDetail({
      taskPath: task.taskPath,
      title: task.title || "",
      cwd: task.cwd || "",
      sessions: [],
      progress: null,
    }, opts);
    return;
  }
  void openTrellisDetail(task, opts);
}

function createTrellisTreeNodeRow(node, projectLabel) {
  const task = node.task;
  const row = document.createElement("div");
  row.className = node.archived ? "trellis-archive-row" : "trellis-task-row";
  if (node.children.length) row.classList.add("trellis-task-row-group");
  if (!node.archived) row.title = trellisTaskRowTitle(task);

  const main = document.createElement("div");
  main.className = node.archived ? "trellis-archive-main" : "trellis-task-main";
  main.appendChild(
    node.children.length ? createTrellisTreeCaret(node) : createText("span", "trellis-tree-caret-spacer", "")
  );

  if (node.archived) {
    main.appendChild(createText("span", "trellis-archive-title", task.title || task.taskPath));
    if (projectLabel) {
      main.appendChild(createText("span", "trellis-task-project", projectLabel));
    }
    const meta = document.createElement("span");
    meta.className = "trellis-archive-meta";
    const completed = trellisArchiveCompletedLabel(task);
    if (completed) {
      meta.appendChild(createText(
        "span",
        "trellis-archive-date",
        t("dashboardTrellisDetailCompleted").replace("{date}", completed)
      ));
    }
    meta.appendChild(createText(
      "span",
      "trellis-archive-duration",
      formatTrellisArchiveDuration(task.durationMs)
    ));
    main.appendChild(meta);
  } else {
    main.appendChild(createText("span", "trellis-task-title", task.title || task.taskPath));
    if (projectLabel) {
      main.appendChild(createText("span", "trellis-task-project", projectLabel));
    }
    const badge = TRELLIS_PHASE_BADGE[task.phase];
    if (badge) {
      main.appendChild(createText("span", `trellis-phase-badge ${badge.cls}`, t(badge.labelKey)));
    }
    // A branch row answers for its subtree (archived children carry no
    // progress, so they never skew the sum); childless rows keep the
    // plain task progress.
    if (node.childSummary) {
      main.appendChild(createText(
        "span",
        "trellis-task-group-summary",
        t("dashboardTrellisGroupProgress")
          .replace("{done}", String(node.childSummary.done))
          .replace("{total}", String(node.childSummary.total))
      ));
    } else if (task.progress) {
      appendTrellisProgressWithTicks(main, task.progress);
    }
  }

  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "trellis-task-detail-btn";
  detailBtn.textContent = "ⓘ";
  detailBtn.title = t("dashboardTrellisDetailOpen");
  detailBtn.setAttribute("aria-label", t("dashboardTrellisDetailOpen"));
  detailBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openTrellisDetailFromNode(node);
  });
  main.appendChild(detailBtn);

  // v4-b: structured linkage affordance — only when the row's task.json
  // actually declares a parent or children (activity flags it).
  const wantsLinks = node.archived
    ? (task.parent || task.hasChildren)
    : (task.parent || task.hasChildren);
  if (wantsLinks) {
    const linksBtn = document.createElement("button");
    linksBtn.type = "button";
    linksBtn.className = "trellis-task-detail-btn";
    linksBtn.textContent = "⛓";
    linksBtn.title = t("dashboardTrellisLinksOpen");
    linksBtn.setAttribute("aria-label", t("dashboardTrellisLinksOpen"));
    linksBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openTrellisNetwork({
        taskPath: task.taskPath,
        title: task.title || "",
        cwd: task.cwd || "",
      });
    });
    main.appendChild(linksBtn);
  }
  row.appendChild(main);

  row.addEventListener("click", () => {
    if (node.children.length) {
      toggleTrellisTreeNode(node);
      return;
    }
    openTrellisDetailFromNode(node);
  });
  return row;
}

function createTrellisTreeNodeEl(node, labels, depth = 0) {
  const wrapper = document.createElement("div");
  wrapper.className = "trellis-tree-node";
  const row = createTrellisTreeNodeRow(node, trellisRowProjectLabel(node.task, labels));
  row.setAttribute("data-depth", String(Math.min(depth, 5)));
  wrapper.appendChild(row);
  if (node.children.length && trellisTreeIsExpanded(node)) {
    const kids = document.createElement("div");
    kids.className = "trellis-tree-children";
    for (const child of node.children) {
      kids.appendChild(createTrellisTreeNodeEl(child, labels, depth + 1));
    }
    wrapper.appendChild(kids);
  }
  return wrapper;
}

function appendTrellisTreeTools(titleRow, roots) {
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "trellis-tree-tool";
  expand.textContent = t("dashboardTrellisTreeExpandAll");
  expand.addEventListener("click", () => {
    setTrellisTreeAllExpanded(roots, true);
  });
  titleRow.appendChild(expand);
  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "trellis-tree-tool";
  collapse.textContent = t("dashboardTrellisTreeCollapseAll");
  collapse.addEventListener("click", () => {
    setTrellisTreeAllExpanded(roots, false);
  });
  titleRow.appendChild(collapse);
}

function buildTrellisRootsSection() {
  const section = document.createElement("div");
  section.className = "trellis-view-section";

  const titleRow = document.createElement("div");
  titleRow.className = "trellis-view-section-title";
  titleRow.appendChild(createText("span", "trellis-roots-title", t("dashboardTrellisRootsTitle")));
  const add = document.createElement("button");
  add.type = "button";
  add.className = "trellis-view-add-root";
  add.textContent = t("dashboardTrellisRootsAdd");
  add.addEventListener("click", () => {
    void addTrellisRootViaPicker();
  });
  titleRow.appendChild(add);
  // v4-a: browse this project's .trellis/spec in the spec-map overlay.
  if (trellisView.roots.length > 0) {
    const spec = document.createElement("button");
    spec.type = "button";
    spec.className = "trellis-view-add-root";
    spec.textContent = t("dashboardTrellisSpecOpen");
    spec.addEventListener("click", () => {
      openTrellisSpec(trellisView.selectedRoot || trellisView.roots[0]);
    });
    titleRow.appendChild(spec);
  }
  section.appendChild(titleRow);

  if (trellisView.rootsError) {
    section.appendChild(createText("div", "trellis-view-error", t("dashboardTrellisRootsError")));
  } else if (trellisView.noProjectsHint) {
    section.appendChild(createText("div", "trellis-view-empty", t("dashboardTrellisRootsNoProjects")));
  } else if (!trellisView.roots.length) {
    section.appendChild(createText("div", "trellis-view-empty", t("dashboardTrellisRootsEmptyHint")));
  } else {
    // Managed entries render as the folder the user PICKED (one row, one
    // remove button — removing drops every root that pick registered).
    // Roots without a pick entry (session-resolved / legacy persisted)
    // render individually so nothing becomes unmanageable.
    const pickRoots = new Set();
    for (const pick of trellisView.picks) {
      for (const r of pick.roots) pickRoots.add(r);
    }
    for (const pick of trellisView.picks) {
      const row = document.createElement("div");
      row.className = "trellis-root-row";
      const pathEl = createText("span", "trellis-root-path", pick.picked);
      pathEl.title = `${pick.picked}\n→ ${pick.roots.length} ${t("dashboardTrellisRootsPickCount")}`;
      row.appendChild(pathEl);
      const count = createText("span", "trellis-root-count", `×${pick.roots.length}`);
      row.appendChild(count);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "trellis-root-remove";
      remove.textContent = t("dashboardTrellisRootsRemove");
      remove.addEventListener("click", () => {
        void removeTrellisPickFromRow(pick.picked);
      });
      row.appendChild(remove);
      section.appendChild(row);
    }
    for (const root of trellisView.roots) {
      if (pickRoots.has(root)) continue;
      const row = document.createElement("div");
      row.className = "trellis-root-row";
      const pathEl = createText("span", "trellis-root-path", root);
      pathEl.title = root;
      row.appendChild(pathEl);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "trellis-root-remove";
      remove.textContent = t("dashboardTrellisRootsRemove");
      remove.addEventListener("click", () => {
        void removeTrellisRootFromRow(root);
      });
      row.appendChild(remove);
      section.appendChild(row);
    }
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

function setTrellisViewMode(mode) {
  const next = mode === "split" ? "split" : "tree";
  if (next === trellisView.mode) return;
  trellisView.mode = next;
  // One-shot: the split pane's group-stagger plays on mode entry only —
  // later rebuilds (selection clicks, refresh ticks) must not replay it.
  trellisSplit.entryPending = next === "split";
  trellisSplit.selectedTaskPath = null;
  try {
    if (window.localStorage) window.localStorage.setItem("trellisViewMode", next);
  } catch {
    /* storage unavailable — session-only */
  }
  lastTrellisPanelSignature = null;
  renderTrellisViewBody();
}

// v5-b phase board: five flow columns (plan/execute/check/finish/done ≈
// archived). Pure render-mode switch over the same filtered task lists the
// tree uses — no new IPC, no data shape changes. FLIP move animation on
// phase changes, stagger entrance, hover lift — all CSS, all gated on
// prefers-reduced-motion.
const TRELLIS_BOARD_COLUMNS = [
  { phase: "plan", labelKey: "dashboardTrellisPhasePlan" },
  { phase: "execute", labelKey: "dashboardTrellisPhaseExecute" },
  { phase: "check", labelKey: "dashboardTrellisPhaseCheck" },
  { phase: "finish", labelKey: "dashboardTrellisPhaseFinish" },
  { phase: "done", labelKey: "dashboardTrellisPhaseArchived" },
];
const TRELLIS_BOARD_CARD_LIMIT = 30; // per column — perf guard for hover glow

function buildTrellisBoardCard(task) {
  const card = document.createElement("div");
  card.className = "trellis-board-card";
  card.dataset.taskPath = task.taskPath || "";

  const title = document.createElement("div");
  title.className = "trellis-board-card-title";
  title.appendChild(document.createTextNode(task.title || task.taskPath || "?"));
  card.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "trellis-board-card-meta";
  if (task.progress) {
    const ticks = buildTrellisProgressTicks(task.progress);
    if (ticks) meta.appendChild(ticks);
    meta.appendChild(createText(
      "span",
      "trellis-task-progress",
      `${task.progress.done}/${task.progress.total}`
    ));
  }
  if (task.parent) {
    meta.appendChild(createText("span", "trellis-board-card-parent", "↳ " + task.parent));
  }
  if (task.completedAt) {
    meta.appendChild(createText("span", "trellis-board-card-date", task.completedAt));
  }
  card.appendChild(meta);

  // Same affordances as tree rows: ⛓ links when linkage exists, ⓘ detail.
  const actions = document.createElement("div");
  actions.className = "trellis-board-card-actions";
  if (task.parent || task.hasChildren) {
    const links = document.createElement("button");
    links.type = "button";
    links.className = "trellis-task-detail-btn";
    links.textContent = "⛓";
    links.title = t("dashboardTrellisLinksOpen");
    links.addEventListener("click", (event) => {
      event.stopPropagation();
      openTrellisNetwork({ taskPath: task.taskPath, title: task.title || "", cwd: task.cwd || "" });
    });
    actions.appendChild(links);
  }
  const detail = document.createElement("button");
  detail.type = "button";
  detail.className = "trellis-task-detail-btn";
  detail.textContent = "ⓘ";
  detail.title = t("dashboardTrellisDetailOpen");
  detail.addEventListener("click", (event) => {
    event.stopPropagation();
    void openTrellisDetailFromTask(task);
  });
  actions.appendChild(detail);
  card.appendChild(actions);

  card.addEventListener("click", () => {
    void openTrellisDetailFromTask(task);
  });
  return card;
}

// v6 master-detail split state. Session-level, never persisted. Entry
// stagger is one-shot (flag consumed by the builder); archive group starts
// collapsed every session.
const trellisSplit = {
  selectedTaskPath: null,
  archiveOpen: false,
  entryPending: false,
  // Expanded-by-default hierarchy: paths in this set are COLLAPSED.
  collapsedPaths: new Set(),
  // taskPath -> panel task object (flat, both groups); lets the detail
  // card reopen from selection alone without re-deriving from the tree.
  tasksByPath: new Map(),
};

function selectTrellisSplitTask(taskPath) {
  const next = typeof taskPath === "string" ? taskPath : null;
  // Idempotent re-click: only early-return when the detail card is already
  // showing for this selection (or both are empty). A same-path click with
  // a closed card (fetch failed / closed) must retry the open.
  if (
    next === trellisSplit.selectedTaskPath &&
    (next === null ? !(trellisDetail.open || trellisDetail.embedded) : trellisDetail.open)
  ) {
    return;
  }
  trellisSplit.selectedTaskPath = next;
  // The detail card lifecycle follows the selection: rebuild resets any
  // stale embedded card, then buildTrellisSplitDetailPane() re-opens the
  // FULL detail card inside the pane for the new selection (no overlay).
  resetTrellisDetailState();
  lastTrellisPanelSignature = null;
  renderTrellisViewBody();
}

function toggleTrellisSplitArchive() {
  trellisSplit.archiveOpen = !trellisSplit.archiveOpen;
  lastTrellisPanelSignature = null;
  renderTrellisViewBody();
}

// Keyboard navigation across the VISIBLE rows in group order — derived
// from the DOM so it can never drift from what is actually rendered
// (collapsed archive group simply has no rows in the DOM).
function moveTrellisSplitSelection(delta) {
  const rows = trellisViewEl
    ? trellisViewEl.querySelectorAll(".trellis-split-row[data-task-path]")
    : [];
  if (rows.length === 0) return;
  const paths = [...rows].map((r) => r.dataset.taskPath);
  const index = paths.indexOf(trellisSplit.selectedTaskPath);
  const nextIndex = index === -1
    ? (delta > 0 ? 0 : paths.length - 1)
    : Math.min(Math.max(index + delta, 0), paths.length - 1);
  if (paths[nextIndex] !== trellisSplit.selectedTaskPath) {
    selectTrellisSplitTask(paths[nextIndex]);
    const row = rows[nextIndex];
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }
}

function buildTrellisSplitRow(task, meta) {
  const row = document.createElement("div");
  row.className = "trellis-split-row";
  row.dataset.taskPath = task.taskPath || "";
  if (task.taskPath === trellisSplit.selectedTaskPath) {
    row.classList.add("is-selected");
  }
  if (task.phase === "done") row.classList.add("is-archived");
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
    caret.setAttribute("aria-label", t("dashboardTrellisSplitToggle"));
    caret.appendChild(document.createTextNode("▾"));
    caret.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (trellisSplit.collapsedPaths.has(task.taskPath)) {
        trellisSplit.collapsedPaths.delete(task.taskPath);
      } else {
        trellisSplit.collapsedPaths.add(task.taskPath);
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
  main.appendChild(createText("span", "trellis-split-row-title", task.title || task.taskPath || "?"));
  const subBits = [];
  if (task.sessions && task.sessions.length > 0) {
    subBits.push(t("dashboardTrellisBoundSessions").replace("{n}", String(task.sessions.length)));
  }
  const childCount = meta && meta.hasChildren && Number.isFinite(meta.childCount) ? meta.childCount : null;
  if (meta && meta.hasChildren) {
    subBits.push(t("dashboardTrellisSplitChildren").replace("{n}", String(childCount != null ? childCount : "")));
  }
  if (subBits.length > 0) {
    main.appendChild(createText("span", "trellis-split-row-sub", subBits.join(" · ")));
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
    selectTrellisSplitTask(task.taskPath);
  });
  row.addEventListener("dblclick", () => {
    // v6.1: full detail renders IN the right pane — no overlay popup.
    selectTrellisSplitTask(task.taskPath);
  });
  return row;
}

function buildTrellisSplitDetailPane(task) {
  const pane = document.createElement("div");
  pane.className = "trellis-split-detail";
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
  if (
    trellisDetail.open &&
    trellisDetail.embedded &&
    trellisDetail.request &&
    trellisDetail.request.taskPath === task.taskPath
  ) {
    pane.appendChild(buildTrellisDetailCard());
  } else {
    void openTrellisDetail(task, { embedded: true });
  }
  return pane;
}


// ↻ archive refresh button (v7 R3): migrates the retired archive section's
// reload entry into the split list's DONE group head. stopPropagation keeps
// the group-toggle handler out of the click.
function buildTrellisSplitRefreshBtn() {
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "trellis-split-refresh";
  refresh.textContent = "↻";
  refresh.title = t("dashboardTrellisArchivedRefresh");
  refresh.setAttribute("aria-label", t("dashboardTrellisArchivedRefresh"));
  refresh.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void refreshTrellisViewArchive();
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
      // field (same semantics as bucketByBoardPhase: archiving is a status,
      // not a phase transition).
      const phase = forcedPhase || rows[i].task.phase || "plan";
      if (!map.has(phase)) map.set(phase, []);
      map.get(phase).push(rows.slice(i, end));
      i = end;
    }
    return map;
  };
  const activeRoots = rootsByPhase(groupTrellisTasks(activeTasks));
  const archiveRoots = rootsByPhase(groupTrellisTasks(archiveTasks), "done");

  const listPane = document.createElement("div");
  listPane.className = "trellis-split-list";
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
  const renderSubtree = (subtree, startIdx, rootDepth, ancestorsExpanded) => {
    let i = startIdx;
    while (i < subtree.length && subtree[i].depth > rootDepth) {
      const rowMeta = subtree[i];
      if (ancestorsExpanded) {
        trellisSplit.tasksByPath.set(rowMeta.task.taskPath, rowMeta.task);
        if (rowMeta.task.taskPath === trellisSplit.selectedTaskPath) selectedTask = rowMeta.task;
        listPane.appendChild(buildTrellisSplitRow(rowMeta.task, rowMeta));
      }
      i = renderSubtree(
        subtree,
        i + 1,
        subtree[i].depth,
        ancestorsExpanded && !trellisSplit.collapsedPaths.has(rowMeta.task.taskPath)
      );
    }
    return i;
  };

  for (const group of groups) {
    const subtrees = (group.phase === "done" ? archiveRoots : activeRoots).get(group.phase) || [];
    if (group.phase === "done") {
      for (const subtree of subtrees) archiveCount += subtree.length;
    } else {
      activeCount += subtrees.length;
    }
    // finish (completed-but-unarchived) is practically always empty in
    // this repo's flow — a permanently empty placeholder reads as noise.
    if (group.phase === "finish" && subtrees.length === 0) continue;
    if (group.phase === "done" && !trellisSplit.archiveOpen && subtrees.length > 0) {
      const collapsed = document.createElement("button");
      collapsed.type = "button";
      collapsed.className = "trellis-split-group-head trellis-split-group-toggle is-collapsed";
      collapsed.style.setProperty("--split-group-index", String(groupIndex));
      collapsed.appendChild(createText("span", "trellis-split-group-caret", "▾"));
      collapsed.appendChild(createText("span", "trellis-split-group-title", t(group.labelKey)));
      collapsed.appendChild(createText("span", "trellis-split-group-count", String(subtrees.length)));
      // ↻ refresh lives next to the collapsed head so archived data is
      // always reloadable without expanding first (v7 R3).
      collapsed.appendChild(buildTrellisSplitRefreshBtn());
      collapsed.addEventListener("click", toggleTrellisSplitArchive);
      listPane.appendChild(collapsed);
      groupIndex += 1;
      continue;
    }
    if (subtrees.length > 0 || group.phase !== "done") {
      const head = document.createElement("div");
      head.className = "trellis-split-group-head";
      head.style.setProperty("--split-group-index", String(groupIndex));
      if (group.phase === "done" && trellisSplit.archiveOpen) {
        head.classList.add("trellis-split-group-toggle");
        head.addEventListener("click", toggleTrellisSplitArchive);
        head.appendChild(createText("span", "trellis-split-group-caret", "▾"));
      }
      head.appendChild(createText("span", "trellis-split-group-title", t(group.labelKey)));
      if (subtrees.length > 0) {
        // Group count shows ROOT tasks — children live behind carets.
        head.appendChild(createText("span", "trellis-split-group-count", String(subtrees.length)));
      }
      if (group.phase === "done") {
        head.appendChild(buildTrellisSplitRefreshBtn());
        // Error / loading hints next to the refresh (v7 R3, migrated from
        // the retired archive section).
        const archiveState = trellisView.archive;
        if (archiveState.error) {
          head.appendChild(createText("span", "trellis-split-archive-hint is-error", t("dashboardTrellisArchivedError")));
        } else if (archiveState.loading) {
          head.appendChild(createText("span", "trellis-split-archive-hint", t("dashboardTrellisArchivedLoading")));
        }
      }
      listPane.appendChild(head);
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
        monthHead.className = "trellis-split-month-head" + (monthOpen ? "" : " is-collapsed");
        monthHead.appendChild(createText("span", "trellis-split-caret", monthOpen ? "▾" : "▸"));
        monthHead.appendChild(createText(
          "span",
          "trellis-split-month-label",
          `${month || t("dashboardTrellisArchivedUnknownMonth")} · ${byMonth.get(month).length}`
        ));
        monthHead.addEventListener("click", () => {
          const state = trellisView.archive;
          if (state.openMonths === null) state.openMonths = new Set(months);
          if (state.openMonths.has(month)) {
            state.openMonths.delete(month);
          } else {
            state.openMonths.add(month);
          }
          lastTrellisPanelSignature = null;
          renderTrellisViewBody();
        });
        listPane.appendChild(monthHead);
        if (monthOpen) {
          for (const subtree of byMonth.get(month)) {
            const rootMeta = subtree[0];
            trellisSplit.tasksByPath.set(rootMeta.task.taskPath, rootMeta.task);
            if (rootMeta.task.taskPath === trellisSplit.selectedTaskPath) selectedTask = rootMeta.task;
            listPane.appendChild(buildTrellisSplitRow(rootMeta.task, rootMeta));
            renderSubtree(subtree, 1, rootMeta.depth, !trellisSplit.collapsedPaths.has(rootMeta.task.taskPath));
          }
        } else {
          // keep collapsed months' tasks selectable via keyboard nav map
          for (const subtree of byMonth.get(month)) {
            trellisSplit.tasksByPath.set(subtree[0].task.taskPath, subtree[0].task);
          }
        }
      }
      groupIndex += 1;
      continue;
    }
    for (const subtree of subtrees) {
      const rootMeta = subtree[0];
      trellisSplit.tasksByPath.set(rootMeta.task.taskPath, rootMeta.task);
      if (rootMeta.task.taskPath === trellisSplit.selectedTaskPath) selectedTask = rootMeta.task;
      listPane.appendChild(buildTrellisSplitRow(rootMeta.task, rootMeta));
      renderSubtree(subtree, 1, rootMeta.depth, !trellisSplit.collapsedPaths.has(rootMeta.task.taskPath));
    }
    groupIndex += 1;
  }
  listPane.appendChild(createText(
    "div",
    "trellis-split-foot",
    t("dashboardTrellisSplitStat")
      .replace("{active}", String(activeCount))
      .replace("{archive}", String(archiveCount))
  ));
  section.appendChild(listPane);

  // Selection may point at a task that filters just removed — show the
  // empty pane rather than a stale card.
  section.appendChild(buildTrellisSplitDetailPane(selectedTask));
  return section;
}

function buildTrellisBoardSection(activeTasks, archiveTasks) {
  const section = document.createElement("div");
  section.className = "trellis-view-section trellis-board-section";

  const byPhase = bucketByBoardPhase(activeTasks, archiveTasks);

  const board = document.createElement("div");
  board.className = "trellis-board";
  let colIndex = 0;
  for (const col of TRELLIS_BOARD_COLUMNS) {
    const tasks = byPhase.get(col.phase) || [];
    const column = document.createElement("div");
    column.className = "trellis-board-column";
    column.style.setProperty("--board-col-index", String(colIndex));

    const head = document.createElement("div");
    head.className = "trellis-board-column-head";
    head.appendChild(createText("span", "trellis-board-column-title", t(col.labelKey)));
    head.appendChild(createText(
      "span",
      "trellis-board-column-count",
      String(tasks.length)
    ));
    column.appendChild(head);

    const list = document.createElement("div");
    list.className = "trellis-board-column-list";
    if (tasks.length > TRELLIS_BOARD_CARD_LIMIT) {
      list.classList.add("trellis-board-heavy");
    }
    for (const task of tasks) {
      list.appendChild(buildTrellisBoardCard(task));
    }
    column.appendChild(list);
    board.appendChild(column);
    colIndex += 1;
  }
  section.appendChild(board);
  return section;
}

// v5-b FLIP move animation: cards keyed by taskPath. Before a board
// rebuild we snapshot each card's viewport rect; after the swap we diff
// the new rects — any card that moved (phase changed → new column) plays
// a transform tween from its old position. Reduced-motion and test
// sandboxes (no rAF/rect support) degrade to the plain rebuild.
const trellisBoardCardRects = new Map();

function captureTrellisBoardCardPositions(rootEl) {
  trellisBoardCardRects.clear();
  if (!rootEl) return;
  for (const card of rootEl.querySelectorAll(".trellis-board-card[data-task-path]")) {
    const key = card.dataset.taskPath;
    if (!key) continue;
    try {
      trellisBoardCardRects.set(key, card.getBoundingClientRect());
    } catch {
      /* rect unavailable (detached) — skip */
    }
  }
}

function flipTrellisBoardCards(rootEl) {
  if (!rootEl || trellisBoardCardRects.size === 0) return;
  const reduced = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof document.documentElement.animate !== "function") {
    trellisBoardCardRects.clear();
    return;
  }
  for (const card of rootEl.querySelectorAll(".trellis-board-card[data-task-path]")) {
    const prev = trellisBoardCardRects.get(card.dataset.taskPath);
    if (!prev) continue;
    let next;
    try {
      next = card.getBoundingClientRect();
    } catch {
      continue;
    }
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    card.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, zIndex: 5 },
        { transform: "translate(0, 0)", zIndex: 5 },
      ],
      { duration: 260, easing: "cubic-bezier(0.25, 0.8, 0.35, 1)" }
    );
  }
  trellisBoardCardRects.clear();
}

function buildTrellisFilterSection() {
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

  const titleRow = document.createElement("div");
  titleRow.className = "trellis-view-section-title";
  const selected = trellisView.selectedRoot;
  titleRow.appendChild(createText(
    "span",
    "trellis-filter-title",
    selected === null ? t("dashboardTrellisFilterAll") : labels.get(selected) || selected
  ));
  // v5-b: tree / board display-mode toggle (session-cached in localStorage).
  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  modeBtn.className = "trellis-view-mode-toggle";
  modeBtn.title = t("dashboardTrellisModeToggle");
  modeBtn.appendChild(document.createTextNode(
    trellisView.mode === "tree" ? t("dashboardTrellisModeSplit") : t("dashboardTrellisModeTree")
  ));
  modeBtn.addEventListener("click", () => {
    setTrellisViewMode(trellisView.mode === "tree" ? "split" : "tree");
  });
  titleRow.appendChild(modeBtn);
  section.appendChild(titleRow);

  const chips = document.createElement("div");
  chips.className = "trellis-filter-chips";

  const chip = (next, label, count, empty) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "trellis-filter-chip";
    if (empty) el.classList.add("trellis-filter-chip-empty");
    if (next === selected) el.classList.add("is-active");
    el.setAttribute("aria-pressed", next === selected ? "true" : "false");
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
  section.appendChild(chips);
  return section;
}

function buildTrellisActiveSection(tree, tasks) {
  const state = trellisView.active;
  const section = document.createElement("div");
  section.className = "trellis-view-section";

  const titleRow = document.createElement("div");
  titleRow.className = "trellis-view-section-title";
  titleRow.appendChild(createText("span", "trellis-active-title", t("dashboardTrellisActiveTitle")));
  // Expand/collapse all only make sense with rows on screen — the empty,
  // loading and error states skip them.
  if (tasks.length) {
    appendTrellisTreeTools(titleRow, tree.roots.filter((node) => !node.archived));
  }
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "trellis-archive-refresh trellis-active-refresh";
  refresh.textContent = "↻";
  refresh.title = t("dashboardTrellisActiveRefresh");
  refresh.setAttribute("aria-label", t("dashboardTrellisActiveRefresh"));
  refresh.addEventListener("click", () => {
    void refreshTrellisActive();
  });
  titleRow.appendChild(refresh);
  section.appendChild(titleRow);

  if (state.loading) {
    section.appendChild(createText("div", "trellis-view-empty", t("dashboardTrellisDetailLoading")));
  } else if (state.error) {
    section.appendChild(createText("div", "trellis-view-error", t("dashboardTrellisActiveError")));
  } else if (!tasks.length) {
    section.appendChild(createText("div", "trellis-view-empty", t("dashboardTrellisActiveEmpty")));
  } else {
    // Active roots render their whole subtree — archived subtasks that
    // linked back to a still-active parent show grey under it here (and
    // are consequently absent from the archive section below).
    const labels = buildTrellisRootLabels(trellisView.roots);
    for (const node of tree.roots) {
      if (!node.archived) section.appendChild(createTrellisTreeNodeEl(node, labels));
    }
  }
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
    treeExpanded: [...trellisTreeExpanded.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  });
}

function renderTrellisView() {
  if (!trellisViewEl || activeView !== "trellis") return;
  // Drop expansion overrides for tasks neither list carries anymore, so
  // the Map stays bounded by live taskPaths (same pruning policy as the
  // session-panel Set above).
  const liveTreeKeys = new Set();
  for (const task of trellisView.active.tasks) {
    if (task && typeof task.taskPath === "string") liveTreeKeys.add(task.taskPath);
  }
  for (const task of trellisView.archive.tasks) {
    if (task && typeof task.taskPath === "string") liveTreeKeys.add(task.taskPath);
  }
  for (const key of trellisTreeExpanded.keys()) {
    if (!liveTreeKeys.has(key)) trellisTreeExpanded.delete(key);
  }
  const signature = computeTrellisViewSignature();
  if (signature === lastTrellisViewSignature) return;
  lastTrellisViewSignature = signature;

  const fragment = document.createDocumentFragment();
  fragment.appendChild(buildTrellisRootsSection());
  const filterSection = buildTrellisFilterSection();
  if (filterSection) fragment.appendChild(filterSection);
  // The filter is render-layer only: the full lists stay in memory and
  // each rebuild slices them down to the selected root BEFORE the tree is
  // built, so the nesting always reflects the filtered view (a parent
  // filtered out flattens its orphaned children back to roots).
  const selectedRoot = trellisView.selectedRoot;
  const activeFiltered = filterTrellisTasksByRoot(trellisView.active.tasks, trellisView.roots, selectedRoot);
  const archiveFiltered = filterTrellisTasksByRoot(trellisView.archive.tasks, trellisView.roots, selectedRoot);
  const tree = buildTrellisTree(activeFiltered, archiveFiltered);
  if (trellisView.mode === "split") {
    // v6 master-detail split: list groups left, selection detail right.
    fragment.appendChild(buildTrellisSplitSection(activeFiltered, archiveFiltered));
  } else if (trellisView.mode === "board") {
    // v5-b FLIP: capture the current card positions before the rebuild so
    // cards that changed columns can animate the move (see
    // flipTrellisBoardCards below).
    captureTrellisBoardCardPositions(trellisViewEl);
    fragment.appendChild(buildTrellisBoardSection(activeFiltered, archiveFiltered));
  } else {
    fragment.appendChild(buildTrellisActiveSection(tree, activeFiltered));
    fragment.appendChild(buildTrellisArchiveSection(tree, archiveFiltered));
  }
  trellisViewEl.replaceChildren(fragment);
  // v5-b: run the FLIP pass after the swap — cards that moved columns
  // (phase changed between refreshes) tween from their old rects.
  if (trellisView.mode === "board") {
    flipTrellisBoardCards(trellisViewEl);
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

function buildTrellisArchiveSection(tree, tasks) {
  const state = trellisView.archive;
  const section = document.createElement("div");
  section.className = "trellis-view-section";

  const titleRow = document.createElement("div");
  titleRow.className = "trellis-view-section-title";
  const label = tasks.length
    ? `${t("dashboardTrellisArchiveTitle")} (${tasks.length})`
    : t("dashboardTrellisArchiveTitle");
  titleRow.appendChild(createText("span", "trellis-archive-title", label));
  const archiveRoots = tree.roots.filter((node) => node.archived);
  if (tasks.length) {
    appendTrellisTreeTools(titleRow, archiveRoots);
  }
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "trellis-archive-refresh";
  refresh.textContent = "↻";
  refresh.title = t("dashboardTrellisArchivedRefresh");
  refresh.setAttribute("aria-label", t("dashboardTrellisArchivedRefresh"));
  refresh.disabled = state.loading;
  refresh.addEventListener("click", () => {
    void refreshTrellisViewArchive();
  });
  titleRow.appendChild(refresh);
  section.appendChild(titleRow);

  const body = document.createElement("div");
  body.className = "trellis-archive-list";
  if (state.loading) {
    body.appendChild(createText("div", "trellis-archive-empty", t("dashboardTrellisDetailLoading")));
  } else if (state.error) {
    body.appendChild(createText("div", "trellis-archive-empty", t("dashboardTrellisArchivedError")));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "trellis-archive-retry";
    retry.textContent = t("dashboardTrellisArchivedRetry");
    retry.addEventListener("click", () => {
      void refreshTrellisViewArchive();
    });
    body.appendChild(retry);
  } else if (!tasks.length) {
    body.appendChild(createText("div", "trellis-archive-empty", t("dashboardTrellisArchivedEmpty")));
  } else {
    // Month-grouped browser over the archive ROOT nodes: a task nested
    // under a parent (same month or cross-month) rides its parent's
    // subtree wherever that parent lives, so only roots get a month slot
    // and the group count is the number of expandable roots in it.
    // Archived children still linked to an active parent are absent here
    // entirely — they render in the active section under that parent.
    const labels = buildTrellisRootLabels(trellisView.roots);
    const byMonth = new Map();
    for (const node of archiveRoots) {
      const month = trellisArchiveMonthOf(node.task.taskPath);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(node);
    }
    const months = [...byMonth.keys()].sort((a, b) => (a === b ? 0 : a < b ? 1 : -1));
    for (const month of months) {
      const monthKey = month || "";
      const isOpen = state.openMonths !== null && state.openMonths.has(monthKey);
      const monthHeader = document.createElement("button");
      monthHeader.type = "button";
      monthHeader.className = "trellis-archive-month";
      monthHeader.setAttribute("aria-expanded", isOpen ? "true" : "false");
      monthHeader.appendChild(createText(
        "span",
        "trellis-archive-caret",
        isOpen ? "▾" : "▸"
      ));
      monthHeader.appendChild(createText(
        "span",
        "trellis-archive-month-label",
        `${monthKey || t("dashboardTrellisArchivedUnknownMonth")} · ${byMonth.get(monthKey).length}`
      ));
      monthHeader.addEventListener("click", () => {
        if (state.openMonths === null) state.openMonths = new Set();
        if (state.openMonths.has(monthKey)) {
          state.openMonths.delete(monthKey);
        } else {
          state.openMonths.add(monthKey);
        }
        lastTrellisViewSignature = null;
        renderTrellisView();
      });
      body.appendChild(monthHeader);
      if (isOpen) {
        for (const node of byMonth.get(monthKey)) {
          body.appendChild(createTrellisTreeNodeEl(node, labels));
        }
      }
    }
  }
  section.appendChild(body);
  return section;
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
const trellisNetwork = {
  open: false,
  loading: false,
  seq: 0,
  request: null, // { taskPath, title, cwd }
  result: null, // { status, parent, children, childrenTruncated }
};
let lastTrellisNetworkSignature = null;

function openTrellisNetwork(request) {
  if (!request || typeof request.taskPath !== "string" || !request.taskPath) return;
  trellisNetwork.open = true;
  trellisNetwork.loading = true;
  trellisNetwork.seq += 1;
  trellisNetwork.request = {
    taskPath: request.taskPath,
    title: typeof request.title === "string" ? request.title : "",
    cwd: typeof request.cwd === "string" ? request.cwd : "",
  };
  trellisNetwork.result = null;
  lastTrellisNetworkSignature = null;
  renderTrellisNetwork();
  void fetchTrellisNetwork();
}

// v5-a symmetric close: play the CSS fade/scale-out, then swap in the
// cleared render. The finish callback always runs (timer, not
// animationend), reduced-motion skips straight to it, and reopening
// cancels a pending close — a missed/late timer can never strand or
// double-run the overlay. Renderer test sandboxes may run without timer
// globals; a missing setTimeout degrades to the immediate close.
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

function closeTrellisNetwork() {
  if (!trellisNetwork.open) return;
  trellisNetwork.open = false;
  trellisNetwork.loading = false;
  trellisNetwork.request = null;
  trellisNetwork.result = null;
  lastTrellisNetworkSignature = null;
  animateTrellisOverlayClose(trellisNetworkOverlayEl, renderTrellisNetwork);
}

async function fetchTrellisNetwork() {
  const seq = trellisNetwork.seq;
  const request = trellisNetwork.request;
  if (!request || typeof window.dashboardAPI.getTrellisTaskNetwork !== "function") return;
  let result = null;
  try {
    result = await window.dashboardAPI.getTrellisTaskNetwork({
      taskPath: request.taskPath,
      cwd: request.cwd,
    });
  } catch {
    result = null;
  }
  if (!trellisNetwork.open || trellisNetwork.seq !== seq) return;
  trellisNetwork.loading = false;
  trellisNetwork.result = result && typeof result === "object" ? result : { status: "error" };
  lastTrellisNetworkSignature = null;
  renderTrellisNetwork();
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
      const request = trellisNetwork.request;
      closeTrellisNetwork();
      if (!request) return;
      void openTrellisDetail({
        taskPath: ref.taskPath,
        title: ref.title || "",
        cwd: request.cwd,
        sessions: [],
        progress: null,
      });
    });
  } else {
    btn.disabled = true;
    btn.appendChild(document.createTextNode((ref && (ref.title || ref.name)) || "?"));
    const badge = document.createElement("span");
    badge.className = "trellis-network-ref-badge";
    badge.appendChild(document.createTextNode(t("dashboardTrellisLinksMissing")));
    btn.appendChild(badge);
  }
  return btn;
}

function buildTrellisNetworkCard() {
  const card = document.createElement("div");
  card.className = "trellis-detail-card";

  const header = document.createElement("div");
  header.className = "trellis-detail-header";
  header.appendChild(createText(
    "h3",
    "trellis-detail-title",
    (trellisNetwork.request && trellisNetwork.request.title) || t("dashboardTrellisLinksTitle")
  ));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "trellis-detail-close";
  close.textContent = "✕";
  close.title = t("dashboardTrellisDetailClose");
  close.setAttribute("aria-label", t("dashboardTrellisDetailClose"));
  close.addEventListener("click", closeTrellisNetwork);
  header.appendChild(close);
  card.appendChild(header);

  if (trellisNetwork.loading || !trellisNetwork.result) {
    card.appendChild(createText("div", "trellis-detail-hint", "…"));
    return card;
  }
  const result = trellisNetwork.result;
  if (result.status !== "ok") {
    card.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisLinksFailed")));
    return card;
  }

  const hasParent = result.parent && !result.parent.missing;
  const children = Array.isArray(result.children) ? result.children : [];
  const liveChildren = children.filter((c) => c && !c.missing);
  if (!hasParent && liveChildren.length === 0 && children.length === 0) {
    card.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisLinksEmpty")));
    return card;
  }

  if (hasParent) {
    card.appendChild(createText("div", "trellis-spec-group-label", t("dashboardTrellisLinksParent")));
    const wrap = document.createElement("div");
    wrap.className = "trellis-network-group";
    wrap.appendChild(trellisNetworkRefButton(result.parent));
    card.appendChild(wrap);
  }
  if (children.length > 0) {
    card.appendChild(createText("div", "trellis-spec-group-label", t("dashboardTrellisLinksChildren") + ` (${children.length})`));
    const wrap = document.createElement("div");
    wrap.className = "trellis-network-group";
    for (const child of children) {
      wrap.appendChild(trellisNetworkRefButton(child));
    }
    if (result.childrenTruncated) {
      card.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisLinksTruncated")));
    }
    card.appendChild(wrap);
  }
  return card;
}

function renderTrellisNetwork() {
  if (!trellisNetworkOverlayEl) return;
  if (!trellisNetwork.open) {
    trellisNetworkOverlayEl.hidden = true;
    trellisNetworkOverlayEl.replaceChildren();
    return;
  }
  const signature = JSON.stringify([
    trellisNetwork.loading,
    trellisNetwork.request,
    trellisNetwork.result && trellisNetwork.result.status,
    trellisNetwork.result && trellisNetwork.result.parent,
    trellisNetwork.result && trellisNetwork.result.children,
    trellisNetwork.result && trellisNetwork.result.childrenTruncated,
  ]);
  if (signature === lastTrellisNetworkSignature) return;
  lastTrellisNetworkSignature = signature;
  cancelTrellisOverlayClose(trellisNetworkOverlayEl);
  trellisNetworkOverlayEl.replaceChildren(buildTrellisNetworkCard());
  trellisNetworkOverlayEl.hidden = false;
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
  const target = typeof root === "string" && root ? root : trellisView.selectedRoot || trellisView.roots[0];
  if (!target) return;
  if (trellisSpec.open && trellisSpec.root === target) {
    renderTrellisSpec();
    return;
  }
  trellisSpec.open = true;
  trellisSpec.loading = trellisSpec.root !== target;
  trellisSpec.seq += 1;
  trellisSpec.root = target;
  trellisSpec.files = [];
  trellisSpec.truncated = false;
  trellisSpec.selected = null;
  trellisSpecDocs.clear();
  lastTrellisSpecSignature = null;
  renderTrellisSpec();
  void fetchTrellisSpecTree(target);
}

function closeTrellisSpec() {
  if (!trellisSpec.open) return;
  trellisSpec.open = false;
  trellisSpec.loading = false;
  trellisSpec.root = null;
  trellisSpec.files = [];
  trellisSpec.truncated = false;
  trellisSpec.selected = null;
  // Ephemeral by contract: closing drops every cached document content.
  trellisSpecDocs.clear();
  lastTrellisSpecSignature = null;
  animateTrellisOverlayClose(trellisSpecOverlayEl, renderTrellisSpec);
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
  if (!trellisSpec.open || typeof relPath !== "string" || !relPath) return;
  trellisSpec.selected = relPath;
  lastTrellisSpecSignature = null;
  renderTrellisSpec();
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
  lastTrellisSpecSignature = null;
  renderTrellisSpec();
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
  lastTrellisSpecSignature = null;
  renderTrellisSpec();
}

function buildTrellisSpecCard() {
  const card = document.createElement("div");
  card.className = "trellis-detail-card trellis-spec-card";

  // Header: title + (multi-root chips) + close — same shape as the detail card.
  const header = document.createElement("div");
  header.className = "trellis-detail-header";
  header.appendChild(createText("h3", "trellis-detail-title", t("dashboardTrellisSpecTitle")));
  const roots = trellisView.roots;
  if (roots.length > 1) {
    const labels = buildTrellisRootLabels(roots);
    const chips = document.createElement("div");
    chips.className = "trellis-spec-roots";
    for (const root of roots) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "trellis-filter-chip";
      if (root === trellisSpec.root) chip.classList.add("is-active");
      chip.appendChild(document.createTextNode(labels.get(root) || root));
      chip.addEventListener("click", () => switchTrellisSpecRoot(root));
      chips.appendChild(chip);
    }
    header.appendChild(chips);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "trellis-detail-close";
  close.textContent = "✕";
  close.title = t("dashboardTrellisDetailClose");
  close.setAttribute("aria-label", t("dashboardTrellisDetailClose"));
  close.addEventListener("click", closeTrellisSpec);
  header.appendChild(close);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "trellis-spec-body";

  // Left pane: grouped file list.
  const list = document.createElement("div");
  list.className = "trellis-spec-list";
  if (trellisSpec.loading) {
    list.appendChild(createText("div", "trellis-detail-hint", "…"));
  } else if (trellisSpec.files.length === 0) {
    list.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisSpecEmpty")));
  } else {
    let lastGroup = null;
    for (const file of trellisSpec.files) {
      if (file.group !== lastGroup) {
        lastGroup = file.group;
        list.appendChild(createText("div", "trellis-spec-group-label", file.group));
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "trellis-spec-file-button";
      if (file.relPath === trellisSpec.selected) item.setAttribute("aria-current", "true");
      item.appendChild(document.createTextNode(file.relPath));
      item.addEventListener("click", () => selectTrellisSpecDoc(file.relPath));
      list.appendChild(item);
    }
  }
  body.appendChild(list);

  // Right pane: selected document through the whitelisted renderer.
  const docPane = document.createElement("div");
  docPane.className = "trellis-spec-doc";
  if (trellisSpec.selected) {
    const entry = trellisSpecDocs.get(trellisSpecDocKey(trellisSpec.root, trellisSpec.selected));
    if (!entry || entry.loading) {
      docPane.appendChild(createText("div", "trellis-detail-hint", "…"));
    } else if (entry.result && entry.result.status === "ok") {
      const rendered = renderMarkdownDoc(trellisDocBuilder, entry.result.content || "");
      docPane.appendChild(rendered.root);
      if (rendered.truncated) {
        docPane.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisDocTruncated")));
      }
    } else {
      docPane.appendChild(createText("div", "trellis-detail-hint", t("dashboardTrellisSpecLoadFailed")));
    }
  }
  body.appendChild(docPane);
  card.appendChild(body);
  return card;
}

function renderTrellisSpec() {
  if (!trellisSpecOverlayEl) return;
  if (!trellisSpec.open) {
    trellisSpecOverlayEl.hidden = true;
    trellisSpecOverlayEl.replaceChildren();
    return;
  }
  const signature = JSON.stringify([
    trellisSpec.loading,
    trellisSpec.root,
    trellisSpec.files.map((f) => `${f.group}|${f.relPath}`),
    trellisSpec.truncated,
    trellisSpec.selected,
    [...trellisSpecDocs.entries()].map(([k, v]) => [k, v.loading, v.result && v.result.status, v.result && v.result.truncated]),
    trellisView.roots,
  ]);
  if (signature === lastTrellisSpecSignature) return;
  lastTrellisSpecSignature = signature;
  cancelTrellisOverlayClose(trellisSpecOverlayEl);
  trellisSpecOverlayEl.replaceChildren(buildTrellisSpecCard());
  trellisSpecOverlayEl.hidden = false;
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
  if (heading.children[0]) heading.children[0].textContent = collapsed ? "▸" : "▾";
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
  close.textContent = "✕";
  close.title = t("dashboardTrellisDetailClose");
  close.setAttribute("aria-label", t("dashboardTrellisDetailClose"));
  close.addEventListener("click", closeTrellisDetail);
  header.appendChild(close);

  // ⛓ task network: same entry the tree rows had (v7 R2). readTaskNetwork
  // derives parent/children server-side and always renders at least the
  // task's own node, so the button is unconditional; cwd was frozen into
  // the request at open time (archived rows carry their scan cwd, live rows
  // the first bound session cwd) — exactly what the row entry passes on.
  if (request.taskPath) {
    const links = document.createElement("button");
    links.type = "button";
    links.className = "trellis-detail-links";
    links.textContent = "⛓";
    links.title = t("dashboardTrellisLinksOpen");
    links.setAttribute("aria-label", t("dashboardTrellisLinksOpen"));
    links.addEventListener("click", () => {
      openTrellisNetwork({
        taskPath: request.taskPath,
        title: (detail && detail.title) || request.title || "",
        cwd: typeof request.cwd === "string" ? request.cwd : "",
      });
    });
    header.appendChild(links);
  }
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
    const host = document.querySelector(".trellis-split-detail");
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

function createCard(session, now) {
  const card = document.createElement("article");
  card.className = session.canFocus === true ? "card" : "card card-unfocusable";

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
  return `${row.agentId}\u0000${row.sessionId}`;
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
  const key = historyKey(row);
  if (isHistoryResumePending(sessionHistoryActionState.get(key))) return;
  sessionHistoryActionState.set(key, { status: "pending" });
  render({ force: true });
  let result = null;
  try {
    result = await window.dashboardAPI.resumeSession({
      agentId: row.agentId,
      sessionId: row.sessionId,
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
  button.disabled = pending;
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
}

async function init() {
  // Detail overlay dismissal: ESC (when the keyboard mode is not holding the
  // key) and a click on the dimmed backdrop outside the card.
  if (typeof document.addEventListener === "function") {
    document.addEventListener("keydown", (event) => {
      if (!trellisDetail.open && !trellisSpec.open && !trellisNetwork.open) return;
      if (quick.active || quick.pending) return;
      if (event.key === "Escape") {
        if (trellisSpec.open) closeTrellisSpec();
        else if (trellisNetwork.open) closeTrellisNetwork();
        else closeTrellisDetail();
      }
    });
  }
  // v6 split-mode keyboard navigation: ↑/↓ move the selection across the
  // visible rows in group order, Enter opens the full detail overlay, Esc
  // clears the selection (never the window). Only active while the split
  // view is the current tab and no overlay/quick mode holds the key.
  if (typeof document.addEventListener === "function") {
    document.addEventListener("keydown", (event) => {
      if (trellisView.mode !== "split") return;
      if (trellisDetail.open || trellisSpec.open || trellisNetwork.open) return;
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
        const rows = trellisViewEl
          ? trellisViewEl.querySelectorAll(".trellis-split-row[data-task-path]")
          : [];
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
  if (trellisNetworkOverlayEl && typeof trellisNetworkOverlayEl.addEventListener === "function") {
    trellisNetworkOverlayEl.addEventListener("click", (event) => {
      if (event.target === trellisNetworkOverlayEl) closeTrellisNetwork();
    });
  }
  if (trellisSpecOverlayEl && typeof trellisSpecOverlayEl.addEventListener === "function") {
    trellisSpecOverlayEl.addEventListener("click", (event) => {
      if (event.target === trellisSpecOverlayEl) closeTrellisSpec();
    });
  }
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
