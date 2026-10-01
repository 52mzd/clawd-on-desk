'use strict';

// Behaviour tests for the Trellis install wizard (09-27): the developer-name
// field only exists on a first install, its `git config user.name` default is
// filled asynchronously, and the typed value survives preview → back and
// reaches `trellisAddPlatform`.
//
// The wizard renders through `innerHTML`, so this harness provides a minimal
// DOM whose `innerHTML` setter parses the two element kinds the wizard queries
// (`[data-user]` / `[data-platform]` inputs and `[data-wizard]` buttons). It is
// deliberately narrow: it can catch "field missing", "gate missing", "value
// lost on back" and "userName not forwarded", not CSS or layout.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WIZARD_SOURCE = path.join(__dirname, '..', 'src', 'settings-tab-trellis-wizard.js');

function parseTagAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1]] = m[2];
  // Valueless attributes we query on.
  if (/\sdata-user[\s>/]/.test(tag)) attrs['data-user'] = '';
  if (/\sdata-user"/.test(tag)) attrs['data-user'] = '';
  return attrs;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.children = [];
    this.eventListeners = {};
    this.attributes = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.parentNode = null;
    this.className = '';
    this._html = '';
    this._inputs = [];
    this._buttons = [];
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, listener) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    const list = this.eventListeners[type] || [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type) {
    const event = { type, target: this, preventDefault() {} };
    for (const listener of [...(this.eventListeners[type] || [])]) listener(event);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] === undefined ? null : this.attributes[name];
  }

  set innerHTML(html) {
    this._html = String(html);
    this._inputs = [];
    this._buttons = [];
    let m;
    const inputRe = /<input\b[^>]*>/g;
    while ((m = inputRe.exec(this._html))) {
      const el = new FakeElement('input');
      el.attributes = parseTagAttrs(m[0]);
      el.type = el.attributes.type || 'text';
      this._inputs.push(el);
    }
    const buttonRe = /<button\b([^>]*)>/g;
    while ((m = buttonRe.exec(this._html))) {
      const el = new FakeElement('button');
      el.attributes = parseTagAttrs(`<button${m[1]}>`);
      this._buttons.push(el);
    }
  }

  get innerHTML() {
    return this._html;
  }

  querySelector(selector) {
    return this._match(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return this._match(selector);
  }

  _match(selector) {
    if (selector === '[data-user]') return this._inputs.filter((el) => 'data-user' in el.attributes);
    if (selector === '[data-platform]') return this._inputs.filter((el) => 'data-platform' in el.attributes);
    if (selector === '[data-wizard]') return this._buttons.filter((el) => 'data-wizard' in el.attributes);
    return [];
  }
}

function loadWizard() {
  const document = {
    body: new FakeElement('body'),
    createElement: (tag) => new FakeElement(tag),
    addEventListener() {},
    removeEventListener() {},
  };
  const context = { document, console, Promise, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(WIZARD_SOURCE, 'utf8'), context, { filename: 'settings-tab-trellis-wizard.js' });
  return { wizard: context.ClawdTrellisWizard, document };
}

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeBridge(api) {
  return {
    t: (key) => key,
    api,
    onFinished() {},
  };
}

function makeApi(overrides = {}) {
  const calls = { suggestion: 0, preview: [], add: [] };
  const api = {
    calls,
    trellisUserSuggestion() {
      calls.suggestion += 1;
      return Promise.resolve({ status: 'ok', name: 'git-user' });
    },
    trellisPreview(payload) {
      calls.preview.push(payload);
      return Promise.resolve({
        status: 'ok',
        plan: [],
        addPlan: [{
          name: 'alpha',
          added: Array.isArray(payload.platforms) ? payload.platforms : [],
          command: {
            bin: 'trellis',
            args: ['init', '-u', payload.userName || 'alpha', '--gemini', '-y'],
            cwd: '/tmp/alpha',
          },
        }],
      });
    },
    trellisAddPlatform(projectPath, added, userName) {
      calls.add.push({ projectPath, added, userName });
      return Promise.resolve({ status: 'ok', added, output: 'install output' });
    },
    ...overrides,
  };
  return api;
}

const CATALOG = [{ id: 'gemini', label: 'Gemini CLI' }];

function openWizard({ installed = false, api = makeApi() } = {}) {
  const { wizard, document } = loadWizard();
  const bridge = makeBridge(api);
  wizard.openAddPlatform(bridge, { path: '/tmp/alpha', name: 'alpha', installed, platforms: [] }, CATALOG, '');
  const root = document.body.children[0];
  assert.ok(root, 'the wizard mounted a root element');
  return { wizard, document, root, api, bridge };
}

function button(root, kind) {
  const found = root.querySelectorAll('[data-wizard]').find((el) => el.getAttribute('data-wizard') === kind);
  assert.ok(found, `expected a ${kind} button`);
  return found;
}

