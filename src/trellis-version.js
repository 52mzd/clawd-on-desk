"use strict";

// Trellis version-string helpers.
//
// Pure functions, zero dependencies, zero I/O. The Settings → Trellis tab uses
// these to decide whether a project is behind the channel it tracks.
//
// The one rule that matters: `upgradable` is decided by an ordering compare,
// never by `current !== target`. A project whose `.trellis/.version` is ahead
// of the published channel (pruned release, manual edit, local rollback) would
// otherwise be reported as "可升级" and a batch upgrade would silently downgrade
// it.

// Version strings look like "0.7.0-beta.3" / "0.6.17" / "v0.6.0-rc.0".
const NUMERIC_RE = /^\d+$/;
const PRERELEASE_ID_RE = /^[0-9A-Za-z-]+$/;

function parseVersion(input) {
  if (typeof input !== "string") return null;
  const text = input.trim().replace(/^v/i, "");
  if (!text) return null;
  const dashIndex = text.indexOf("-");
  const baseText = dashIndex === -1 ? text : text.slice(0, dashIndex);
  const preText = dashIndex === -1 ? "" : text.slice(dashIndex + 1);
  // A dangling "0.7.0-" has no prerelease identifiers; treat it as unparsable
  // rather than silently reading it as the plain release.
  if (dashIndex !== -1 && !preText) return null;
  const baseParts = baseText.split(".");
  if (baseParts.length === 0) return null;
  const base = [];
  for (const part of baseParts) {
    if (!NUMERIC_RE.test(part)) return null;
    base.push(Number(part));
  }
  const pre = preText ? preText.split(".") : [];
  for (const identifier of pre) {
    if (!PRERELEASE_ID_RE.test(identifier)) return null;
  }
  return { base, pre };
}

// -1 | 0 | 1 when both sides parse; null when either side is unparsable.
// Callers must treat null as "unknown", never as "equal".
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  const baseLength = Math.max(left.base.length, right.base.length);
  for (let i = 0; i < baseLength; i += 1) {
    const l = left.base[i] || 0;
    const r = right.base[i] || 0;
    if (l !== r) return l < r ? -1 : 1;
  }

  // Equal base: a release outranks any prerelease of the same base.
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;

  const preLength = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < preLength; i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumeric = NUMERIC_RE.test(l);
    const rNumeric = NUMERIC_RE.test(r);
    if (lNumeric && rNumeric) {
      const ln = Number(l);
      const rn = Number(r);
      if (ln !== rn) return ln < rn ? -1 : 1;
    } else if (lNumeric !== rNumeric) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return lNumeric ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

// Which dist-tag a project's installed version tracks. The prerelease
// identifier is checked first so a hypothetical "-betamax" tag is not mistaken
// for a beta channel; the substring fallback keeps hand-edited oddities working.
function inferChannel(version) {
  const text = typeof version === "string" ? version.trim() : "";
  if (!text) return "latest";
  const parsed = parseVersion(text);
  const first = parsed && parsed.pre.length > 0 ? parsed.pre[0].toLowerCase() : "";
  if (first === "beta") return "beta";
  if (first === "rc") return "rc";
  if (/-beta(?:\.|$)/.test(text)) return "beta";
  if (/-rc(?:\.|$)/.test(text)) return "rc";
  return "latest";
}

function resolveTarget(channels, channel) {
  if (!channels || typeof channels !== "object") return null;
  const value = channels[channel];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

// evaluate({ current, channels, channel }) -> { target, upgradable }
//
//   channels === null            -> { target: null, upgradable: null }  (unknown)
//   current === null/unparsable  -> { target, upgradable: null }        (unknown)
//   target >  current            -> upgradable true
//   target <= current            -> upgradable false
//
// `upgradable: null` and `false` are different states and the renderer must
// keep them apart: null renders as "未知", false renders as "已最新".
function evaluate({ current, channels, channel } = {}) {
  const target = resolveTarget(channels, channel);
  if (target === null) return { target: null, upgradable: null };
  if (typeof current !== "string" || !current.trim()) return { target, upgradable: null };
  const comparison = compareVersions(target, current);
  if (comparison === null) return { target, upgradable: null };
  return { target, upgradable: comparison > 0 };
}

module.exports = {
  parseVersion,
  compareVersions,
  inferChannel,
  resolveTarget,
  evaluate,
};
