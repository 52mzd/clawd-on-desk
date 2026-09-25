"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  PLATFORM_ALIASES,
  SANITIZE_MAX_LEN,
  sanitizeKey,
  hashValue,
  trellisPlatformFor,
  sessionPointerKey,
  derivePhase,
  deriveProgress,
  deriveNextStepHint,
  phaseLabelKey,
} = require("../src/trellis-phase");

// Every sanitize/hash expectation below was produced by running the Python
// original shipped by the Trellis CLI
// (.trellis/scripts/common/active_task.py::_sanitize_key /
// _hash_value) on the same input, so the port is pinned to verified Python
// behavior rather than to whatever the JS port happens to output.
describe("trellis-phase sanitizeKey (python3-verified expectations)", () => {
  it("passes ids made of allowed chars through unchanged", () => {
    assert.strictEqual(sanitizeKey("abc-DEF_123.xyz"), "abc-DEF_123.xyz");
    // Raw session ids as trellis stores them in pointer filenames.
    assert.strictEqual(sanitizeKey("01a0b040-370d-70b0-8e1a-9c8626dfd17e"), "01a0b040-370d-70b0-8e1a-9c8626dfd17e");
  });

  it("returns empty for blank / symbol-only / non-string input", () => {
    assert.strictEqual(sanitizeKey(""), "");
    assert.strictEqual(sanitizeKey("!!!"), "");
    assert.strictEqual(sanitizeKey("   "), "");
    assert.strictEqual(sanitizeKey(null), "");
    assert.strictEqual(sanitizeKey(undefined), "");
    assert.strictEqual(sanitizeKey(12345), "");
  });

  it("trims leading/trailing whitespace before sanitizing", () => {
    // Python strips raw first; even without that pre-strip the whitespace
    // becomes "_" and the "._-" trim removes it — result identical.
    assert.strictEqual(sanitizeKey("  abc  "), "abc");
  });

  it("strips leading/trailing . _ - runs", () => {
    assert.strictEqual(sanitizeKey("._-abc-._"), "abc");
    assert.strictEqual(sanitizeKey("-abc-"), "abc");
    assert.strictEqual(sanitizeKey("...x..."), "x");
  });

  it("collapses runs of disallowed chars into a single underscore", () => {
    assert.strictEqual(sanitizeKey("a!@#b"), "a_b");
    assert.strictEqual(sanitizeKey("a b c"), "a_b_c");
  });

  it("replaces non-ASCII chars (accented, emoji, NBSP)", () => {
    // python3: "séance" → "s_ance"; "😀abc" → "_abc" → trimmed → "abc";
    // "a\xa0b" → "a_b".
    assert.strictEqual(sanitizeKey("séance"), "s_ance");
    assert.strictEqual(sanitizeKey("😀abc"), "abc");
    assert.strictEqual(sanitizeKey("a b"), "a_b");
  });

  it("caps at 160 chars after the trim (truncated tail keeps its underscore)", () => {
    const plain = "a".repeat(SANITIZE_MAX_LEN + 1);
    assert.strictEqual(sanitizeKey(plain), "a".repeat(SANITIZE_MAX_LEN));
    // "a"*159 + "!" + "b" → "a"*159 + "_" (161 chars, capped at 160,
    // no re-trim afterwards — Python truncates after strip too).
    const capped = "a".repeat(159) + "!b";
    assert.strictEqual(sanitizeKey(capped), "a".repeat(159) + "_");
  });
});

describe("trellis-phase hashValue (python3-verified expectations)", () => {
  it("matches the first 24 hex chars of sha256", () => {
    // python3: hashlib.sha256(b"!!!").hexdigest()[:24]
    assert.strictEqual(hashValue("!!!"), "e84c538e7fe250730ef62de2");
    // python3: hashlib.sha256("😀".encode("utf-8")).hexdigest()[:24]
    assert.strictEqual(hashValue("😀"), "f0443a342c5ef54783a111b5");
    assert.strictEqual(hashValue("x").length, 24);
  });
});

