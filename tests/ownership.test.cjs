const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const coreSource = fs.readFileSync(path.resolve(__dirname, '../content/core.js'), 'utf8');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Separate script scopes share the Zotero singleton, as two plugin runtimes
// would. All files, menus, timers and windows below are synthetic.
function host() {
  const metrics = { writes: [], timers: [], registered: [], unregistered: [],
    activeMenus: new Set(), notices: [], dialogs: [], windowReads: 0,
    bannerRemovals: 0, errors: [] };
  const prefs = new Map();
  const Zotero = {
    Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
    logError: error => metrics.errors.push(error), debug: () => {},
    MenuManager: {
      registerMenu: menu => {
        metrics.registered.push(menu.menuID);
        metrics.activeMenus.add(menu.menuID);
        return menu.menuID;
      },
      unregisterMenu: id => { metrics.unregistered.push(id); metrics.activeMenus.delete(id); },
    },
    getMainWindows: () => {
      metrics.windowReads++;
      return [{ document: { getElementById: id => id === 'draftwatch-banner'
        ? { remove: () => { metrics.bannerRemovals++; } } : null } }];
    },
    getMainWindow: () => ({ openDialog: (...args) => {
      metrics.dialogs.push(args);
      return { closed: false, close() { this.closed = true; } };
    } }),
  };
  function runtime(name, { blockAt = null } = {}) {
    const entered = deferred(), release = deferred();
    const io = { exists: 0, reads: 0 };
    const wait = async stage => {
      if (blockAt === stage) { entered.resolve(); await release.promise; }
    };
    const context = vm.createContext({ Zotero,
      Services: { dirsvc: { get: () => ({ path: 'C:\\synthetic-profile' }) } },
      PathUtils: { join: path.win32.join },
      IOUtils: {
        exists: async () => { io.exists++; await wait('exists'); return blockAt === 'readJSON'; },
        readJSON: async () => { io.reads++; await wait('readJSON'); return { schema: 1, bindings: [], journal: null }; },
        writeJSON: async (_file, value) => metrics.writes.push({ name, state: JSON.parse(JSON.stringify(value)) }),
      },
      Cc: {
        '@mozilla.org/timer;1': { createInstance: () => {
          const timer = { callback: null, cancelled: false, starts: 0,
            initWithCallback(callback) { this.callback = callback; this.starts++; },
            cancel() { this.cancelled = true; } };
          metrics.timers.push(timer);
          return timer;
        } },
        '@mozilla.org/alerts-service;1': { getService: () => ({
          showAlertNotification: (_icon, title, message) => metrics.notices.push({ title, message }),
        }) },
      },
      Ci: { nsIFile: {}, nsITimer: { TYPE_REPEATING_SLACK: 1 } },
    });
    vm.runInContext(coreSource, context, { filename: 'core.js' });
    const api = context.DraftPDFWatch;
    api.enforceOwnership = true;
    api.statePath = 'C:\\synthetic-profile\\draft-pdf-watch.json';
    if (blockAt === 'recover') api.recover = async () => { await wait('recover'); };
    return { api, io, entered: entered.promise, release: release.resolve };
  }
  return { Zotero, metrics, runtime, own: runtime => { Zotero.DraftPDFWatch = runtime.api; } };
}

test('a stale scope cannot write state, run queued mutations, repaint, notify or open a manager', async () => {
  const h = host(), old = h.runtime('old'), fresh = h.runtime('new');
  h.own(old);
  await old.api.persist();
  h.own(fresh);
  let ran = false, listenerCalls = 0;
  old.api.subscribe(() => { listenerCalls++; });
  await assert.rejects(old.api.serial(() => { ran = true; }), /实例已停止/);
  await assert.rejects(old.api.persist(), /停止写入/);
  old.api.emit();
  old.api.notify({ id: 'rule-a', title: 'A manuscript' }, 'obsolete message');
  assert.throws(() => old.api.open(), /实例已停止/);
  assert.equal(ran, false);
  assert.equal(listenerCalls, 0);
  assert.equal(h.metrics.windowReads, 0);
  assert.equal(h.metrics.bannerRemovals, 0);
  assert.equal(h.metrics.notices.length, 0);
  assert.equal(h.metrics.dialogs.length, 0);
  assert.equal(old.api.notices.size, 0);
  await fresh.api.persist();
  assert.deepEqual(h.metrics.writes.map(write => write.name), ['old', 'new']);
});

