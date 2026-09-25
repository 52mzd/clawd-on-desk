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

  var state = null; // { bridge, mode, project, stage, ... }
  var rootEl = null;
  var keydownHandler = null;

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
    state = { bridge: bridge, mode: mode, project: project, stage: "initial" };
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
      + '<div class="trellis-wizard-platforms">' + (boxes || "—") + '</div>';
    var actions = buttonHtml("cancel", "settingsTrellisWizardCancel")
      + buttonHtml("preview", "settingsTrellisWizardPreview", { primary: true });
    rootEl.innerHTML = shellHtml(bridge, "add", tr(bridge, "settingsTrellisWizardAddTitle"), body, actions);
    bindActions({
      cancel: close,
      preview: function () {
        var picked = [];
        var inputs = rootEl.querySelectorAll("[data-platform]");
        Array.prototype.forEach.call(inputs, function (input) {
          if (input.checked) picked.push(input.getAttribute("data-platform"));
        });
        if (picked.length === 0) return;
        renderLoading();
        var api = bridge.api || {};
        Promise.resolve()
          .then(function () {
            return api.trellisPreview({ paths: [state.project.path], platforms: picked });
          })
          .then(function (res) {
            var addPlan = res && Array.isArray(res.addPlan) ? res.addPlan[0] : null;
            renderAddPreview(picked, addPlan);
          })
          .catch(function (err) {
            renderError(err);
          });
      },
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
    Promise.resolve()
      .then(function () {
        return api.trellisAddPlatform(state.project.path, added);
      })
      .then(function (res) {
        finishFlow(res && res.status === "ok", res && res.output);
      })
      .catch(function (err) {
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
    Promise.resolve()
      .then(function () {
        // REAL dry run (09-25): the user asked for the actual
        // `trellis update --dry-run` output, not a synthesized plan — it
        // shows the real file-level migration list the CLI would touch.
        return api.trellisDryRun(project.path);
      })
      .then(function (res) {
        if (!res || res.status !== "ok" || !res.result) {
          renderError(new Error(res && res.message ? res.message : "dry run failed"));
          return;
        }
        var plan = null;
        // Version context still comes from the pure scan (current→to).
        return Promise.resolve(api.trellisPreview({ paths: [project.path] }))
          .then(function (pv) {
            plan = pv && Array.isArray(pv.plan) ? pv.plan[0] : null;
            renderUpgradeDryRun(plan, res.result);
          });
      })
      .catch(function (err) {
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
    var unsubscribe = null;
    if (typeof api.onTrellisProgress === "function") {
      unsubscribe = api.onTrellisProgress(function () { /* phase feed; result arrives via the promise */ });
    }
    Promise.resolve()
      .then(function () {
        return api.trellisUpgradeProject(state.project.path);
      })
      .then(function (res) {
        if (unsubscribe) { try { unsubscribe(); } catch (err) { /* noop */ } }
        finishFlow(res && res.status === "ok", res && res.output);
      })
      .catch(function (err) {
        if (unsubscribe) { try { unsubscribe(); } catch (err2) { /* noop */ } }
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