describe("trellis-phase PLATFORM_ALIASES / trellisPlatformFor", () => {
  it("maps every verified Clawd agentId onto its pointer-file prefix", () => {
    assert.strictEqual(trellisPlatformFor("claude-code"), "claude");
    assert.strictEqual(trellisPlatformFor("codex"), "codex");
    assert.strictEqual(trellisPlatformFor("copilot-cli"), "copilot");
    assert.strictEqual(trellisPlatformFor("gemini-cli"), "gemini");
    assert.strictEqual(trellisPlatformFor("cursor-agent"), "cursor");
    assert.strictEqual(trellisPlatformFor("opencode"), "opencode");
    assert.strictEqual(trellisPlatformFor("qoder"), "qoder");
    assert.strictEqual(trellisPlatformFor("codebuddy"), "codebuddy");
    assert.strictEqual(trellisPlatformFor("kiro-cli"), "kiro");
    assert.strictEqual(trellisPlatformFor("kimi-cli"), "kimi");
    assert.strictEqual(trellisPlatformFor("pi"), "pi");
    // zcode goes through _CONTEXT_KEY_PLATFORM_ALIASES {"zcode": "claude"}:
    // its pointer files are named claude_<id>.json.
    assert.strictEqual(trellisPlatformFor("zcode"), "claude");
  });

  it("returns null for agents with no verified trellis platform", () => {
    for (const agentId of [
      "antigravity-cli",
      "qwen-code",
      "codewhale",
      "mimocode",
      "openclaw",
      "hermes",
      "reasonix",
      "qoderwork",
      "qwenwork",
      "workbuddy",
      "traecode",
      "grok-build",
      "deepseek-harness",
    ]) {
      assert.strictEqual(trellisPlatformFor(agentId), null, agentId);
    }
    assert.strictEqual(trellisPlatformFor("unknown-agent"), null);
    assert.strictEqual(trellisPlatformFor(""), null);
    assert.strictEqual(trellisPlatformFor(null), null);
  });

  it("keeps the alias table in sync with the exported constant", () => {
    assert.strictEqual(Object.keys(PLATFORM_ALIASES).length, 12);
  });
});

describe("trellis-phase sessionPointerKey (real pointer filename fixtures)", () => {
  it("matches the live pi pointer in this repo (真机三元组)", () => {
    // Clawd sessionId shape: hooks/pi-extension-core.js L109 sends
    // `${PI_AGENT_ID}:${id}`. Actual file on disk:
    // .trellis/.runtime/sessions/pi_01a0b040-370d-70b0-8e1a-9c8626dfd17e.json
    // (TRELLIS_CONTEXT_ID in the session that created it carried the same
    // key).
    assert.strictEqual(
      sessionPointerKey("pi", "pi:01a0b040-370d-70b0-8e1a-9c8626dfd17e"),
      "pi_01a0b040-370d-70b0-8e1a-9c8626dfd17e"
    );
  });

  it("matches the live claude pointer in the jianlairpg project (真机三元组)", () => {
    // hooks/clawd-hook.js L564 reports Claude session ids verbatim (no
    // namespace prefix). Actual file on disk:
    // ~/Downloads/jianlairpg/.trellis/.runtime/sessions/
    // claude_6218983c-1109-4a8d-8fde-a9b121655801.json
    assert.strictEqual(
      sessionPointerKey("claude-code", "6218983c-1109-4a8d-8fde-a9b121655801"),
      "claude_6218983c-1109-4a8d-8fde-a9b121655801"
    );
  });

  it("derives the codex pointer key from the namespaced thread uuid (推导用例)", () => {
    // agents/codex-log-monitor.js L836/L1208 and hooks/codex-hook.js L438
    // report "codex:<thread uuid>"; no live pointer file was available, so
    // this fixture follows _context_key("codex", "session", uuid).
    assert.strictEqual(
      sessionPointerKey("codex", "codex:3f2504e0-4f89-41d3-9a0c-0305e82c3301"),
      "codex_3f2504e0-4f89-41d3-9a0c-0305e82c3301"
    );
  });

  it("maps zcode onto the claude pointer prefix (context-key alias)", () => {
    assert.strictEqual(sessionPointerKey("zcode", "zcode:abc-123"), "claude_abc-123");
  });

  it("strips only its own agentId namespace prefix", () => {
    // pi:default is pi-extension-core's fallback id shape.
    assert.strictEqual(sessionPointerKey("pi", "pi:default"), "pi_default");
    assert.strictEqual(sessionPointerKey("codex", "codex:default"), "codex_default");
    // A colon that is NOT the agent's own namespace stays in the raw id
    // and is sanitized — Python sanitizes the raw id the same way.
    assert.strictEqual(sessionPointerKey("claude-code", "we:ird"), "claude_we_ird");
  });

  it("falls back to the sha256 prefix when the id sanitizes to empty", () => {
    // python3: hashlib.sha256(b"!!!").hexdigest()[:24] — mirrors
    // _context_key's hash branch for symbol-only ids.
    assert.strictEqual(sessionPointerKey("codex", "codex:!!!"), "codex_e84c538e7fe250730ef62de2");
  });

  it("returns null for unmapped agents and blank ids", () => {
    assert.strictEqual(sessionPointerKey("qwen-code", "anything"), null);
    assert.strictEqual(sessionPointerKey("pi", ""), null);
    assert.strictEqual(sessionPointerKey("pi", "   "), null);
    assert.strictEqual(sessionPointerKey("pi", null), null);
    assert.strictEqual(sessionPointerKey(null, "x"), null);
  });
});

