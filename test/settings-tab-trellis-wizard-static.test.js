'use strict';

const test = require('node:test');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const wizardSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings-tab-trellis-wizard.js'), 'utf8');
const tabSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings-tab-trellis.js'), 'utf8');

describe('settings trellis wizard static guards (09-25)', () => {
  it('escapes every interpolated value before innerHTML', () => {
    // Pragmatic XSS guard: every innerHTML assignment must route dynamic
    // values through escapeHtml()/trusted builders. We assert (a) the file
    // has at least one escapeHtml call per innerHTML assignment, and (b) no
    // innerHTML statement contains a BARE dynamic reference (state./project./
    // output/message/plan/picked/added without a wrapper call on the same
    // statement line).
    const stmts = wizardSrc.match(/innerHTML[^;]*;/g) || [];
    assert.ok(stmts.length > 0, 'wizard renders via innerHTML — expected');
    const escapes = (wizardSrc.match(/escapeHtml\(/g) || []).length;
    assert.ok(escapes >= stmts.length,
      `escapeHtml calls (${escapes}) should cover innerHTML assignments (${stmts.length})`);
    for (const stmt of stmts) {
      const bare = stmt.match(/\+\s*(?:state\.|project\.|output|msg|picked|added)\b/g) || [];
      assert.deepEqual(bare, [],
        `bare dynamic value concatenated into innerHTML: ${bare.join(', ').slice(0, 100)}`);
    }
  });

  it('never uses vm-sandbox-missing DOM methods', () => {
    assert.ok(!/\.insertBefore\(/.test(wizardSrc), 'insertBefore banned (vm sandbox parity)');
    assert.ok(!/\.prepend\(/.test(wizardSrc), 'prepend banned');
    // top-level setTimeout: only allowed inside functions with typeof guards
    const bare = wizardSrc.match(/^[^*\n]*\bsetTimeout\(/gm) || [];
    for (const hit of bare) {
      assert.ok(/typeof|function/.test(hit), `bare setTimeout at top level: ${hit.trim().slice(0, 60)}`);
    }
  });

  it('reaches IPC only through the bridge api (window.settingsAPI)', () => {
    assert.ok(!/require\(['"]electron/.test(wizardSrc), 'no electron import in renderer file');
    assert.ok(!/ipcRenderer/.test(wizardSrc), 'no raw ipcRenderer — must go via bridge.api');
    assert.ok(/api\.trellisPreview/.test(wizardSrc), 'preview goes through api.trellisPreview');
    assert.ok(/api\.trellisAddPlatform/.test(wizardSrc), 'install goes through api.trellisAddPlatform');
    assert.ok(/api\.trellisUpgradeProject/.test(wizardSrc), 'upgrade goes through api.trellisUpgradeProject');
  });

  it('close() removes keydown listener and DOM root', () => {
    assert.ok(/removeEventListener\("keydown"/.test(wizardSrc), 'keydown listener removed in close()');
    assert.ok(/removeChild\(rootEl\)|rootEl\.remove\(\)/.test(wizardSrc), 'root element detached');
  });

  it('preview command output is display-only (never executed)', () => {
    // The command from the preview plan must only be rendered escaped.
    assert.ok(/commandBlock\(bridge/.test(wizardSrc), 'command rendered via commandBlock');
    const cb = wizardSrc.match(/function commandBlock[\s\S]{0,400}/)[0];
    assert.ok(/escapeHtml\(text\)/.test(cb), 'command text escaped before <code>');
  });

  it('tab wires the wizard and dropped the inline add-platform panel', () => {
    assert.ok(/ClawdTrellisWizard\.openAddPlatform/.test(tabSrc), 'tab opens add wizard');
    assert.ok(/ClawdTrellisWizard\.openUpgradePreview/.test(tabSrc), 'tab opens upgrade wizard');
    assert.ok(!/buildAddPlatformPanel/.test(tabSrc), 'inline add panel fully removed');
    assert.ok(/trellisUpgradePreview/.test(tabSrc), 'upgrade button uses the preview label');
  });

  it('settings.html loads the wizard script after the tab script', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings.html'), 'utf8');
    const tabAt = html.indexOf('settings-tab-trellis.js');
    const wizAt = html.indexOf('settings-tab-trellis-wizard.js');
    assert.ok(tabAt >= 0 && wizAt > tabAt, 'wizard script loaded after tab script');
  });
});
