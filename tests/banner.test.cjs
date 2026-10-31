const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const coreSource = fs.readFileSync(path.resolve(__dirname, '../content/core.js'), 'utf8');

// Model the DOM operations and command-event bubbling used by XUL buttons.
// No browser, Zotero process, or user files are needed by these tests.
class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.events = new Map();
    this.style = {};
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentNode = this;
      this.children.push(child);
    }
  }
  prepend(child) {
    child.remove();
    child.parentNode = this;
    this.children.unshift(child);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    if (!this.events.has(type)) this.events.set(type, []);
    this.events.get(type).push(fn);
  }
  command() {
    const ancestors = [];
    for (let node = this; node; node = node.parentNode) ancestors.push(node);
    const event = {
      type: 'command', target: this, propagationStopped: false,
      stopPropagation() { this.propagationStopped = true; }
    };
    for (const node of ancestors) {
      for (const fn of node.events.get('command') || []) fn(event);
      if (event.propagationStopped) break;
    }
    return event;
  }
}

function makeWindow() {
  const root = new Element('vbox');
  root.id = 'zotero-pane';
  function find(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const result = find(child, id);
      if (result) return result;
    }
    return null;
  }
  return { document: {
    createXULElement: tagName => new Element(tagName),
    getElementById: id => find(root, id)
  }};
}

function harness({ prefs = new Map(), windows = 1 } = {}) {
  const mainWindows = Array.from({ length: windows }, makeWindow);
  const errors = [];
  let opens = 0;
  const context = vm.createContext({ Zotero: {
    getMainWindows: () => mainWindows,
    Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
    logError: error => errors.push(error)
  }});
  vm.runInContext(coreSource, context);
  const api = context.DraftPDFWatch;
  api.open = () => { opens++; };
  api.loadBannerDismissals();
  const node = (id, index = 0) => mainWindows[index].document.getElementById(id);
  return {
    api, prefs, errors, mainWindows, node,
    get opens() { return opens; },
    banner: (index = 0) => node('draftwatch-banner', index),
    close: (index = 0) => node('draftwatch-banner-close', index).command()
  };
}

function pending(id = 'paper-a', version = '2') {
  return { id, enabled: true, status: 'pending', parentKey: 'PARENT',
    attachmentKey: 'ATTACHMENT', pending: { path: `/drafts/paper_v${version}.pdf`, hash: `hash-${version}` } };
}
function failed(id = 'paper-a', reason = 'Attachment no longer exists') {
  return { id, enabled: true, status: 'error', error: reason, errorCode: 'attachment-missing' };
}

test('notification includes a visible, accessible close button and a working details button', () => {
  const h = harness();
  h.api.state.bindings = [pending(), failed('paper-b')];
  h.api.emit();
  const close = h.node('draftwatch-banner-close');
  assert.ok(h.banner());
  assert.ok(close, 'close button is attached to the document');
  assert.equal(close.tagName, 'button');
  assert.equal(close.label, '×');
  assert.equal(close.getAttribute('aria-label'), '关闭此提醒');
  assert.match(close.getAttribute('tooltiptext'), /监控继续/);
  assert.notEqual(close.getAttribute('hidden'), 'true');
  assert.match(h.node('draftwatch-banner-open').label, /1 个新版待更新，1 个规则需处理/);
  h.node('draftwatch-banner-open').command();
  assert.equal(h.opens, 1);
  assert.ok(h.banner(), 'opening details does not dismiss the alert');
});

test('close stops bubbling, leaves monitoring state intact, and bypasses failed recovery', () => {
  const h = harness();
  h.api.state.bindings = [pending(), failed('paper-b')];
  h.api.state.journal = { bindingID: 'paper-b', phase: 'recovery-required' };
  h.api.serial = () => { throw new Error('Dismissal must not enter the transaction queue'); };
  h.api.recover = () => { throw new Error('Dismissal must not recover attachments'); };
  const before = JSON.stringify(h.api.state);
  let bubbled = 0;
  h.api.emit();
  h.node('zotero-pane').addEventListener('command', () => { bubbled++; });
  const event = h.close();
  assert.equal(event.propagationStopped, true);
  assert.equal(bubbled, 0);
  assert.equal(h.opens, 0);
  assert.equal(h.banner(), null);
  assert.equal(JSON.stringify(h.api.state), before);
  assert.equal(h.api.stopped, false);
  assert.equal(h.errors.length, 0);
});

test('unchanged pending and error alerts stay dismissed on subsequent checks', () => {
  const h = harness();
  h.api.state.bindings = [pending(), failed('paper-b')];
  h.api.emit();
  h.close();
  for (let i = 0; i < 3; i++) {
    h.api.emit();
    assert.equal(h.banner(), null);
  }
});