describe("trellis-phase derivePhase (design D2 table)", () => {
  it("archived wins over every status", () => {
    assert.strictEqual(derivePhase({ status: "completed", hasPrd: true, isArchived: true }), "done");
    assert.strictEqual(derivePhase({ status: "in_progress", isArchived: true }), "done");
  });

  it("completed → finish", () => {
    assert.strictEqual(derivePhase({ status: "completed", hasPrd: true, isArchived: false }), "finish");
  });

  it("in_progress → execute", () => {
    assert.strictEqual(derivePhase({ status: "in_progress", hasPrd: true }), "execute");
  });

  it("planning → plan with or without prd.md (D2 keeps both rows on plan)", () => {
    assert.strictEqual(derivePhase({ status: "planning", hasPrd: false }), "plan");
    assert.strictEqual(derivePhase({ status: "planning", hasPrd: true }), "plan");
  });

  it("unknown or missing status → null (badge hidden)", () => {
    assert.strictEqual(derivePhase({ status: "blocked", hasPrd: true }), null);
    assert.strictEqual(derivePhase({}), null);
    assert.strictEqual(derivePhase(), null);
  });

  it("refines in_progress → check when the implement.md checklist is fully ticked", () => {
    const complete = { done: 3, total: 3 };
    assert.strictEqual(derivePhase({ status: "in_progress", implementChecklist: complete }), "check");
    // Partially ticked, empty or missing checklists keep the legacy execute.
    assert.strictEqual(derivePhase({ status: "in_progress", implementChecklist: { done: 1, total: 3 } }), "execute");
    assert.strictEqual(derivePhase({ status: "in_progress", implementChecklist: { done: 0, total: 0 } }), "execute");
    assert.strictEqual(derivePhase({ status: "in_progress", implementChecklist: null }), "execute");
    // The refinement never leaks into other statuses.
    assert.strictEqual(derivePhase({ status: "planning", implementChecklist: complete }), "plan");
    assert.strictEqual(derivePhase({ status: "completed", implementChecklist: complete }), "finish");
    assert.strictEqual(derivePhase({ status: "in_progress", isArchived: true, implementChecklist: complete }), "done");
  });
});

describe("trellis-phase deriveProgress (subtask counting, never 0/0)", () => {
  it("returns null for missing / empty subtasks", () => {
    assert.strictEqual(deriveProgress(null), null);
    assert.strictEqual(deriveProgress("not-an-object"), null);
    assert.strictEqual(deriveProgress({}), null);
    assert.strictEqual(deriveProgress({ subtasks: [] }), null);
    // Real shape of this very task's task.json (subtasks: []).
    assert.strictEqual(deriveProgress({ status: "in_progress", subtasks: [] }), null);
  });

  it("counts completed subtasks", () => {
    const mixed = {
      subtasks: [
        { name: "a", status: "completed" },
        { name: "b", status: "in_progress" },
        { name: "c", status: "completed" },
        { name: "d", status: "pending" },
      ],
    };
    assert.deepStrictEqual(deriveProgress(mixed), { done: 2, total: 4 });
  });

  it("handles all-complete and none-complete", () => {
    assert.deepStrictEqual(
      deriveProgress({ subtasks: [{ status: "completed" }, { status: "completed" }] }),
      { done: 2, total: 2 }
    );
    // 0 done of a non-empty list is a real value (never 0/0).
    assert.deepStrictEqual(
      deriveProgress({ subtasks: [{ status: "pending" }] }),
      { done: 0, total: 1 }
    );
  });

  it("tolerates malformed subtask entries", () => {
    assert.deepStrictEqual(
      deriveProgress({ subtasks: [null, "x", { status: "completed" }] }),
      { done: 1, total: 3 }
    );
  });

  it("prefers the implement.md checklist over task.json subtasks", () => {
    const taskJson = { subtasks: [{ status: "completed" }] };
    assert.deepStrictEqual(
      deriveProgress(taskJson, { done: 4, total: 7 }),
      { done: 4, total: 7 }
    );
    // Empty/missing checklist falls back to the legacy subtask path.
    assert.deepStrictEqual(
      deriveProgress(taskJson, { done: 0, total: 0 }),
      { done: 1, total: 1 }
    );
    assert.deepStrictEqual(deriveProgress(taskJson, null), { done: 1, total: 1 });
    // Checklist present but no subtasks still yields real numbers.
    assert.deepStrictEqual(deriveProgress({ subtasks: [] }, { done: 2, total: 5 }), { done: 2, total: 5 });
  });
});