test('an old shutdown cannot remove menus or a banner now owned by the new scope', async () => {
  const h = host(), old = h.runtime('old'), fresh = h.runtime('new');
  h.own(old);
  await old.api.init('draft-watch@test', 'old');
  h.own(fresh);
  await fresh.api.init('draft-watch@test', 'new');
  const activeMenus = [...h.metrics.activeMenus];
  const removals = h.metrics.bannerRemovals;
  await old.api.shutdown();
  assert.deepEqual([...h.metrics.activeMenus], activeMenus);
  assert.equal(h.metrics.unregistered.length, 0);
  assert.equal(h.metrics.bannerRemovals, removals);
  assert.equal(h.metrics.timers[0].cancelled, true);
  assert.equal(h.metrics.timers[1].cancelled, false);
});

test('duplicate init calls return the same promise and create just one timer and menu pair', async () => {
  const h = host(), runtime = h.runtime('one', { blockAt: 'exists' });
  h.own(runtime);
  const first = runtime.api.init('draft-watch@test', 'one');
  const second = runtime.api.init('draft-watch@test', 'one');
  assert.equal(first, second);
  await runtime.entered;
  runtime.release();
  await first;
  assert.equal(runtime.api.init('draft-watch@test', 'one'), first);
  assert.equal(h.metrics.timers.length, 1);
  assert.equal(h.metrics.timers[0].starts, 1);
  assert.equal(h.metrics.registered.length, 2);
  assert.equal(runtime.io.exists, 1);
  assert.equal(h.metrics.writes.length, 1);
});

for (const stage of ['exists', 'readJSON', 'recover']) {
  test(`shutdown while initialization awaits ${stage} cannot create a late timer`, async () => {
    const h = host(), runtime = h.runtime('one', { blockAt: stage });
    h.own(runtime);
    const initializing = runtime.api.init('draft-watch@test', 'one');
    await runtime.entered;
    let shutdownFinished = false;
    const stopping = runtime.api.shutdown().then(() => { shutdownFinished = true; });
    await Promise.resolve();
    assert.equal(runtime.api.stopped, true);
    assert.equal(shutdownFinished, false, 'shutdown drains the pending initializer');
    runtime.release();
    await Promise.all([initializing, stopping]);
    assert.equal(h.metrics.timers.length, 0);
    assert.equal(h.metrics.registered.length, 0);
    assert.equal(h.metrics.writes.length, 0);
  });
}

test('ownership lost during initialization also prevents menus and timers from appearing', async () => {
  const h = host(), old = h.runtime('old', { blockAt: 'readJSON' }), fresh = h.runtime('new');
  h.own(old);
  const initializing = old.api.init('draft-watch@test', 'old');
  await old.entered;
  h.own(fresh);
  old.release();
  await initializing;
  assert.equal(h.metrics.timers.length, 0);
  assert.equal(h.metrics.registered.length, 0);
  assert.equal(h.metrics.writes.length, 0);
});

test('a stale repeating-timer callback cannot queue another scan', async () => {
  const h = host(), old = h.runtime('old'), fresh = h.runtime('new');
  h.own(old);
  await old.api.init('draft-watch@test', 'old');
  let scans = 0;
  old.api.checkAll = async () => { scans++; };
  h.own(fresh);
  h.metrics.timers[0].callback();
  await Promise.resolve();
  assert.equal(scans, 0);
});

test('shutdown allows an in-flight owned write to finish while refusing new operations', async () => {
  const h = host(), runtime = h.runtime('one');
  h.own(runtime);
  const entered = deferred(), finish = deferred();
  const running = runtime.api.serial(async () => {
    entered.resolve();
    await finish.promise;
    runtime.api.state.completedTransaction = true;
    await runtime.api.persist();
  });
  await entered.promise;
  let shutdownFinished = false, nextRan = false;
  const stopping = runtime.api.shutdown().then(() => { shutdownFinished = true; });
  const nextRejected = assert.rejects(runtime.api.serial(() => { nextRan = true; }), /实例已停止/);
  await Promise.resolve();
  assert.equal(shutdownFinished, false);
  finish.resolve();
  await Promise.all([running, stopping, nextRejected]);
  assert.equal(nextRan, false);
  assert.equal(h.metrics.writes.length, 1);
  assert.equal(h.metrics.writes[0].state.completedTransaction, true);
});

test('a scope that loses ownership during queued recovery cannot start the requested mutation', async () => {
  const h = host(), old = h.runtime('old'), fresh = h.runtime('new');
  const entered = deferred(), finish = deferred();
  old.api.state.journal = { bindingID: 'rule-a' };
  old.api.recover = async () => { entered.resolve(); await finish.promise; };
  h.own(old);
  let ran = false;
  const task = old.api.serial(() => { ran = true; });
  const rejected = assert.rejects(task, /新版本接替/);
  await entered.promise;
  h.own(fresh);
  finish.resolve();
  await rejected;
  assert.equal(ran, false);
  assert.equal(h.metrics.writes.length, 0);
});