test('a new PDF hash or path appears again without restoring other dismissed alerts', () => {
  const h = harness();
  const paper = pending();
  h.api.state.bindings = [paper, failed('paper-b')];
  h.api.emit();
  h.close();
  paper.pending.hash = 'new-content-same-file';
  h.api.emit();
  assert.ok(h.banner());
  assert.match(h.node('draftwatch-banner-open').label, /1 个新版待更新，0 个规则需处理/);
  h.close();
  paper.pending.path = '/drafts/paper_v3.pdf';
  h.api.emit();
  assert.ok(h.banner(), 'a new file path is a new alert even if its content hash matches');
});

test('a changed error reason or error code appears again', () => {
  const h = harness();
  const paper = failed();
  h.api.state.bindings = [paper];
  h.api.emit();
  h.close();
  paper.error = 'Source folder cannot be read';
  h.api.emit();
  assert.ok(h.banner());
  h.close();
  paper.errorCode = 'source-unreadable';
  h.api.emit();
  assert.ok(h.banner());
});

test('a different binding triggers an alert even when the aggregate counts do not change', () => {
  const h = harness();
  h.api.state.bindings = [failed('paper-a')];
  h.api.emit();
  h.close();
  h.api.state.bindings = [failed('paper-b')];
  h.api.emit();
  assert.ok(h.banner());
  assert.match(h.node('draftwatch-banner-open').label, /0 个新版待更新，1 个规则需处理/);
});

test('the same error can notify again after its previous occurrence was resolved', () => {
  const h = harness();
  const paper = failed();
  const reason = paper.error;
  h.api.state.bindings = [paper];
  h.api.emit();
  h.close();
  paper.error = null;
  paper.status = 'ready';
  h.api.emit();
  assert.equal(h.banner(), null);
  paper.error = reason;
  paper.status = 'error';
  h.api.emit();
  assert.ok(h.banner());
});

test('closing in one window dismisses the same alerts in all main windows', () => {
  const h = harness({ windows: 2 });
  h.api.state.bindings = [pending()];
  h.api.emit();
  assert.ok(h.banner(0));
  assert.ok(h.banner(1));
  h.close(1);
  assert.equal(h.banner(0), null);
  assert.equal(h.banner(1), null);
  h.api.emit();
  assert.equal(h.banner(0), null);
  assert.equal(h.banner(1), null);
  assert.equal(h.opens, 0);
});

test('dismissals survive a fresh plugin instance and its initial PDF stability check', () => {
  const prefs = new Map();
  const first = harness({ prefs });
  first.api.state.bindings = [pending(), failed('paper-b')];
  first.api.emit();
  first.close();
  assert.ok(prefs.size, 'dismissal is persisted outside the attachment transaction');

  const restarted = harness({ prefs });
  restarted.api.state.bindings = [
    { ...pending(), pending: null, status: 'stabilizing' }, failed('paper-b')
  ];
  restarted.api.emit();
  assert.equal(restarted.banner(), null);
  restarted.api.state.bindings[0] = pending();
  restarted.api.emit();
  assert.equal(restarted.banner(), null, 'unchanged PDF does not flash again after stabilization');
  restarted.api.state.bindings[0] = pending('paper-a', '3');
  restarted.api.emit();
  assert.ok(restarted.banner());
});

test('resolution removes the persisted dismissal, including after a restart', () => {
  const prefs = new Map();
  const first = harness({ prefs });
  first.api.state.bindings = [failed()];
  first.api.emit();
  first.close();
  first.api.state.bindings = [{ id: 'paper-a', enabled: true, status: 'ready' }];
  first.api.emit();
  const restarted = harness({ prefs });
  restarted.api.state.bindings = [failed()];
  restarted.api.emit();
  assert.ok(restarted.banner());
});

test('listeners still receive state changes while the banner is dismissed', () => {
  const h = harness();
  h.api.state.bindings = [pending()];
  let updates = 0;
  const unsubscribe = h.api.subscribe(() => { updates++; });
  h.api.emit();
  h.close();
  h.api.emit();
  assert.equal(updates, 3);
  assert.equal(h.banner(), null);
  unsubscribe();
  h.api.emit();
  assert.equal(updates, 3);
});

test('a legacy banner and a banner missing its close button are rebuilt with working controls', () => {
  const h = harness();
  h.api.state.bindings = [pending()];
  const legacy = new Element('button');
  legacy.id = 'draftwatch-banner';
  h.node('zotero-pane').prepend(legacy);
  h.api.emit();
  assert.notEqual(h.banner(), legacy);
  assert.ok(h.node('draftwatch-banner-close'));
  h.node('draftwatch-banner-close').remove();
  h.api.emit();
  assert.ok(h.node('draftwatch-banner-close'));
  h.close();
  assert.equal(h.banner(), null);
  assert.equal(h.opens, 0);
});
