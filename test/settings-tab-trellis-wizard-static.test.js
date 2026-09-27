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

  it('shows the developer-name field only for a first install (09-27)', () => {
    assert.ok(/function isFirstInstall\(/.test(wizardSrc), 'first-install gate exists');
    assert.ok(/state\.project\.installed === false/.test(wizardSrc), 'strict installed===false check');
    assert.ok(/isFirstInstall\(\) \? userFieldHtml\(bridge\) : ""/.test(wizardSrc),
      'field HTML is rendered only behind the gate');
    assert.ok(/data-user/.test(wizardSrc), 'input carries data-user');
    // 128 UTF-16 code units is the widest a 64-code-point name can be; the
    // wizard then applies the real code-point cap in captureUserName (M2).
    assert.ok(/maxlength="128"/.test(wizardSrc), 'input caps the raw paste at the code-point ceiling');
    assert.ok(/USER_NAME_MAX_CODE_POINTS/.test(wizardSrc), 'wizard applies the code-point cap itself');
    assert.ok(/api\.trellisUserSuggestion\(\)/.test(wizardSrc), 'default probe goes through the bridge api');
  });

  it('threads the developer name through preview, back and install (09-27)', () => {
    // 09-27: `-u` is scoped to a first install. Adding a platform must not send
    // a userName at all, so the previewed/executed command carries no `-u`.
    assert.ok(/if \(isFirstInstall\(\)\) payload\.userName = state\.userName;/.test(wizardSrc),
      'preview payload carries userName only on a first install');
    assert.ok(/isFirstInstall\(\) \? state\.userName : undefined/.test(wizardSrc),
      'install forwards userName only on a first install');
    assert.ok(/input\.value = state\.userName/.test(wizardSrc), 'a re-render re-applies the stored value');
    assert.ok(/function captureUserName\(/.test(wizardSrc), 'value is read back before stage changes');
    // M5: the stored value is trimmed (and code-point capped) so the name
    // re-applied on `back` equals the one in the previewed command.
    assert.ok(/input\.value\.trim\(\)/.test(wizardSrc), 'capture trims the typed value');
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
