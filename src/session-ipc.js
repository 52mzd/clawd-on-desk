"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DASHBOARD_PAGE_URL = pathToFileURL(path.join(__dirname, "dashboard.html")).toString();

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerSessionIpc requires ${name}`);
  return value;
}

function registerSessionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const getSessionSnapshot = requiredDependency(options.getSessionSnapshot, "getSessionSnapshot");
  const getI18n = requiredDependency(options.getI18n, "getI18n");
  const focusSession = requiredDependency(options.focusSession, "focusSession");
  const hideSession = requiredDependency(options.hideSession, "hideSession");
  const setSessionAlias = requiredDependency(options.setSessionAlias, "setSessionAlias");
  const showDashboard = requiredDependency(options.showDashboard, "showDashboard");
  const setSessionHudPinned = requiredDependency(options.setSessionHudPinned, "setSessionHudPinned");
  const setSessionHudTrellisDetailHeight = requiredDependency(
    options.setSessionHudTrellisDetailHeight,
    "setSessionHudTrellisDetailHeight"
  );
  const ackSessionCompletion = requiredDependency(options.ackSessionCompletion, "ackSessionCompletion");
  const openSessionFolder = requiredDependency(options.openSessionFolder, "openSessionFolder");
  const setSessionAutomationOverride = requiredDependency(
    options.setSessionAutomationOverride,
    "setSessionAutomationOverride"
  );
  const clearSessionAutomationGrant = requiredDependency(
    options.clearSessionAutomationGrant,
    "clearSessionAutomationGrant"
  );
  const getDashboardWebContents = requiredDependency(
    options.getDashboardWebContents,
    "getDashboardWebContents"
  );
  const getKimiQuotaStatus = requiredDependency(options.getKimiQuotaStatus, "getKimiQuotaStatus");
  const refreshKimiQuota = requiredDependency(options.refreshKimiQuota, "refreshKimiQuota");
  const getSessionHistory = requiredDependency(options.getSessionHistory, "getSessionHistory");
  const resumeSessionFromHistory = requiredDependency(
    options.resumeSessionFromHistory,
    "resumeSessionFromHistory"
  );
  const getTrellisTaskDetail = requiredDependency(
    options.getTrellisTaskDetail,
    "getTrellisTaskDetail"
  );
  const getTrellisNetworkOverview = requiredDependency(
    options.getTrellisNetworkOverview,
    "getTrellisNetworkOverview"
  );
  const getTrellisTaskDoc = requiredDependency(
    options.getTrellisTaskDoc,
    "getTrellisTaskDoc"
  );
  const getTrellisSpecTree = requiredDependency(
    options.getTrellisSpecTree,
    "getTrellisSpecTree"
  );
  const getTrellisSpecDoc = requiredDependency(
    options.getTrellisSpecDoc,
    "getTrellisSpecDoc"
  );
  const getTrellisArchiveList = requiredDependency(
    options.getTrellisArchiveList,
    "getTrellisArchiveList"
  );
  const listTrellisRoots = requiredDependency(options.listTrellisRoots, "listTrellisRoots");
  const addTrellisRoot = requiredDependency(options.addTrellisRoot, "addTrellisRoot");
  const removeTrellisRoot = requiredDependency(
    options.removeTrellisRoot,
    "removeTrellisRoot"
  );
  const removeTrellisPick = requiredDependency(
    options.removeTrellisPick,
    "removeTrellisPick"
  );
  const getTrellisActiveList = requiredDependency(
    options.getTrellisActiveList,
    "getTrellisActiveList"
  );
  const quickMode = options.quickMode || null;
  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  // The one owned Dashboard WebContents, its current real main frame, and the
  // exact local page URL. Resolving through a window would break once the page
  // lives in a WebContentsView, and loosening any of the three would widen the
  // Kimi manual-quota capability — neither is acceptable.
  function isTrustedDashboardEvent(event) {
    const contents = getDashboardWebContents();
    if (!contents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    const frame = event && event.senderFrame;
    return event.sender === contents
      && !!frame
      && frame === contents.mainFrame
      && frame.url === DASHBOARD_PAGE_URL;
  }

  function rejectUntrustedDashboardEvent(event) {
    return isTrustedDashboardEvent(event)
      ? null
      : { status: "error", reason: "untrusted-dashboard-sender" };
  }

  handle("dashboard:get-snapshot", () => getSessionSnapshot());
  handle("dashboard:get-i18n", () => getI18n());
  // Dashboard gets a narrow, secret-free manual refresh capability. The API
  // key remains inside kimiQuotaRuntime, and only the real local Dashboard
  // main frame may ask for status or trigger the existing refresh path.
  handle("dashboard:get-kimi-quota-status", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getKimiQuotaStatus();
  });
  handle("dashboard:refresh-kimi-quota", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || refreshKimiQuota();
  });
  on("dashboard:focus-session", (_event, sessionId) =>
    focusSession(sessionId, { requestSource: "dashboard" })
  );
  handle("dashboard:hide-session", (_event, sessionId) => hideSession(sessionId));
  handle("dashboard:open-session-folder", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "dashboard:open-session-folder requires a sessionId string" };
    }
    return openSessionFolder(sessionId);
  });
  // Session history is the resume index for conversations that are no longer
  // running. Rows carry working-directory paths, and resuming spawns a real
  // agent process, so both channels are restricted to the trusted Dashboard
  // frame the same way the Kimi quota capability is.
  handle("dashboard:get-session-history", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getSessionHistory();
  });
  handle("dashboard:resume-session", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "agentId"
      || keys[1] !== "historyKey"
      || typeof payload.agentId !== "string"
      || !payload.agentId
      || typeof payload.historyKey !== "string"
      || !/^[a-f0-9]{32}$/.test(payload.historyKey)
    ) {
      return { status: "invalid" };
    }
    // No mode field on purpose: the Dashboard can only resume with normal
    // permissions. --dangerously-skip-permissions stays behind the pet menu
    // flow, which confirms it explicitly.
    return resumeSessionFromHistory({
      agentId: payload.agentId,
      historyKey: payload.historyKey,
    });
  });

  // One-shot on-demand read of a Trellis task's files at a renderer-supplied
  // path — same trusted-frame gate as session history, plus strict payload
  // validation (the detail view is opened per click, never polled).
  handle("dashboard:trellis-task-detail", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "cwd"
      || keys[1] !== "taskPath"
      || typeof payload.cwd !== "string"
      || !payload.cwd
      || typeof payload.taskPath !== "string"
      || !payload.taskPath
    ) {
      return { status: "invalid" };
    }
    return getTrellisTaskDetail(payload);
  });

;

  // v7 R8 project-wide network overview: one-shot read of the whole
  // relation graph for a root (nodes + vertical parent edges + shared
  // spec/PRD horizontal groups). Same trusted-frame gate; `root` mirrors
  // the spec-tree payload.
  handle("dashboard:trellis-network-overview", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 1
      || keys[0] !== "root"
      || typeof payload.root !== "string"
      || !payload.root
    ) {
      return { status: "invalid" };
    }
    return getTrellisNetworkOverview(payload);
  });

  // One-shot on-demand read of ONE markdown document of a Trellis task —
  // same trusted-frame gate and the same cwd/taskPath validation story as
  // the detail read above; `doc` must be a plain *.md basename that the
  // owner re-validates against the directory listing (never a path).
  handle("dashboard:trellis-task-doc", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 3
      || keys[0] !== "cwd"
      || keys[1] !== "doc"
      || keys[2] !== "taskPath"
      || typeof payload.cwd !== "string"
      || !payload.cwd
      || typeof payload.taskPath !== "string"
      || !payload.taskPath
      || typeof payload.doc !== "string"
      || !payload.doc
    ) {
      return { status: "invalid" };
    }
    return getTrellisTaskDoc(payload);
  });

  // v4-a spec map: one-shot listing / reading of the trusted root's
  // .trellis/spec/**/*.md. Strict single-key {root} for the tree; strict
  // {root, relPath} for the doc — the owner re-validates relPath segment
  // by segment against live directory listings (never trusts it as a path).
  handle("dashboard:trellis-spec-tree", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    if (
      payload === null
      || typeof payload !== "object"
      || Array.isArray(payload)
      || Object.keys(payload).length !== 1
      || typeof payload.root !== "string"
      || !payload.root
    ) {
      return { status: "invalid" };
    }
    return getTrellisSpecTree(payload);
  });

  handle("dashboard:trellis-spec-doc", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "relPath"
      || keys[1] !== "root"
      || typeof payload.root !== "string"
      || !payload.root
      || typeof payload.relPath !== "string"
      || !payload.relPath
    ) {
      return { status: "invalid" };
    }
    return getTrellisSpecDoc(payload);
  });

  // One-shot on-demand scan of the archive folders behind the known
  // trellis roots (registered roots + session-resolved roots) — same
  // trusted-frame gate as the detail read. No payload: the root set comes
  // from the owner, never from the renderer, so browsing works with no
  // live session at all.
  handle("dashboard:trellis-archive-list", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getTrellisArchiveList();
  });

  // Registered project roots for the Dashboard's independent Trellis view.
  // list is a pure memory read; add opens the main-side directory picker
  // (the renderer never supplies a path); remove only accepts a string that
  // is already a registered member — all three restricted to the trusted
  // Dashboard frame.
  handle("dashboard:trellis-roots-list", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || listTrellisRoots();
  });
  handle("dashboard:trellis-roots-add", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || addTrellisRoot(event);
  });
  handle("dashboard:trellis-roots-remove", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 1
      || keys[0] !== "root"
      || typeof payload.root !== "string"
      || !payload.root
    ) {
      return { status: "invalid" };
    }
    return removeTrellisRoot(payload.root);
  });

  handle("dashboard:trellis-pick-remove", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 1
      || keys[0] !== "picked"
      || typeof payload.picked !== "string"
      || !payload.picked
    ) {
      return { status: "invalid" };
    }
    return removeTrellisPick(payload.picked);
  });

  // One-shot on-demand read of the non-archived tasks under the known
  // trellis roots — same trusted-frame gate; the root set lives in the
  // owner, so this channel takes no payload either.
  handle("dashboard:trellis-active-list", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getTrellisActiveList();
  });

  handle("dashboard:set-session-alias", (_event, payload) => setSessionAlias(payload));
  handle("dashboard:set-session-automation", (event, payload) => {
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "mode"
      || keys[1] !== "sessionId"
      || typeof payload.sessionId !== "string"
      || !payload.sessionId
      || (payload.mode !== "off" && payload.mode !== "auto-tools")
    ) {
      return { status: "invalid" };
    }
    return setSessionAutomationOverride(
      {
        sessionId: payload.sessionId,
        mode: payload.mode,
      },
      { sender: event && event.sender }
    );
  });
  handle("dashboard:clear-session-automation-grant", (_event, payload) => {
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload)
      : [];
    if (
      keys.length !== 1
      || keys[0] !== "grantId"
      || typeof payload.grantId !== "string"
      || !payload.grantId
    ) {
      return { status: "invalid" };
    }
    return clearSessionAutomationGrant({ grantId: payload.grantId });
  });

  // Dashboard keyboard mode. Every call is restricted to the trusted page and
  // carries the exact round it belongs to; a stale round can neither activate
  // a jump nor cancel the current one.
  //
  // On a platform where the mode is not offered the channels are never
  // registered at all — there is no capability to reach, not merely a handler
  // that answers "unsupported".
  const quickSupported = !!(quickMode
    && typeof quickMode.isSupported === "function"
    && quickMode.isSupported());

  if (quickSupported) {
    const quickResult = (handlerName, event, payload) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      if (rejected) return rejected;
      if (typeof quickMode[handlerName] !== "function") return { status: "unsupported" };
      return quickMode[handlerName](payload);
    };

    handle("dashboard:quick-pending", (event) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      if (rejected) return rejected;
      return { status: "ok", revision: quickMode.getPendingRevision() };
    });
    handle("dashboard:quick-enter", (event, payload) => quickResult("enter", event, payload));
    handle("dashboard:quick-ready", (event, payload) => quickResult("ready", event, payload));
    handle("dashboard:quick-activate", (event, payload) =>
      quickResult("activate", event, payload));
    handle("dashboard:quick-dismiss", (event, payload) =>
      quickResult("dismissFromRenderer", event, payload));
  }

  handle("session-hud:get-i18n", () => getI18n());
  handle("session-hud:open-session-folder", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "session-hud:open-session-folder requires a sessionId string" };
    }
    return openSessionFolder(sessionId);
  });
  on("session-hud:focus-session", (_event, sessionId) =>
    focusSession(sessionId, { requestSource: "hud" })
  );
  on("session-hud:open-dashboard", () => showDashboard({ source: "hud" }));
  on("session-hud:set-pinned", (_event, value) => setSessionHudPinned(!!value));
  on("session-hud:set-trellis-detail-height", (_event, px) =>
    setSessionHudTrellisDetailHeight(Number(px) || 0));

  on("settings:open-dashboard", () => showDashboard({ source: "settings" }));
  on("show-dashboard", () => showDashboard());

  // Both HUD and Dashboard call into this — invoke/handle (not send) so the
  // click handlers can re-enable the Mark-read button if the ack failed.
  handle("session:ack-completion", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "session:ack-completion requires a sessionId string" };
    }
    try {
      const acked = ackSessionCompletion(sessionId);
      if (!acked) return { status: "noop", reason: "not-pending-or-missing" };
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: err && err.message };
    }
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  registerSessionIpc,
};