describe('trellis wizard developer name (09-27)', () => {
  it('renders the field only for a first install', async () => {
    const first = openWizard({ installed: false });
    assert.ok(first.root.querySelector('[data-user]'), 'first install shows the developer-name field');
    assert.strictEqual(first.root.querySelector('[data-user]').value, '', 'empty until the probe resolves');

    await flush();
    assert.strictEqual(first.root.querySelector('[data-user]').value, 'git-user', 'git default filled in');
    assert.strictEqual(first.api.calls.suggestion, 1, 'probe asked once');

    const alreadyInstalled = openWizard({ installed: true });
    await flush();
    assert.strictEqual(alreadyInstalled.root.querySelector('[data-user]'), null, 'adding a platform hides the field');
    assert.strictEqual(alreadyInstalled.api.calls.suggestion, 0, 'no probe for an installed project');
  });

  it('sends no developer name at all when adding a platform (09-27)', async () => {
    const { root, api } = openWizard({ installed: true });
    await flush();
    root.querySelectorAll('[data-platform]').forEach((input) => { input.checked = true; });

    button(root, 'preview').dispatch('click');
    await flush();
    // `installed: true` == add-platform: the payload must not even carry the
    // key, so the IPC layer cannot fall back to the folder name.
    assert.strictEqual('userName' in api.calls.preview[0], false, 'add-platform preview carries no userName');

    button(root, 'install').dispatch('click');
    await flush();
    assert.strictEqual(api.calls.add.length, 1);
    assert.strictEqual(api.calls.add[0].userName, undefined, 'add-platform install forwards no userName');
  });

  it('keeps the typed name across preview and back, and forwards it on install', async () => {
    const { root, api } = openWizard({ installed: false });
    await flush();

    const field = root.querySelector('[data-user]');
    field.value = 'alice';
    root.querySelectorAll('[data-platform]').forEach((input) => { input.checked = true; });

    button(root, 'preview').dispatch('click');
    await flush();
    assert.deepStrictEqual(api.calls.preview.length, 1, 'preview asked once');
    assert.strictEqual(api.calls.preview[0].userName, 'alice', 'preview carries the typed name');
    assert.strictEqual(api.calls.preview[0].platforms[0], 'gemini');

    button(root, 'back').dispatch('click');
    await flush();
    assert.strictEqual(root.querySelector('[data-user]').value, 'alice', 'back re-applies the value');
    assert.strictEqual(api.calls.suggestion, 1, 'a stored value does not re-probe');

    root.querySelectorAll('[data-platform]').forEach((input) => { input.checked = true; });
    button(root, 'preview').dispatch('click');
    await flush();
    button(root, 'install').dispatch('click');
    await flush();
    assert.strictEqual(api.calls.add.length, 1);
    assert.strictEqual(api.calls.add[0].projectPath, '/tmp/alpha');
    assert.strictEqual(api.calls.add[0].userName, 'alice');
    assert.deepStrictEqual(Array.from(api.calls.add[0].added), ['gemini']);
  });

  it('installs with a blank name instead of blocking (the cli falls back to the folder name)', async () => {
    const { root, api } = openWizard({ installed: false });
    await flush();
    root.querySelector('[data-user]').value = '';
    root.querySelectorAll('[data-platform]').forEach((input) => { input.checked = true; });

    button(root, 'preview').dispatch('click');
    await flush();
    button(root, 'install').dispatch('click');
    await flush();
    assert.strictEqual(api.calls.add.length, 1);
    assert.strictEqual(api.calls.add[0].userName, '', 'a blank name is forwarded, never swallowed');
    assert.deepStrictEqual(Array.from(api.calls.add[0].added), ['gemini']);
  });

  it('trims and code-point-caps the typed name before preview (M5/M2)', async () => {
    const { root, api } = openWizard({ installed: false });
    await flush();
    root.querySelector('[data-user]').value = '  alice  ';
    root.querySelectorAll('[data-platform]').forEach((input) => { input.checked = true; });

    button(root, 'preview').dispatch('click');
    await flush();
    assert.strictEqual(api.calls.preview[0].userName, 'alice', 'preview gets the trimmed name');

    button(root, 'back').dispatch('click');
    await flush();
    assert.strictEqual(root.querySelector('[data-user]').value, 'alice', 'back re-applies the trimmed value');

    // An astral paste must be capped by code point, never cut in half: a lone
    // surrogate would reach argv as U+FFFD.
    const emoji = '\u{1F388}'.repeat(80);
    root.querySelector('[data-user]').value = emoji;
    root.querySelectorAll('[data-platform]').forEach((input) => { input.checked = true; });
    button(root, 'preview').dispatch('click');
    await flush();
    const sent = api.calls.preview[api.calls.preview.length - 1].userName;
    assert.strictEqual(sent, '\u{1F388}'.repeat(64), '64 code points, no dangling half');
  });

  it('survives a failing suggestion probe', async () => {
    const api = makeApi({
      trellisUserSuggestion() {
        api.calls.suggestion += 1;
        return Promise.reject(new Error('git exploded'));
      },
    });
    const { root } = openWizard({ installed: false, api });
    await flush();
    assert.strictEqual(root.querySelector('[data-user]').value, '', 'no default, no throw');
    assert.strictEqual(root.querySelector('[data-user]').attributes.placeholder !== undefined, true);
  });
});
