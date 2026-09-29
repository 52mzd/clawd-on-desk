"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  encodeClaudeProjectDir,
  getClaudeProjectsDir,
  probeTranscript,
  loadResumableSessionHistory,
  resolveResumeTarget,
} = require("../src/session-history-loader");
const {
  LEGACY_HISTORY_VERSION,
  HISTORY_FILE_PREFIX,
  getHistoryFilePath,
  recordSessionHistoryFromStateBody,
} = require("../hooks/session-history");

describe("session history loader", () => {
  let root;
  let historyDir;
  let claudeProjectsDir;
  let projectCwd;
  const T0 = 1_700_000_000_000;
  const BOOT_A = T0 - 3_600_000;
  const BOOT_B = T0 + 600_000;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-history-loader-"));
    historyDir = path.join(root, "history");
    claudeProjectsDir = path.join(root, "claude-projects");
    projectCwd = path.join(root, "project");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
    fs.mkdirSync(projectCwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function record(sessionId, eventAt, boot = BOOT_A, overrides = {}, historyOptions = {}) {
    return recordSessionHistoryFromStateBody({
      agent_id: "claude-code",
      session_id: sessionId,
      event: "UserPromptSubmit",
      state: "working",
      agent_pid: process.pid,
      source_pid: process.pid,
      cwd: projectCwd,
      session_title: `Session ${sessionId}`,
      ...overrides,
    }, { historyDir, eventAt, uptime: () => (eventAt - boot) / 1000, ...historyOptions });
  }

  function writeTranscript(sessionId, cwd = projectCwd) {
    const dir = path.join(claudeProjectsDir, encodeClaudeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
  }

  function loadOpts(extra = {}) {
    return {
      historyDir,
      claudeProjectsDir,
      now: BOOT_B + 60_000,
      uptime: () => 60,
      ...extra,
    };
  }

  describe("project directory encoding", () => {
    it("maps every character outside [A-Za-z0-9-] to a dash", () => {
      assert.equal(
        encodeClaudeProjectDir("/Users/me/Workspace/Work"),
        "-Users-me-Workspace-Work",
      );
      // Two CJK characters collapse to two dashes, matching Claude Code.
      assert.equal(
        encodeClaudeProjectDir("/Users/me/Workspace/在场"),
        "-Users-me-Workspace---",
      );
      assert.equal(encodeClaudeProjectDir("/a.b/c_d"), "-a-b-c-d");
      assert.equal(encodeClaudeProjectDir(""), null);
    });
  });

  describe("transcript probing", () => {
    it("honours the configured Claude home without probing the default account", () => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      try {
        process.env.CLAUDE_CONFIG_DIR = path.join(root, "custom-claude");
        assert.equal(
          getClaudeProjectsDir({ kind: "default", configDir: null }),
          path.join(os.homedir(), ".claude", "projects"),
        );
        assert.equal(
          getClaudeProjectsDir({ kind: "default", configDir: null }, loadOpts()),
          claudeProjectsDir,
        );
        assert.equal(
          getClaudeProjectsDir({ kind: "custom", configDir: path.join(root, "recorded-claude") }),
          path.join(root, "recorded-claude", "projects"),
        );
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });

    it("rejects path-bearing IDs before any transcript filesystem access", (t) => {
      const reads = t.mock.method(fs, "lstatSync", () => { throw new Error("must not read"); });
      for (const id of ["../secret", "x/y", "x\\y", "", "   ", "a\n"]) {
        assert.equal(probeTranscript(
          "claude-code", id, projectCwd, { kind: "default", configDir: null }, loadOpts(),
        ), null);
      }
      assert.equal(reads.mock.callCount(), 0);
    });

    it("treats access and I/O errors as unknown, not missing", (t) => {
      writeTranscript("has-transcript");
      const lstat = fs.lstatSync;
      t.mock.method(fs, "lstatSync", (file, ...args) => {
        if (String(file).endsWith("has-transcript.jsonl")) {
          throw Object.assign(new Error("unreadable"), { code: "EACCES" });
        }
        return lstat(file, ...args);
      });
      assert.equal(probeTranscript(
        "claude-code", "has-transcript", projectCwd, { kind: "default", configDir: null }, loadOpts(),
      ), null);
    });

    it("reports present, confidently missing, and unknown distinctly", () => {
      writeTranscript("has-transcript");

      assert.equal(
        probeTranscript("claude-code", "has-transcript", projectCwd,
          { kind: "default", configDir: null }, loadOpts()),
        true,
      );
      // Project dir exists, this transcript does not -> a confident no.
      assert.equal(
        probeTranscript("claude-code", "no-transcript", projectCwd,
          { kind: "default", configDir: null }, loadOpts()),
        false,
      );
      // No project dir at all, and no sibling holds the id -> unknown.
      assert.equal(
        probeTranscript("claude-code", "anything", path.join(root, "elsewhere"),
          { kind: "default", configDir: null }, loadOpts()),
        null,
      );
      // Another agent's layout is not ours to interpret.
      assert.equal(probeTranscript(
        "codex", "x", projectCwd, { kind: "default", configDir: null }, loadOpts(),
      ), null);
    });

    it("locates a transcript under a sibling project directory when the recorded cwd maps to none", () => {
      writeTranscript("has-transcript", path.join(root, "worktree"));
      // `claude --resume <id>` looks the id up across project directories, so
      // a worktree record must read as present even though its recorded cwd
      // has no directory of its own.
      assert.equal(
        probeTranscript("claude-code", "has-transcript", path.join(root, "old-checkout"),
          { kind: "default", configDir: null }, loadOpts()),
        true,
      );
      // Nothing anywhere holds this id — still "unknown", never "gone".
      assert.equal(
        probeTranscript("claude-code", "not-anywhere", path.join(root, "old-checkout"),
          { kind: "default", configDir: null }, loadOpts()),
        null,
      );
    });
  });

  describe("resume list", () => {
    it("probes each row against its recorded profile without exposing the profile path", () => {
      const customConfigDir = path.join(root, "custom-claude");
      const defaultRecord = record("shared-id", T0, BOOT_A, {}, { env: {} });
      const customRecord = record("shared-id", T0 + 1, BOOT_A, {}, {
        env: { CLAUDE_CONFIG_DIR: customConfigDir },
      });
      writeTranscript("shared-id");
      fs.mkdirSync(path.join(customConfigDir, "projects", encodeClaudeProjectDir(projectCwd)), {
        recursive: true,
      });

      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = path.join(root, "wrong-main-profile");
      try {
        const rows = loadResumableSessionHistory(loadOpts());
        assert.equal(rows.length, 2);
        const defaultRow = rows.find((row) => row.historyKey === defaultRecord.record.historyKey);
        const customRow = rows.find((row) => row.historyKey === customRecord.record.historyKey);
        assert.equal(defaultRow.transcriptPresent, true);
        assert.equal(customRow.transcriptPresent, false);
        assert.equal(defaultRow.group, "confirmed");
        assert.equal(customRow.group, "other");
        assert.notEqual(defaultRow.historyKey, customRow.historyKey);
        assert.equal(Object.prototype.hasOwnProperty.call(defaultRow, "profile"), false);
        assert.equal(JSON.stringify(rows).includes(customConfigDir), false);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });

    it("keeps legacy rows visible but disables resume when profile provenance is absent", () => {
      const legacy = {
        version: LEGACY_HISTORY_VERSION,
        agentId: "claude-code",
        sessionId: "legacy-session",
        cwd: projectCwd,
        title: "Legacy",
        lastState: "working",
        firstSeenAt: T0,
        lastEventAt: T0,
        endedAt: null,
        bootApproxAt: BOOT_A,
      };
      // Reproduce the v1 filename directly. Calling the current path helper
      // alone would let a migration bug change both production and fixture.
      const legacyHash = crypto.createHash("sha256")
        .update(`claude-code\0${legacy.sessionId}`)
        .digest("hex")
        .slice(0, 32);
      const legacyPath = path.join(historyDir, `${HISTORY_FILE_PREFIX}${legacyHash}.json`);
      assert.equal(getHistoryFilePath("claude-code", legacy.sessionId, {
        historyDir,
        version: LEGACY_HISTORY_VERSION,
      }), legacyPath);
      fs.writeFileSync(legacyPath, JSON.stringify(legacy));

      const [row] = loadResumableSessionHistory(loadOpts());
      assert.equal(row.sessionId, "legacy-session");
      assert.equal(row.resumeDisabledReason, "profile-unverified");
      assert.equal(row.transcriptPresent, null);
      assert.equal(row.group, "other");
      assert.match(row.historyKey, /^[a-f0-9]{32}$/);
      assert.equal(resolveResumeTarget("claude-code", row.historyKey, loadOpts()), null);
    });

    it("puts resumable rows ahead and keeps a flagged missing transcript behind them", () => {
      record("interrupted-one", T0);
      record("ended-one", T0 + 1000, BOOT_A, { event: "SessionEnd", state: "idle" });
      writeTranscript("ended-one");

      const rows = loadResumableSessionHistory(loadOpts());
      assert.deepEqual(rows.map((r) => r.sessionId), ["ended-one", "interrupted-one"]);
      assert.equal(rows[0].interrupted, false);
      assert.equal(rows[0].transcriptPresent, true);
      assert.equal(rows[0].group, "confirmed");
      assert.equal(rows[1].interrupted, true);
      assert.equal(rows[1].transcriptPresent, false, "no transcript was written for it");
      assert.equal(rows[1].group, "other");
      assert.equal(rows[1].cwd, projectCwd);
    });

    it("still offers a row whose transcript state is unknown", () => {
      // No project directory at all, so the probe cannot tell.
      record("unknowable", T0);
      const rows = loadResumableSessionHistory(loadOpts());
      assert.equal(rows.length, 1);
      assert.equal(rows[0].transcriptPresent, null);
      assert.equal(rows[0].group, "other");
    });

    it("hides sessions that are already live on screen", () => {
      record("running-now", T0);
      record("finished", T0 + 1000, BOOT_A, { event: "SessionEnd", state: "idle" });

      const rows = loadResumableSessionHistory(loadOpts({
        activeRawSessionIds: new Set(["running-now"]),
      }));
      assert.deepEqual(rows.map((r) => r.sessionId), ["finished"]);
      assert.equal(rows[0].group, "other");
    });

    it("honours the row limit after the active filter", () => {
      for (let i = 0; i < 5; i++) {
        record(`s-${i}`, T0 + i * 1000);
        writeTranscript(`s-${i}`);
      }
      const rows = loadResumableSessionHistory(loadOpts({
        limit: 2,
        activeRawSessionIds: new Set(["s-4"]),
      }));
      assert.equal(rows.length, 2);
      assert.ok(!rows.some((r) => r.sessionId === "s-4"));
      assert.ok(rows.every((r) => r.group === "confirmed"), "the limit caps the visible list only");
    });

    it("keeps a resumable row visible when unresumable records rank newer", () => {
      // Thirty recency-ranked records without transcripts would fill the
      // whole visible list under a first-N read; grouping must keep the one
      // older resumable session on it instead.
      for (let i = 0; i < 30; i++) record(`ghost-${i}`, T0 - 1000 + i);
      record("real", T0 - 100_000);
      writeTranscript("real");

      const rows = loadResumableSessionHistory(loadOpts());
      assert.equal(rows[0].sessionId, "real");
      assert.equal(rows[0].group, "confirmed");
      assert.equal(rows.filter((r) => r.group === "other").length, 30);
      assert.ok(rows.filter((r) => r.group === "confirmed").length <= 25);
    });

    it("finds a transcript under another project directory when the recorded cwd has none", () => {
      record("moved", T0, BOOT_A, { cwd: path.join(root, "old-checkout") });
      writeTranscript("moved", path.join(root, "worktree"));

      const rows = loadResumableSessionHistory(loadOpts());
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sessionId, "moved");
      assert.equal(rows[0].transcriptPresent, true);
      assert.equal(rows[0].group, "confirmed");
    });

    it("keeps an unknown verdict for a record no directory holds at all", () => {
      // A daemon-born record whose cwd never mapped to a project directory:
      // the cross-directory scan runs and misses, so the row folds away as
      // "other" without the probe ever claiming the transcript is gone.
      record("daemon-born", T0, BOOT_A, { cwd: "/" });
      writeTranscript("unrelated", path.join(root, "some-project"));

      const rows = loadResumableSessionHistory(loadOpts());
      assert.equal(rows.length, 1);
      assert.equal(rows[0].transcriptPresent, null);
      assert.equal(rows[0].group, "other");
    });

    it("never returns prompts or responses", () => {
      record("s", T0, BOOT_A, { assistant_last_output: "secret", prompt: "secret" });
      const [row] = loadResumableSessionHistory(loadOpts());
      assert.ok(!JSON.stringify(row).includes("secret"));
    });
  });

  describe("resume target resolution", () => {
    it("reads the working directory from the store, not from the caller", () => {
      const recorded = record("target", T0);
      const resolved = resolveResumeTarget("claude-code", recorded.record.historyKey, loadOpts());
      assert.deepEqual(resolved, {
        agentId: "claude-code",
        sessionId: "target",
        historyKey: recorded.record.historyKey,
        cwd: projectCwd,
        profile: { kind: "default", configDir: null },
      });
    });

    it("refuses unknown rows and vanished folders", () => {
      const recorded = record("target", T0);
      assert.equal(resolveResumeTarget("claude-code", "0".repeat(32), loadOpts()), null);
      assert.equal(resolveResumeTarget("codex", recorded.record.historyKey, loadOpts()), null);
      assert.equal(resolveResumeTarget(null, recorded.record.historyKey, loadOpts()), null);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      assert.equal(
        resolveResumeTarget("claude-code", recorded.record.historyKey, loadOpts()),
        null,
        "a deleted project folder must not be relaunched into",
      );
    });
  });
});
