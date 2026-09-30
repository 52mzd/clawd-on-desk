/*
 * Trellis install / upgrade wizard modal (09-25).
 *
 * Two flows behind one lightweight dialog:
 *   openAddPlatform(bridge, project, catalogEntries, preselectId)
 *     select platforms -> preview (trellisPreview, zero spawn) -> confirm
 *     (trellisAddPlatform) -> result.
 *   openUpgradePreview(bridge, project)
 *     opens straight into the preview (trellisPreview) -> confirm
 *     (trellisUpgradeProject) -> progress (onTrellisProgress) -> result.
 *
 * Contract notes (see docs/project/trellis-settings-panel.md):
 * - Preview is PURE: it never spawns the CLI, never writes. The command
 *   shown in the dialog is display-only (escaped) — execution only happens
 *   through the existing settings:trellis-* IPC on confirm.
 * - No top-level timers, no insertBefore (vm-test sandbox parity with the
 *   dashboard renderer lessons), full cleanup in close().
 * - Every openShell() stamps `state.session` (09-30). The async chains
 *   (preview, dry run, install, upgrade) capture it at launch and bail out in
 *   each callback when the dialog they belong to is gone or replaced, so a
 *   late IPC reply never renders into — or executes against — another project.
 */
(function () {
  "use strict";

  var FALLBACK = {
    settingsTrellisWizardAddTitle: "Add Trellis platforms",
    settingsTrellisWizardUpgradeTitle: "Upgrade preview",
    settingsTrellisWizardSelectHint: "Pick the platforms to install into this project:",
    settingsTrellisWizardPreview: "Preview",
    settingsTrellisWizardConfirmInstall: "Install",
    settingsTrellisWizardConfirmUpgrade: "Upgrade now",
    settingsTrellisWizardUpToDate: "Already up to date",
    settingsTrellisWizardRunning: "Running…",
    settingsTrellisWizardDone: "Done",
    settingsTrellisWizardFailed: "Failed",
    settingsTrellisWizardCancel: "Cancel",
    settingsTrellisWizardClose: "Close",
    settingsTrellisWizardRetry: "Back",
    settingsTrellisWizardCommandTitle: "Command",
    settingsTrellisWizardDryRunTitle: "Dry run — trellis update --dry-run",
    settingsTrellisWizardAddedPlatforms: "Platforms to add",
    settingsTrellisWizardNothingToAdd: "Nothing new to add for the selected platforms.",
    settingsTrellisWizardProjectLabel: "Project",
    settingsTrellisWizardVersionLabel: "Version",
    settingsTrellisWizardUserNameLabel: "Developer name",
    settingsTrellisWizardUserNamePlaceholder: "usually your git username",
    settingsTrellisWizardUserNameHint: "Trellis creates .trellis/workspace/<name>/ as your personal workspace.",
  };

  function tr(bridge, key) {
    if (bridge && typeof bridge.t === "function") {
      try {
        var s = bridge.t(key);
        if (typeof s === "string" && s && s !== key) return s;
      } catch (err) { /* fall through */ }
    }
    return FALLBACK[key] || key;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function commandText(command) {
    if (!command || !command.bin) return "";
    var parts = [command.bin].concat(Array.isArray(command.args) ? command.args : []);
    return parts.join(" ");
  }

  var state = null; // { bridge, mode, project, stage, session, ... }
  var rootEl = null;
  var keydownHandler = null;
  var sessionSeq = 0;

  // True while the dialog opened with `session` is still the live one. Async
  // callbacks check this first: after close() or a re-open, `state` is null
  // or carries a newer session, and the stale result must be dropped.
  function isLive(session) {
    return !!state && state.session === session;
  }

  function close() {
    if (keydownHandler) {
      try { document.removeEventListener("keydown", keydownHandler); } catch (err) { /* noop */ }
      keydownHandler = null;
    }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null;
    state = null;
  }

  function openShell(bridge, mode, project) {
    close();
    // `userName` is the developer identity typed in the first-install field
    // (09-27). It lives on the wizard state so select → preview → back keeps
    // the value; empty means "not typed yet" and the probe/fallback chain
    // takes over.
    state = { bridge: bridge, mode: mode, project: project, stage: "initial", userName: "" };
    state.session = ++sessionSeq;
    rootEl = document.createElement("div");
    rootEl.className = "modal-backdrop trellis-wizard-backdrop";
    rootEl.addEventListener("click", function (ev) {
      if (ev.target === rootEl && state && state.stage !== "running") close();
    });
    keydownHandler = function (ev) {
      if (ev.key === "Escape" && state && state.stage !== "running") {
        ev.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", keydownHandler);
    document.body.appendChild(rootEl);
  }

  function shellHtml(bridge, mode, titleText, bodyHtml, actionsHtml) {
    return ''
      + '<div class="settings-dialog settings-confirm-modal trellis-wizard" role="dialog" aria-modal="true">'
      + '<h2>' + escapeHtml(titleText) + '</h2>'
      + '<div class="trellis-wizard-project">'
      + escapeHtml(tr(bridge, "settingsTrellisWizardProjectLabel")) + ': '
      + '<code>' + escapeHtml(projectName(state.project)) + '</code>'
      + '</div>'
      + '<div class="trellis-wizard-body">' + bodyHtml + '</div>'
      + '<div class="trellis-wizard-actions">' + actionsHtml + '</div>'
      + '</div>';
  }

  function projectName(project) {
    // Project display name (09-25): scan supplies name = folder name; fall
    // back to the path's basename on either separator when absent.
    if (!project) return "";
    if (project.name && typeof project.name === "string") return project.name;
    var p = String(project.path || project.root || "");
    var segs = p.split(/[\\/]/);
    return segs[segs.length - 1] || p;
  }

  function buttonHtml(kind, labelKey, opts) {
    var options = opts || {};
    var cls = "soft-btn " + (options.primary ? "soft-btn-primary" : "");
    return '<button type="button" data-wizard="' + kind + '" class="' + cls + '"'
      + (options.disabled ? ' disabled' : '')
      + '>' + escapeHtml(tr(state.bridge, labelKey)) + '</button>';
  }

  function bindActions(handlers) {
    if (!rootEl) return;
    var buttons = rootEl.querySelectorAll("[data-wizard]");
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener("click", function () {
        var kind = btn.getAttribute("data-wizard");
        if (Object.prototype.hasOwnProperty.call(handlers, kind)) handlers[kind]();
      });
    });
  }

  function commandBlock(bridge, command) {
    var text = commandText(command);
    if (!text) return "";
    return '<div class="trellis-wizard-command-wrap">'
      + '<div class="trellis-wizard-command-title">'
      + escapeHtml(tr(bridge, "settingsTrellisWizardCommandTitle"))
      + '</div>'
      + '<code class="trellis-wizard-command">' + escapeHtml(text) + '</code>'
      + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * Developer identity (first install only)
   * ------------------------------------------------------------------ */

  // `-u` sets the Trellis developer identity, so the field only makes sense on
  // a first init: for an already-installed project the CLI protects the
  // existing `.trellis/.developer` and `.trellis/workspace/<name>/`, and
  // showing the field would imply the wizard could rename that workspace.
  function isFirstInstall() {
    return !!(state && state.project && state.project.installed === false);
  }

  function userFieldHtml(bridge) {
    // `maxlength` counts UTF-16 code units, the CLI cap counts code points
    // (M2). 128 units is the widest a 64-code-point name can be, so an emoji
    // name is never cut mid-pair here; `captureUserName` then applies the real
    // 64-code-point cap and the CLI re-validates. Attribute is valueless-safe:
    // the vm harness parses `maxlength="…"` and nothing else.
    return '<div class="trellis-wizard-field" data-field="user">'
      + '<label class="trellis-wizard-field-label" for="trellis-wizard-user">'
      + escapeHtml(tr(bridge, "settingsTrellisWizardUserNameLabel"))
      + '</label>'
      + '<input id="trellis-wizard-user" class="trellis-wizard-input" type="text"'
      + ' data-user maxlength="128" autocomplete="off" spellcheck="false"'
      + ' placeholder="' + escapeHtml(tr(bridge, "settingsTrellisWizardUserNamePlaceholder")) + '">'
      + '<p class="trellis-wizard-hint">'
      + escapeHtml(tr(bridge, "settingsTrellisWizardUserNameHint"))
      + '</p>'
      + '</div>';
  }

  // Read the field back into state before any stage change, so the value
  // survives preview → back and reaches the install call. Trimmed here (M5):
  // the preview and the install use the sanitized `-u`, and re-applying the
  // raw value on back would show a name the command does not use. The
  // 64-code-point cap mirrors the CLI so a paste cannot leave a half pair.
  var USER_NAME_MAX_CODE_POINTS = 64;
  function captureUserName() {
    if (!rootEl) return;
    var input = rootEl.querySelector("[data-user]");
    if (!input) return;
    var raw = typeof input.value === "string" ? input.value.trim() : "";
    var points = Array.from(raw);
    state.userName = points.length > USER_NAME_MAX_CODE_POINTS
      ? points.slice(0, USER_NAME_MAX_CODE_POINTS).join("")
      : raw;
  }

  // Re-apply the stored value after a re-render, or ask the main process for
  // the `git config user.name` default when the user has not typed one yet.
  // `state.userName` is already trimmed by `captureUserName`, so the value
  // shown after `back` is exactly the value the preview showed (M5).
  function syncUserNameField() {
    if (!rootEl) return;
    var input = rootEl.querySelector("[data-user]");
    if (!input) return;
    if (state.userName) {
      input.value = state.userName;
      return;
    }
    var api = (state.bridge && state.bridge.api) || {};
    if (typeof api.trellisUserSuggestion !== "function") return;
    Promise.resolve()
      .then(function () { return api.trellisUserSuggestion(); })
      .then(function (res) {
        var name = res && typeof res.name === "string" ? res.name.trim() : "";
        // The probe resolves after the render: the stage may have moved on,
        // or the user may have started typing.
        if (!name || !rootEl || input.value) return;
        if (rootEl.querySelector("[data-user]") !== input) return;
        input.value = name;
      })
      .catch(function () { /* the suggestion is best-effort */ });
  }

  /* ------------------------------------------------------------------ *
   * Flow A: add platforms
   * ------------------------------------------------------------------ */

  function openAddPlatformInner(bridge, project, catalogEntries, preselectId) {
    var entries = (Array.isArray(catalogEntries) ? catalogEntries : [])
      .filter(function (entry) { return entry && entry.id; });
    var registered = {};
    (project && Array.isArray(project.platforms) ? project.platforms : [])
      .forEach(function (id) { registered[id] = true; });
    var available = entries.filter(function (entry) { return !registered[entry.id]; });
    var selected = {};
    if (preselectId) selected[preselectId] = true;
    renderAddSelect(available, selected);
  }

  function renderAddSelect(available, selected) {
    var bridge = state.bridge;
    var boxes = available.map(function (entry) {
      var id = escapeHtml(entry.id);
      var label = escapeHtml(entry.label || entry.id);
      var on = selected[entry.id] ? " checked" : "";
      var stale = entry.stale ? ' <span class="trellis-wizard-stale">&#9888;</span>' : "";
      return '<label class="trellis-wizard-platform">'
        + '<input type="checkbox" data-platform="' + id + '"' + on + '>'
        + '<span>' + label + stale + '</span>'
        + '</label>';
    }).join("");
    var body = '<p class="trellis-wizard-hint">'
      + escapeHtml(tr(bridge, "settingsTrellisWizardSelectHint"))
      + '</p>'
      + '<div class="trellis-wizard-platforms">' + (boxes || "—") + '</div>'
      + (isFirstInstall() ? userFieldHtml(bridge) : "");
    var actions = buttonHtml("cancel", "settingsTrellisWizardCancel")
      + buttonHtml("preview", "settingsTrellisWizardPreview", { primary: true });
    rootEl.innerHTML = shellHtml(bridge, "add", tr(bridge, "settingsTrellisWizardAddTitle"), body, actions);
    // After the render: put back a value the user already typed, or fetch the
    // `git config user.name` suggestion (never awaited — the modal is usable
    // while the probe is in flight).
    if (isFirstInstall()) syncUserNameField();
    bindActions({
      cancel: close,
      preview: function () {
        var picked = [];
        var inputs = rootEl.querySelectorAll("[data-platform]");
        Array.prototype.forEach.call(inputs, function (input) {
          if (input.checked) picked.push(input.getAttribute("data-platform"));
        });
        if (picked.length === 0) return;
        captureUserName();
        renderLoading();
        requestAddPreview(picked);
      },
    });
  }

  function requestAddPreview(picked) {
    var api = (state.bridge && state.bridge.api) || {};
    var session = state.session;
    var project = state.project;
    var payload = { paths: [project.path], platforms: picked };
    // 只有首次 init 才带 `-u`：加平台时 CLI 会忽略它，把目录名显示在
    // 预览命令里只会让用户以为身份被改成了目录名。
    if (isFirstInstall()) payload.userName = state.userName;
    Promise.resolve()
      .then(function () {
        return api.trellisPreview(payload);
      })
      .then(function (res) {
        if (!isLive(session)) return;
        var addPlan = res && Array.isArray(res.addPlan) ? res.addPlan[0] : null;
        renderAddPreview(picked, addPlan);
      })
      .catch(function (err) {
        if (!isLive(session)) return;
        renderError(err);
      });
  }

  function renderAddPreview(picked, addPlan) {
    var bridge = state.bridge;
    var added = addPlan && Array.isArray(addPlan.added) ? addPlan.added : picked;
    // Project name rides the preview (09-25): addPlan.name is the folder
    // name from the runtime — the user must see WHICH named project the
    // command targets, not only the path buried in the shell header.
    var displayName = (addPlan && addPlan.name) || projectName(state.project);
    var body;
    if (added.length === 0) {
      body = '<p class="trellis-wizard-hint">'
        + escapeHtml(tr(bridge, "settingsTrellisWizardNothingToAdd"))
        + '</p>';
    } else {
      var items = added.map(function (id) {
        return '<li>' + escapeHtml(id) + '</li>';
      }).join("");
      body = '<div class="trellis-wizard-section-title">'
        + escapeHtml(tr(bridge, "settingsTrellisWizardProjectLabel"))
        + '</div>'
        + '<div class="trellis-wizard-version"><code>' + escapeHtml(displayName) + '</code></div>'
        + '<div class="trellis-wizard-section-title">'
        + escapeHtml(tr(bridge, "settingsTrellisWizardAddedPlatforms"))
        + '</div>'
        + '<ul class="trellis-wizard-added">' + items + '</ul>'
        + commandBlock(bridge, addPlan && addPlan.command);
    }
    var actions = buttonHtml("cancel", "settingsTrellisWizardCancel")
      + buttonHtml("back", "settingsTrellisWizardRetry")
      + (added.length > 0
        ? buttonHtml("install", "settingsTrellisWizardConfirmInstall", { primary: true })
        : "");
    rootEl.innerHTML = shellHtml(bridge, "add", tr(bridge, "settingsTrellisWizardAddTitle"), body, actions);
    bindActions({
      cancel: close,
      back: function () { renderAddSelect(availableFromState(), selectedFromPicked(picked)); },
      install: function () { runInstall(added); },
    });
  }

  function availableFromState() {
    // Re-derive from the project snapshot captured at open time.
    var registered = {};
    (state.project && Array.isArray(state.project.platforms) ? state.project.platforms : [])
      .forEach(function (id) { registered[id] = true; });
    return (state.catalog || []).filter(function (entry) { return !registered[entry.id]; });
  }

  function selectedFromPicked(picked) {
    var map = {};
    (picked || []).forEach(function (id) { map[id] = true; });
    return map;
  }

  function runInstall(added) {
    var bridge = state.bridge;
    state.stage = "running";
    rootEl.innerHTML = shellHtml(bridge, "add",
      tr(bridge, "settingsTrellisWizardAddTitle"),
      '<p class="trellis-wizard-hint">' + escapeHtml(tr(bridge, "settingsTrellisWizardRunning")) + '</p>',
      "");
    var api = bridge.api || {};
    var session = state.session;
    var project = state.project;
    // 与 preview 同源：只有首次 init 才带身份，加平台传 undefined
    var userName = isFirstInstall() ? state.userName : undefined;
    Promise.resolve()
      .then(function () {
        return api.trellisAddPlatform(project.path, added, userName);
      })
      .then(function (res) {
        if (!isLive(session)) return;
        finishFlow(res && res.status === "ok", res && res.output);
      })
      .catch(function (err) {
        if (!isLive(session)) return;
        finishFlow(false, err && err.message ? err.message : String(err));
      });
  }

  /* ------------------------------------------------------------------ *
   * Flow B: upgrade preview
   * ------------------------------------------------------------------ */

  function openUpgradePreviewInner(bridge, project) {
    openShell(bridge, "upgrade", project);
    renderLoading();
    var api = bridge.api || {};
    var session = state.session;
    // Set by the dry-run step; stays null when that step bailed out (stale
    // session or error already rendered) so the preview step is a no-op.
    var dryResult = null;
    Promise.resolve()
      .then(function () {
        // REAL dry run (09-25): the user asked for the actual
        // `trellis update --dry-run` output, not a synthesized plan — it
        // shows the real file-level migration list the CLI would touch.
        return api.trellisDryRun(project.path);
      })
      .then(function (res) {
        if (!isLive(session)) return;
        if (!res || res.status !== "ok" || !res.result) {
          renderError(new Error(res && res.message ? res.message : "dry run failed"));
          return;
        }
        dryResult = res.result;
        // Version context still comes from the pure scan (current→to).
        return api.trellisPreview({ paths: [project.path] });
      })
      .then(function (pv) {
        if (!dryResult || !isLive(session)) return;
        var plan = pv && Array.isArray(pv.plan) ? pv.plan[0] : null;
        renderUpgradeDryRun(plan, dryResult);
      })
      .catch(function (err) {
        if (!isLive(session)) return;
        renderError(err);
      });
  }

  function renderUpgradeDryRun(plan, dryResult) {
    var bridge = state.bridge;
    var upgradable = !!(plan && plan.upgradable);
    var from = plan ? (plan.current || plan.from || "?") : "?";
    var to = plan ? (plan.to || "?") : "?";
    var body = '<div class="trellis-wizard-section-title">'
      + escapeHtml(tr(bridge, "settingsTrellisWizardVersionLabel"))
      + '</div>'
      + '<div class="trellis-wizard-version">'
      + '<code>' + escapeHtml(from) + '</code>'
      + '<span class="trellis-wizard-arrow">&#8594;</span>'
      + '<code>' + escapeHtml(to) + '</code>'
      + (upgradable ? "" : '<span class="trellis-wizard-stale"> '
        + escapeHtml(tr(bridge, "settingsTrellisWizardUpToDate")) + '</span>')
      + '</div>'
      + '<div class="trellis-wizard-section-title">'
      + escapeHtml(tr(bridge, "settingsTrellisWizardDryRunTitle"))
      + '</div>'
      + '<pre class="trellis-wizard-output">'
      + escapeHtml(dryResult && dryResult.output ? dryResult.output : "(no output)")
      + '</pre>'
      + commandBlock(bridge, plan && plan.command);
    var actions = buttonHtml("cancel", "settingsTrellisWizardCancel")
      + (upgradable ? buttonHtml("upgrade", "settingsTrellisWizardConfirmUpgrade", { primary: true }) : "");
    rootEl.innerHTML = shellHtml(bridge, "upgrade",
      tr(bridge, "settingsTrellisWizardUpgradeTitle"), body, actions);
    bindActions({
      cancel: close,
      upgrade: function () { runUpgrade(); },
    });
  }

  function runUpgrade() {
    var bridge = state.bridge;
    state.stage = "running";
    rootEl.innerHTML = shellHtml(bridge, "upgrade",
      tr(bridge, "settingsTrellisWizardUpgradeTitle"),
      '<p class="trellis-wizard-hint">' + escapeHtml(tr(bridge, "settingsTrellisWizardRunning")) + '</p>',
      "");
    var api = bridge.api || {};
    var session = state.session;
    var project = state.project;
    var unsubscribe = null;
    if (typeof api.onTrellisProgress === "function") {
      unsubscribe = api.onTrellisProgress(function () { /* phase feed; result arrives via the promise */ });
    }
    Promise.resolve()
      .then(function () {
        return api.trellisUpgradeProject(project.path);
      })
      .then(function (res) {
        if (unsubscribe) { try { unsubscribe(); } catch (err) { /* noop */ } }
        if (!isLive(session)) return;
        finishFlow(res && res.status === "ok", res && res.output);
      })
      .catch(function (err) {
        if (unsubscribe) { try { unsubscribe(); } catch (err2) { /* noop */ } }
        if (!isLive(session)) return;
        finishFlow(false, err && err.message ? err.message : String(err));
      });
  }

  /* ------------------------------------------------------------------ *
   * Shared stages
   * ------------------------------------------------------------------ */

  function renderLoading() {
    var bridge = state.bridge;
    rootEl.innerHTML = shellHtml(bridge, state.mode,
      tr(bridge, state.mode === "add"
        ? "settingsTrellisWizardAddTitle"
        : "settingsTrellisWizardUpgradeTitle"),
      '<p class="trellis-wizard-hint">…</p>',
      buttonHtml("cancel", "settingsTrellisWizardCancel"));
    bindActions({ cancel: close });
  }

  function renderError(err) {
    var bridge = state.bridge;
    state.stage = "error";
    var msg = err && err.message ? err.message : String(err || "error");
    rootEl.innerHTML = shellHtml(bridge, state.mode,
      tr(bridge, state.mode === "add"
        ? "settingsTrellisWizardAddTitle"
        : "settingsTrellisWizardUpgradeTitle"),
      '<p class="trellis-wizard-error">' + escapeHtml(tr(bridge, "settingsTrellisWizardFailed"))
      + ': ' + escapeHtml(msg) + '</p>',
      buttonHtml("cancel", "settingsTrellisWizardClose"));
    bindActions({ cancel: close });
  }

  function finishFlow(ok, output) {
    var bridge = state.bridge;
    state.stage = ok ? "done" : "error";
    var head = ok
      ? escapeHtml(tr(bridge, "settingsTrellisWizardDone"))
      : escapeHtml(tr(bridge, "settingsTrellisWizardFailed"));
    var body = '<p class="trellis-wizard-' + (ok ? "ok" : "error") + '">' + head + '</p>'
      + (output ? '<pre class="trellis-wizard-output">' + escapeHtml(output) + '</pre>' : '');
    rootEl.innerHTML = shellHtml(bridge, state.mode,
      tr(bridge, state.mode === "add"
        ? "settingsTrellisWizardAddTitle"
        : "settingsTrellisWizardUpgradeTitle"),
      body,
      buttonHtml("cancel", "settingsTrellisWizardClose"));
    bindActions({ cancel: close });
    if (ok && bridge && typeof bridge.onFinished === "function") {
      try { bridge.onFinished(); } catch (err) { /* rescan is best-effort */ }
    }
  }

  globalThis.ClawdTrellisWizard = {
    openAddPlatform: function (bridge, project, catalogEntries, preselectId) {
      openShell(bridge, "add", project);
      state.catalog = Array.isArray(catalogEntries) ? catalogEntries : [];
      openAddPlatformInner(bridge, project, catalogEntries, preselectId);
    },
    openUpgradePreview: function (bridge, project) {
      openUpgradePreviewInner(bridge, project);
    },
    close: close,
  };
})();
