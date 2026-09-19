"use strict";

// Trellis phase-transition celebration (phase 4, design D5).
//
// Pure decision layer between trellis-activity's onCelebration callback and
// main's one-shot reaction entry (requestClickReaction — the same channel a
// 4-click combo takes through hit-renderer). This module owns only *whether*
// and *what*; the host injects the gates and the play entry:
//
//   - gates: DND, pet hidden, mini mode — the click combo applies the same
//     trio before its reactions (hit-renderer canPlayReactionNow / handleClick),
//     and a pet the user cannot currently see must not animate either.
//   - asset: theme.reactions.double — the celebrate clips (Clawd ships
//     clawd-react-double.svg / clawd-react-double-jump.svg). Themes without
//     one (Calico, Cloudling) celebrate nothing, which is the designed
//     silent degradation for optional assets.
//
// The final asset-existence check is deliberately NOT duplicated here:
// requestClickReaction itself rejects files missing from the active theme
// (collectRequiredAssetFiles), so returning null there is the missing-asset
// skip. No REQUIRED_STATES entry, no new theme capability is involved.

function pickCelebrationReaction(theme) {
  const double = theme && theme.reactions && theme.reactions.double;
  if (!double || typeof double !== "object") return null;
  const pool = Array.isArray(double.files)
    ? double.files.filter((file) => typeof file === "string" && file)
    : [];
  if (pool.length === 0 && typeof double.file === "string" && double.file) {
    pool.push(double.file);
  }
  if (pool.length === 0) return null;
  const duration = Number.isFinite(double.duration) ? Math.max(0, double.duration) : 3500;
  return { file: pool[Math.floor(Math.random() * pool.length)], duration };
}

// Returns a celebrate() function meant to be handed to trellis-activity as
// onCelebration (the task-path argument is accepted and ignored). It never
// throws — a failed celebration must not break the polling round — and
// answers whether a reaction was actually dispatched.
function createTrellisCelebration(deps) {
  const d = deps || {};
  const getDnd = typeof d.getDnd === "function" ? d.getDnd : () => false;
  const getPetHidden = typeof d.getPetHidden === "function" ? d.getPetHidden : () => false;
  const getMiniMode = typeof d.getMiniMode === "function" ? d.getMiniMode : () => false;
  const getTheme = typeof d.getTheme === "function" ? d.getTheme : () => null;
  const playReaction = typeof d.playReaction === "function" ? d.playReaction : () => null;
  return function celebrate() {
    try {
      if (getDnd() || getPetHidden() || getMiniMode()) return false;
      const plan = pickCelebrationReaction(getTheme());
      if (!plan) return false;
      // playReaction is requestClickReaction: null means the active theme
      // does not ship the file — the silent skip, not an error.
      return !!playReaction(plan.file, plan.duration);
    } catch {
      return false;
    }
  };
}

module.exports = { createTrellisCelebration, pickCelebrationReaction };