describe("deriveNextStepHint", () => {
  it("maps plan → trellisHintPlan without params", () => {
    assert.deepStrictEqual(deriveNextStepHint({ phase: "plan" }), { key: "trellisHintPlan" });
  });

  it("maps execute → trellisHintExecute with sanitized progress params", () => {
    assert.deepStrictEqual(
      deriveNextStepHint({ phase: "execute", progress: { done: 2, total: 5 } }),
      { key: "trellisHintExecute", params: { done: 2, total: 5 } }
    );
    // Missing/invalid progress degrades to 0/0, never NaN into i18n strings.
    assert.deepStrictEqual(
      deriveNextStepHint({ phase: "execute", progress: null }),
      { key: "trellisHintExecute", params: { done: 0, total: 0 } }
    );
    // Fractional counts truncate; negatives clamp to 0.
    assert.deepStrictEqual(
      deriveNextStepHint({ phase: "execute", progress: { done: 1.7, total: 3 } }),
      { key: "trellisHintExecute", params: { done: 1, total: 3 } }
    );
    assert.deepStrictEqual(
      deriveNextStepHint({ phase: "execute", progress: { done: -2, total: -4 } }),
      { key: "trellisHintExecute", params: { done: 0, total: 0 } }
    );
  });

  it("maps finish → trellisHintFinish", () => {
    assert.deepStrictEqual(deriveNextStepHint({ phase: "finish" }), { key: "trellisHintFinish" });
  });

  it("maps execute + nextStep → trellisHintExecuteNext with all three params", () => {
    assert.deepStrictEqual(
      deriveNextStepHint({ phase: "execute", progress: { done: 2, total: 5 }, nextStep: "wire the bubble" }),
      { key: "trellisHintExecuteNext", params: { done: 2, total: 5, nextStep: "wire the bubble" } }
    );
    // An empty/blank nextStep is no next step — legacy wording stays.
    assert.deepStrictEqual(
      deriveNextStepHint({ phase: "execute", progress: { done: 1, total: 2 }, nextStep: "" }),
      { key: "trellisHintExecute", params: { done: 1, total: 2 } }
    );
    // nextStep without progress still degrades to 0/0 alongside it.
    assert.deepStrictEqual(
      deriveNextStepHint({ phase: "execute", nextStep: "step" }),
      { key: "trellisHintExecuteNext", params: { done: 0, total: 0, nextStep: "step" } }
    );
    // Non-string nextStep is ignored.
    assert.deepStrictEqual(
      deriveNextStepHint({ phase: "execute", progress: { done: 1, total: 1 }, nextStep: 7 }),
      { key: "trellisHintExecute", params: { done: 1, total: 1 } }
    );
  });

  it("maps check → trellisHintCheck without params", () => {
    assert.deepStrictEqual(deriveNextStepHint({ phase: "check" }), { key: "trellisHintCheck" });
  });

  it("returns null for done / unknown phase / null input (no nagging)", () => {
    assert.strictEqual(deriveNextStepHint({ phase: "done" }), null);
    assert.strictEqual(deriveNextStepHint({ phase: null }), null);
    assert.strictEqual(deriveNextStepHint(null), null);
    assert.strictEqual(deriveNextStepHint("execute"), null);
  });
});

describe("phaseLabelKey (phase-transition bubble labels)", () => {
  it("maps every known phase onto the HUD badge key", () => {
    assert.strictEqual(phaseLabelKey("plan"), "sessionHudTrellisPhasePlan");
    assert.strictEqual(phaseLabelKey("execute"), "sessionHudTrellisPhaseExecute");
    assert.strictEqual(phaseLabelKey("check"), "sessionHudTrellisPhaseCheck");
    assert.strictEqual(phaseLabelKey("finish"), "sessionHudTrellisPhaseFinish");
    assert.strictEqual(phaseLabelKey("done"), "sessionHudTrellisPhaseDone");
  });

  it("answers null for unknown phases (caller falls back to the raw phase)", () => {
    assert.strictEqual(phaseLabelKey("nope"), null);
    assert.strictEqual(phaseLabelKey(""), null);
    assert.strictEqual(phaseLabelKey(null), null);
    assert.strictEqual(phaseLabelKey(42), null);
  });
});
