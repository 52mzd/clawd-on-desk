"use strict";

// Settings → Trellis tab.
//
// A read-mostly panel: it scans the configured folders (direct subfolders
// only) for Trellis projects, shows the Trellis platform record each project
// carries, and lets the user upgrade a project, upgrade the global CLI, or add
// a platform to one project. Nothing here runs on its own — there is no timer,
// no watcher, and no work at render time. Every write is behind a button that
// calls one `window.settingsAPI.trellis*` channel; the main process owns the
// platform whitelist, the path validation and the argv.
//
// `upgradable: null` (unknown) is NOT "up to date": null renders as unknown and
// gets no upgrade button. Only `true` renders the upgrade action.

(function initSettingsTabTrellis(root) {
  // The platform picker list arrives over IPC: `settings:trellis-scan` returns
  // `platformCatalog`, projected from `src/trellis-platforms.js` PLATFORMS.
  // Keeping a copy here would silently drift from that table, which stays
  // authoritative - `trellis-ipc` rejects any id outside it before an argv is
  // built. Until a scan succeeds the picker is empty rather than guessed.
  let platformCatalog = [];
  function platformById(id) {
    return platformCatalog.find((entry) => entry.id === id) || null;
  }
  const UNKNOWN_PLATFORM_PREFIX = "unknown:";
  const GLOBAL_INSTALL_COMMAND = "npm i -g @mindfoldhq/trellis";

  let state = null;
  let helpers = null;
  let ops = null;

  // Kept across renders: the panel must not re-scan (or lose the batch state)
  // just because a render happened.
  let scanResult = null;
  let scanning = false;
  let scanError = "";
  let previewPlan = null;
  let previewVisible = false;
  let filterIds = new Set();
  // "" means auto: keep the per-project inference. The values themselves come
  // from the scan snapshot's `channelCatalog`, so this file holds no second
  // copy of the channel list.
  let channelFilter = "";
  let channelCatalog = [];
  let progressByPath = new Map();
  let batchRunning = false;
  let addTarget = null;
  let addPlatformId = "";
  let addPlan = null;
  let addFailed = false;
  let unsubscribeProgress = null;
  let rowStatusNodes = new Map();

  function t(key) {
    return helpers.t(key);
  }

  function tf(key, vars) {
    return format(t(key), vars);
  }

  function format(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (match, name) => (
      vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
    ));
  }

  function requestRender() {
    ops.requestRender({ content: true });
  }

  function api() {
    return (typeof window !== "undefined" && window.settingsAPI) || null;
  }

  // ── platform helpers ──────────────────────────────────────────────
  function platformLabel(id) {
    if (typeof id !== "string" || !id) return "";
    const choice = platformById(id);
    if (choice) return choice.label;
    if (id.startsWith(UNKNOWN_PLATFORM_PREFIX)) {
      return `${t("trellisUnknownPlatform")} (${id.slice(UNKNOWN_PLATFORM_PREFIX.length)})`;
    }
    return id;
  }

  function platformsText(ids) {
    const list = Array.isArray(ids) ? ids.filter(Boolean).map(platformLabel) : [];
    return list.length > 0 ? list.join(", ") : "";
  }

  function matchFilter(project) {
    if (filterIds.size === 0) return true;
    const platforms = Array.isArray(project.platforms) ? project.platforms : [];
    return platforms.some((id) => filterIds.has(id));
  }

  function currentRoots() {
    const snapshot = state && state.snapshot;
    if (snapshot && Array.isArray(snapshot.trellisScanRoots)) return snapshot.trellisScanRoots;
    if (scanResult && Array.isArray(scanResult.roots)) return scanResult.roots;
    return [];
  }

  function projects() {
    return scanResult && Array.isArray(scanResult.projects) ? scanResult.projects : [];
  }

  // The list the user can actually see. Batch actions act on this, never on
  // rows hidden by the platform filter.
  function visibleProjects() {
    return projects().filter(matchFilter);
  }

  function installedProjects() {
    return visibleProjects().filter((project) => project.installed === true);
  }

  function upgradablePaths() {
    return visibleProjects()
      .filter((project) => project.installed === true && project.upgradable === true)
      .map((project) => project.path);
  }

  function commandText(command) {
    if (!command) return "";
    const args = Array.isArray(command.args) ? command.args.join(" ") : "";
    return args ? `${command.bin} ${args}` : String(command.bin || "");
  }

  function versionTextFor(project) {
    if (!project || project.installed !== true) return "—";
    return `${project.current || "—"} → ${project.target || "—"}`;
  }

  // A row's badge is driven by the batch progress first (live feedback), then
  // by the scan snapshot. `upgradable === null` deliberately maps to "unknown",
  // never to "up to date".
  function statusFor(project) {
    const progress = progressByPath.get(project.path);
    if (progress) {
      if (progress.phase === "queued") return { key: "trellisStatusQueued", kind: "muted" };
      if (progress.phase === "running") return { key: "trellisStatusRunning", kind: "accent" };
      if (progress.phase === "ok") return { key: "trellisStatusOk", kind: "ok" };
      if (progress.phase === "failed") {
        return { key: "trellisStatusFailed", kind: "warn", message: progress.message || "" };
      }
      if (progress.phase === "cancelled") return { key: "trellisStatusCancelled", kind: "muted" };
    }
    if (project.installed !== true) return { key: "trellisStatusNotInstalled", kind: "muted" };
    if (!project.current) return { key: "trellisStatusVersionUnknown", kind: "muted" };
    if (project.upgradable === null) return { key: "trellisStatusUnknown", kind: "muted" };
    if (project.upgradable === true) return { key: "trellisStatusUpgradable", kind: "accent" };
    return { key: "trellisStatusLatest", kind: "ok" };
  }

  function badgeClass(kind) {
    if (kind === "ok") return "agent-badge integration";
    if (kind === "accent") return "agent-badge accent";
    if (kind === "warn") return "agent-badge custom-missing";
    return "agent-badge";
  }

  // ── DOM helpers ───────────────────────────────────────────────────
  function buildRow(labelText, descText) {
    const row = document.createElement("div");
    row.className = "row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = labelText;
    text.appendChild(label);
    if (descText) {
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.textContent = descText;
      text.appendChild(desc);
    }
    const control = document.createElement("div");
    control.className = "row-control";
    row.appendChild(text);
    row.appendChild(control);
    return { row, text, control };
  }

  function buildDescRow(text) {
    const row = document.createElement("div");
    row.className = "row";
    const span = document.createElement("span");
    span.className = "row-desc";
    span.textContent = text;
    row.appendChild(span);
    return row;
  }

  function buildCopyButton(text) {
    return helpers.buildButton({
      label: t("trellisCopy"),
      size: "compact",
      tone: "quiet",
      onClick: () => {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
        navigator.clipboard.writeText(text).then(() => ops.showToast(t("trellisCopied"))).catch(() => {});
      },
    });
  }

  function buildCommandBlock(command) {
    const wrap = document.createElement("div");
    wrap.className = "trellis-command";
    const label = document.createElement("span");
    label.className = "trellis-command-label";
    label.textContent = `${t("trellisPreviewCommand")}: `;
    wrap.appendChild(label);
    const code = document.createElement("code");
    code.textContent = commandText(command);
    wrap.appendChild(code);
    const cwd = document.createElement("span");
    cwd.className = "trellis-command-cwd";
    cwd.textContent = `${t("trellisPreviewCwd")}: ${command && command.cwd ? command.cwd : ""}`;
    wrap.appendChild(cwd);
    wrap.appendChild(buildCopyButton(commandText(command)));
    return wrap;
  }

  // ── section 1: scan roots ─────────────────────────────────────────
  // The scan snapshot carries one entry per root with a `readable` flag, so an
  // unreadable root is distinguishable from an empty one. Before the first
  // scan the roots are known but their readability is not (`null`).
  function rootScans() {
    if (scanResult && Array.isArray(scanResult.scans)) return scanResult.scans;
    return currentRoots().map((root) => ({ root, readable: null, projects: [] }));
  }

  function allRootsUnreadable() {
    const scans = rootScans();
    return scans.length > 0 && scans.every((scan) => scan.readable === false);
  }

  function buildRootsSection() {
    const scans = rootScans();
    const rows = [];

    const head = buildRow(t("trellisRootsTitle"), t("trellisScanHint"));
    head.control.appendChild(helpers.buildButton({
      label: t("trellisAddRoot"),
      tone: "accent",
      size: "compact",
      onClick: onAddRoot,
    }));
    rows.push(head.row);

    if (scans.length === 0) {
      rows.push(buildDescRow(t("trellisRootsEmpty")));
    } else {
      for (const scan of scans) rows.push(buildRootRow(scan));
    }
    return helpers.buildSection("", rows);
  }

  function buildRootRow(scan) {
    const rootPath = scan.root;
    const desc = scan.readable === false ? t("trellisRootUnreadable") : "";
    const { row, control } = buildRow(rootPath, desc);
    control.appendChild(helpers.buildButton({
      label: t("trellisRemove"),
      size: "compact",
      tone: "danger",
      onClick: () => onRemoveRoot(rootPath),
    }));
    return row;
  }

  function onAddRoot() {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.trellisPickRoot !== "function") return;
    settingsApi.trellisPickRoot().then((result) => {
      if (!result || result.status !== "ok" || !result.path) return;
      return setRoots([...currentRoots(), result.path]);
    }).catch(() => {});
  }

  function onRemoveRoot(rootPath) {
    setRoots(currentRoots().filter((entry) => entry !== rootPath));
  }

  function setRoots(roots) {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.trellisSetRoots !== "function") return Promise.resolve();
    return settingsApi.trellisSetRoots(roots).then((result) => {
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("trellisScanFailed"), { error: true });
        return;
      }
      return runScan();
    }).catch(() => {});
  }

  // ── section 2: toolbar ────────────────────────────────────────────
  function channelOptions() {
    return Array.isArray(channelCatalog) ? channelCatalog : [];
  }

  function remoteText() {
    if (!scanResult) return t("trellisScanHint");
    const remote = scanResult.remote || {};
    if (remote.error || !remote.channels) return t("trellisRemoteUnavailable");
    const known = channelOptions();
    const names = known.length > 0 ? known : Object.keys(remote.channels);
    const parts = names
      .filter((channel) => remote.channels[channel])
      .map((channel) => `${channel} ${remote.channels[channel]}`);
    return parts.length > 0 ? parts.join(" · ") : t("trellisRemoteUnavailable");
  }

  function remoteFailed() {
    if (!scanResult) return false;
    const remote = scanResult.remote || {};
    return !!remote.error || !remote.channels;
  }

  // Only rendered once a scan has supplied the channel catalog: the list is
  // projected by the main process, so this file never owns a second copy.
  function buildChannelSelect() {
    const options = channelOptions();
    if (options.length === 0) return null;
    const select = document.createElement("select");
    select.className = "trellis-platform-select";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = t("trellisChannelAuto");
    select.appendChild(auto);
    for (const channel of options) {
      const option = document.createElement("option");
      option.value = channel;
      option.textContent = channel;
      select.appendChild(option);
    }
    select.value = channelFilter;
    select.addEventListener("change", () => {
      channelFilter = select.value;
      runScan();
    });
    return select;
  }

  function buildToolbarSection() {
    const label = scanning
      ? `${t("trellisRemoteTitle")}: ${t("trellisRefresh")}…`
      : `${t("trellisRemoteTitle")}: ${remoteText()}`;
    const scopeCount = upgradablePaths().length;
    const descParts = [];
    if (scanError) descParts.push(scanError);
    // The batch only ever touches the currently visible list, so the count is
    // the filter-scoped one.
    if (scopeCount > 0) descParts.push(tf("trellisUpgradeAllCount", { count: scopeCount }));
    const { row, control } = buildRow(label, descParts.join(" · "));

    const channelSelect = buildChannelSelect();
    if (channelSelect) control.appendChild(channelSelect);
    control.appendChild(helpers.buildButton({
      label: t("trellisRefresh"),
      size: "compact",
      disabled: scanning,
      onClick: () => { runScan(); },
    }));
    control.appendChild(helpers.buildButton({
      label: t("trellisPreview"),
      size: "compact",
      disabled: scanning || !scanResult,
      onClick: onPreview,
    }));
    control.appendChild(helpers.buildButton({
      label: t("trellisUpgradeAll"),
      tone: "accent",
      size: "compact",
      disabled: scanning || scopeCount === 0,
      onClick: onUpgradeAll,
    }));
    control.appendChild(helpers.buildButton({
      label: t("trellisCancel"),
      size: "compact",
      disabled: !batchRunning,
      onClick: onCancelBatch,
    }));
    if (remoteFailed()) {
      control.appendChild(helpers.buildButton({
        label: t("trellisRetry"),
        size: "compact",
        onClick: () => { runScan(); },
      }));
    }
    return helpers.buildSection("", [row]);
  }

  function runScan() {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.trellisScan !== "function") {
      scanError = t("trellisScanFailed");
      requestRender();
      return Promise.resolve();
    }
    if (scanning) return Promise.resolve();
    scanning = true;
    scanError = "";
    requestRender();
    const request = channelFilter ? { channel: channelFilter } : {};
    return settingsApi.trellisScan(request).then((result) => {
      scanning = false;
      if (!result || result.status !== "ok") {
        scanError = (result && result.message) || t("trellisScanFailed");
      } else {
        scanResult = result;
        scanError = "";
        progressByPath = new Map();
        // Rebuilt on every successful scan; an empty array simply means no
        // picker options until the next successful scan.
        platformCatalog = Array.isArray(result.platformCatalog)
          ? result.platformCatalog.filter((entry) => entry && typeof entry.id === "string")
          : [];
        channelCatalog = Array.isArray(result.channelCatalog)
          ? result.channelCatalog.filter((entry) => typeof entry === "string")
          : [];
      }
      requestRender();
    }).catch((err) => {
      scanning = false;
      scanError = (err && err.message) || t("trellisScanFailed");
      requestRender();
    });
  }

  // ── section 3: preview (pure read — no spawn, no write) ───────────
  function onPreview() {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.trellisPreview !== "function") return;
    const paths = installedProjects().map((project) => project.path);
    const request = { paths };
    if (channelFilter) request.channel = channelFilter;
    previewVisible = true;
    settingsApi.trellisPreview(request).then((result) => {
      previewPlan = result && result.status === "ok" && Array.isArray(result.plan) ? result.plan : [];
      requestRender();
    }).catch(() => {
      previewPlan = [];
      requestRender();
    });
    requestRender();
  }

  function buildPreviewSection() {
    if (!previewVisible) return null;
    const rows = [];
    const head = buildRow(t("trellisPreviewTitle"), "");
    head.control.appendChild(helpers.buildButton({
      label: t("trellisClose"),
      size: "compact",
      onClick: () => { previewVisible = false; requestRender(); },
    }));
    rows.push(head.row);

    if (!previewPlan || previewPlan.length === 0) {
      rows.push(buildDescRow(t("trellisPreviewEmpty")));
    } else {
      for (const item of previewPlan) rows.push(buildPreviewRow(item));
    }
    return helpers.buildSection("", rows);
  }

  function buildPreviewRow(item) {
    const desc = [item.path, platformsText(item.platforms)].filter(Boolean).join(" · ");
    const { row, control } = buildRow(item.name || item.path, desc);
    const versions = document.createElement("span");
    versions.className = "trellis-version";
    versions.textContent = `${t("trellisColumnVersion")}: ${item.from || "—"} → ${item.to || "—"}`;
    control.appendChild(versions);
    if (item.command) control.appendChild(buildCommandBlock(item.command));
    return row;
  }

  // ── section 4: platform filter + add platform ─────────────────────
  function buildFilterSection() {
    const rows = [];
    const head = buildRow(t("trellisFilterTitle"), "");
    head.control.appendChild(helpers.buildButton({
      label: t("trellisFilterClear"),
      size: "compact",
      disabled: filterIds.size === 0,
      onClick: () => { filterIds = new Set(); requestRender(); },
    }));
    rows.push(head.row);

    const wrap = document.createElement("div");
    wrap.className = "row";
    const options = document.createElement("div");
    options.className = "trellis-platform-options";
    for (const choice of platformCatalog) {
      const option = document.createElement("label");
      option.className = "trellis-platform-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = filterIds.has(choice.id);
      input.addEventListener("change", () => {
        const next = new Set(filterIds);
        if (input.checked) next.add(choice.id);
        else next.delete(choice.id);
        filterIds = next;
        requestRender();
      });
      const text = document.createElement("span");
      text.textContent = choice.label;
      option.appendChild(input);
      option.appendChild(text);
      options.appendChild(option);
    }
    wrap.appendChild(options);
    rows.push(wrap);

    const addPanel = buildAddPlatformPanel();
    if (addPanel) rows.push(...addPanel);
    return helpers.buildSection("", rows);
  }

  // Opened from a project row. The platform id is the only thing the renderer
  // sends; the main process maps it to a flag and pins the `["-y"]` suffix.
  function buildAddPlatformPanel() {
    if (!addTarget) return null;
    const rows = [];
    const head = buildRow(tf("trellisAddPlatformTitle", { name: addTarget.name }), "");
    head.control.appendChild(helpers.buildButton({
      label: t("trellisClose"),
      size: "compact",
      onClick: () => { closeAddPlatform(); },
    }));
    rows.push(head.row);

    const target = projects().find((project) => project.path === addTarget.path);
    const configured = new Set(target && Array.isArray(target.platforms) ? target.platforms : []);
    const available = platformCatalog.filter((choice) => !configured.has(choice.id));

    if (available.length === 0) {
      rows.push(buildDescRow(t("trellisAddPlatformNone")));
      return rows;
    }

    const { row, control } = buildRow(t("trellisAddPlatformSelect"), "");
    const select = document.createElement("select");
    select.className = "trellis-platform-select";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "—";
    select.appendChild(placeholder);
    for (const choice of available) {
      const option = document.createElement("option");
      option.value = choice.id;
      option.textContent = choice.label;
      select.appendChild(option);
    }
    select.value = addPlatformId || "";
    select.addEventListener("change", () => {
      addPlatformId = select.value;
      addPlan = null;
      addFailed = false;
      requestRender();
    });
    control.appendChild(select);
    control.appendChild(helpers.buildButton({
      label: t("trellisPreview"),
      size: "compact",
      disabled: !addPlatformId,
      onClick: onPreviewAddPlatform,
    }));
    control.appendChild(helpers.buildButton({
      label: t("trellisAddPlatformAction"),
      tone: "accent",
      size: "compact",
      disabled: !addPlatformId || !addPlan || (addPlan.added || []).length === 0,
      onClick: onConfirmAddPlatform,
    }));
    rows.push(row);

    if (addFailed) rows.push(buildDescRow(t("trellisAddPlatformFailed")));
    if (addPlan) {
      rows.push(buildDescRow(tf("trellisAddPlatformRun", { command: commandText(addPlan.command) })));
      if (addPlan.command) {
        const commandRow = document.createElement("div");
        commandRow.className = "row";
        commandRow.appendChild(buildCommandBlock(addPlan.command));
        rows.push(commandRow);
      }
    }
    return rows;
  }

  function closeAddPlatform() {
    addTarget = null;
    addPlatformId = "";
    addPlan = null;
    addFailed = false;
    requestRender();
  }

  function onPreviewAddPlatform() {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.trellisPreview !== "function" || !addTarget || !addPlatformId) return;
    settingsApi.trellisPreview({ paths: [addTarget.path], platforms: [addPlatformId] }).then((result) => {
      if (!result || result.status !== "ok" || !Array.isArray(result.addPlan) || !result.addPlan[0]) {
        addPlan = null;
        addFailed = true;
      } else {
        addPlan = result.addPlan[0];
        addFailed = false;
      }
      requestRender();
    }).catch(() => {
      addPlan = null;
      addFailed = true;
      requestRender();
    });
  }

  function onConfirmAddPlatform() {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.trellisAddPlatform !== "function" || !addTarget || !addPlatformId) return;
    settingsApi.trellisAddPlatform(addTarget.path, [addPlatformId]).then((result) => {
      if (!result || result.status !== "ok") {
        addFailed = true;
        ops.showToast((result && result.message) || t("trellisAddPlatformFailed"), { error: true });
        requestRender();
        return;
      }
      ops.showToast(tf("trellisAddPlatformDone", { count: (result.added || []).length }));
      closeAddPlatform();
      runScan();
    }).catch(() => {
      addFailed = true;
      requestRender();
    });
  }

  // ── section 5: projects ───────────────────────────────────────────
  function buildProjectsSection() {
    const all = projects();
    const visible = visibleProjects();
    const rows = [];

    if (!scanResult) {
      rows.push(buildDescRow(t("trellisScanHint")));
    } else if (all.length === 0) {
      // "The folders could not be read" and "there are no subfolders" are
      // different problems and get different guidance.
      rows.push(buildDescRow(allRootsUnreadable() ? t("trellisNoProjectsUnreadable") : t("trellisNoProjects")));
    } else if (visible.length === 0) {
      rows.push(buildDescRow(t("trellisFilterEmpty")));
    } else {
      for (const project of visible) {
        rows.push(buildProjectRow(project));
        rows.push(...buildStaleFixRows(project));
      }
    }
    return helpers.buildSection(t("trellisProjectsTitle"), rows);
  }

  // A stale platform is already in the project's record, so the add-platform
  // picker filters it out and the repair command would otherwise be
  // unreachable. Show it here, read-only: the main process builds the command
  // and Clawd never runs it.
  function buildStaleFixRows(project) {
    const fixes = Array.isArray(project.staleFixes) ? project.staleFixes : [];
    return fixes
      .filter((fix) => fix && fix.command)
      .map((fix) => {
        const command = commandText(fix.command);
        const { row, control } = buildRow(tf("trellisStaleFix", { platform: fix.label }), command);
        control.appendChild(buildCopyButton(command));
        return row;
      });
  }

  function buildProjectRow(project) {
    const desc = [project.path, platformsText(project.platforms)].filter(Boolean).join(" · ");
    const { row, text, control } = buildRow(project.name || project.path, desc);

    if (project.staleRecord) {
      // Only the platforms that are actually missing on disk — listing every
      // recorded platform would wrongly accuse the ones that are present.
      const staleIds = Array.isArray(project.staleIds) ? project.staleIds : [];
      const staleText = tf("trellisStaleRecord", { platforms: platformsText(staleIds) });
      const warning = document.createElement("span");
      warning.className = "agent-badges";
      const badge = document.createElement("span");
      badge.className = "agent-badge custom-missing";
      badge.textContent = staleText;
      badge.title = staleText;
      warning.appendChild(badge);
      text.appendChild(warning);
    }

    const version = document.createElement("span");
    version.className = "trellis-version";
    version.textContent = versionTextFor(project);
    control.appendChild(version);

    const status = statusFor(project);
    const badge = document.createElement("span");
    badge.className = badgeClass(status.kind);
    badge.textContent = t(status.key);
    if (status.message) badge.title = status.message;
    control.appendChild(badge);

    let upgradeButton = null;
    if (project.installed === true) {
      upgradeButton = helpers.buildButton({
        label: t("trellisUpgrade"),
        tone: "accent",
        size: "compact",
        disabled: project.upgradable !== true,
        onClick: () => onUpgradeProject(project),
      });
      control.appendChild(upgradeButton);
      control.appendChild(helpers.buildButton({
        label: t("trellisAddPlatform"),
        size: "compact",
        onClick: () => {
          addTarget = { path: project.path, name: project.name || project.path };
          addPlatformId = "";
          addPlan = null;
          addFailed = false;
          requestRender();
        },
      }));
    }

    rowStatusNodes.set(project.path, { project, badge, version, upgradeButton });
    return row;
  }

  function syncRowStatus(path) {
    const entry = rowStatusNodes.get(path);
    if (!entry) return;
    const status = statusFor(entry.project);
    entry.badge.className = badgeClass(status.kind);
    entry.badge.textContent = t(status.key);
    if (status.message) entry.badge.title = status.message;
    else entry.badge.removeAttribute("title");
    entry.version.textContent = versionTextFor(entry.project);
    if (entry.upgradeButton) {
      helpers.setButtonState(entry.upgradeButton, { disabled: entry.project.upgradable !== true });
    }
  }

  function onUpgradeProject(project) {
    helpers.showSettingsConfirmModal({
      title: t("trellisUpgradeConfirmTitle"),
      detail: tf("trellisUpgradeConfirmDetail", { path: project.path }),
      actions: [
        { id: "cancel", label: t("trellisCancel"), tone: "neutral", defaultFocus: true },
        { id: "confirm", label: t("trellisUpgradeConfirmAction"), tone: "accent" },
      ],
    }).then((actionId) => {
      if (actionId !== "confirm") return null;
      const settingsApi = api();
      if (!settingsApi || typeof settingsApi.trellisUpgradeProject !== "function") return null;
      progressByPath.set(project.path, { phase: "running" });
      syncRowStatus(project.path);
      return settingsApi.trellisUpgradeProject(project.path).then((result) => {
        if (result && result.status === "ok") {
          progressByPath.set(project.path, { phase: "ok", from: result.from, to: result.to });
          ops.showToast(tf("trellisUpgradeDone", { from: result.from || "—", to: result.to || "—" }));
          runScan();
          return;
        }
        progressByPath.set(project.path, {
          phase: "failed",
          message: (result && result.message) || "",
        });
        syncRowStatus(project.path);
      }).catch(() => {
        progressByPath.set(project.path, { phase: "failed", message: "" });
        syncRowStatus(project.path);
      });
    }).catch(() => {});
  }

  function onUpgradeAll() {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.trellisUpgradeAll !== "function") return;
    const paths = upgradablePaths();
    if (paths.length === 0) return;
    progressByPath = new Map();
    // Set before the await: the main process starts emitting `queued` in the
    // same tick, so a batch that finishes before the reply would otherwise
    // leave the cancel button enabled forever.
    batchRunning = true;
    requestRender();
    settingsApi.trellisUpgradeAll(paths).then((result) => {
      if (!result || result.status !== "ok") {
        batchRunning = false;
        requestRender();
        ops.showToast((result && result.message) || t("trellisScanFailed"), { error: true });
      }
    }).catch(() => {
      batchRunning = false;
      requestRender();
    });
  }

  function onCancelBatch() {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.trellisCancelBatch !== "function") return;
    settingsApi.trellisCancelBatch().then(() => {
      batchRunning = false;
      requestRender();
    }).catch(() => {});
  }

  function handleProgress(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.phase === "done") {
      const summary = payload.summary || {};
      batchRunning = false;
      if (summary.total) {
        ops.showToast(tf("trellisBatchSummary", { ok: summary.ok || 0, failed: summary.failed || 0 }));
      }
      progressByPath = new Map();
      runScan();
      return;
    }
    if (!payload.path) return;
    progressByPath.set(payload.path, payload);
    syncRowStatus(payload.path);
  }

  function ensureProgressSubscription() {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.onTrellisProgress !== "function") return;
    if (unsubscribeProgress) return;
    const unsubscribe = settingsApi.onTrellisProgress(handleProgress);
    unsubscribeProgress = unsubscribe;
    helpers.registerMountedDisposable({
      dispose() {
        if (unsubscribeProgress === unsubscribe) unsubscribeProgress = null;
        try { unsubscribe(); } catch {}
      },
    });
  }

  // ── section 6: global CLI ─────────────────────────────────────────
  function buildGlobalSection() {
    const rows = [];
    const global = scanResult && scanResult.global;
    const { row, control } = buildRow(t("trellisGlobalTitle"), "");
    rows.push(row);

    if (!scanResult) {
      rows.push(buildDescRow(t("trellisScanHint")));
      return helpers.buildSection("", rows);
    }

    if (!global || global.installed !== true) {
      rows.push(buildDescRow(t("trellisGlobalNotInstalled")));
      const guide = buildRow(tf("trellisGlobalInstallGuide", { command: GLOBAL_INSTALL_COMMAND }), "");
      guide.control.appendChild(buildCopyButton(GLOBAL_INSTALL_COMMAND));
      rows.push(guide.row);
      return helpers.buildSection("", rows);
    }

    const version = document.createElement("span");
    version.className = "trellis-version";
    version.textContent = tf("trellisGlobalCurrent", { version: global.version || "—" });
    control.appendChild(version);
    control.appendChild(helpers.buildButton({
      label: t("trellisGlobalUpgrade"),
      tone: "accent",
      size: "compact",
      onClick: onUpgradeGlobal,
    }));
    return helpers.buildSection("", rows);
  }

  function onUpgradeGlobal() {
    const settingsApi = api();
    if (!settingsApi || typeof settingsApi.trellisUpgradeGlobal !== "function") return;
    settingsApi.trellisUpgradeGlobal().then((result) => {
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("trellisScanFailed"), { error: true });
        return;
      }
      ops.showToast(tf("trellisGlobalUpgraded", { from: result.from || "—", to: result.to || "—" }));
      runScan();
    }).catch(() => {});
  }

  // ── render ────────────────────────────────────────────────────────
  function render(parent) {
    rowStatusNodes = new Map();

    const h1 = document.createElement("h1");
    h1.textContent = t("trellisTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("trellisSubtitle");
    parent.appendChild(subtitle);

    parent.appendChild(buildRootsSection());
    parent.appendChild(buildToolbarSection());

    const previewSection = buildPreviewSection();
    if (previewSection) parent.appendChild(previewSection);

    parent.appendChild(buildFilterSection());
    parent.appendChild(buildProjectsSection());
    parent.appendChild(buildGlobalSection());

    ensureProgressSubscription();
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.trellis = { render };
  }

  root.ClawdSettingsTabTrellis = { init };
})(globalThis);
