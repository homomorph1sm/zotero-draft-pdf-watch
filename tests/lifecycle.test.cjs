const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../bootstrap.js'), 'utf8');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const params = version => ({ id: 'draft-pdf-watch@local', rootURI: 'file:///test-addon/', version });

function host() {
  const events = [], apis = [], loads = [], handles = [], options = [], errors = [];
  let banner = null, ftl = false, activeTimers = 0;
  const window = {
    MozXULElement: { insertFTLIfNeeded() { ftl = true; } },
    document: {
      querySelector: () => ftl ? { remove() { ftl = false; events.push('remove-ftl'); } } : null,
      getElementById: id => id === 'draftwatch-banner' && banner ? { remove() { banner = null; events.push('remove-banner'); } } : null,
    },
  };
  const Zotero = {
    initializationPromise: Promise.resolve(),
    getMainWindows: () => [window], logError: error => errors.push(error),
  };
  function makeAPI(settings = {}) {
    const id = apis.length + 1;
    let timerActive = false;
    const api = {
      id, stopped: false, tail: settings.tail || Promise.resolve(), initCount: 0, shutdownCount: 0,
      timer: { cancel() { if (timerActive) { timerActive = false; activeTimers--; } events.push('cancel-' + id); } },
      async init(_plugin, version) {
        this.initCount++; this.version = version;
        assert.equal(Zotero.DraftPDFWatch, this, 'ownership is established before initialization');
        assert.equal(this.enforceOwnership, true);
        events.push('init-' + id);
        timerActive = true; activeTimers++;
        this.emit();
        if (settings.initGate) await settings.initGate.promise;
        if (settings.initError) throw settings.initError;
      },
      async shutdown() {
        this.shutdownCount++; this.stopped = true; this.timer.cancel(); events.push('stop-' + id);
        if (settings.stopGate) await settings.stopGate.promise;
        if (settings.stopError) throw settings.stopError;
        await this.tail;
        // Deliberately behaves like the old implementation: unconditional UI cleanup.
        banner = null;
        events.push('stopped-' + id);
      },
      emit() { banner = id; },
    };
    apis.push(api);
    return api;
  }
  const Services = {
    io: { newURI: value => value },
    scriptloader: { loadSubScriptWithOptions(uri, args) {
      loads.push({ uri, ignoreCache: args.ignoreCache });
      args.target.DraftPDFWatch = makeAPI(options.shift());
    } },
  };
  function scope() {
    const context = vm.createContext({ Zotero, Services, Cc: {
      '@mozilla.org/addons/addon-manager-startup;1': { getService: () => ({
        registerChrome() {
          const handle = { destroyed: false, destruct() { this.destroyed = true; events.push('destruct-' + handles.indexOf(this)); } };
          handles.push(handle); return handle;
        },
      }) },
    }, Ci: {}, ChromeUtils: {}, IOUtils: {}, PathUtils: {} });
    vm.runInContext(source, context, { filename: 'bootstrap.js' });
    return context;
  }
  return { Zotero, events, apis, loads, handles, options, errors, window, scope, makeAPI,
    get banner() { return banner; }, get ftl() { return ftl; }, get activeTimers() { return activeTimers; } };
}

test('duplicate startup in one scope creates one timer and bypasses the script cache', async () => {
  const h = host(), app = h.scope();
  await Promise.all([app.startup(params('0.1.5+test')), app.startup(params('0.1.5+test'))]);
  assert.equal(h.apis.length, 1);
  assert.equal(h.apis[0].initCount, 1);
  assert.equal(h.activeTimers, 1);
  assert.deepEqual(h.loads, [{ uri: 'file:///test-addon/content/core.js?v=0.1.5%2Btest', ignoreCache: true }]);
  await Promise.all([app.shutdown(), app.shutdown()]);
  assert.equal(h.apis[0].shutdownCount, 1);
  assert.equal(h.activeTimers, 0);
  assert.equal(h.banner, null);
  assert.equal(h.Zotero.DraftPDFWatch, undefined);
  assert.equal(h.handles[0].destroyed, true);
});

test('an upgrade waits for the previous shutdown and queued writes before initializing', async () => {
  const h = host(), old = h.scope(), fresh = h.scope();
  const stopGate = deferred(), writeGate = deferred();
  h.options.push({ stopGate, tail: writeGate.promise });
  await old.startup(params('0.1.5'));
  const upgrading = fresh.startup(params('0.1.6'));
  await turn();
  assert.equal(h.apis.length, 1);
  assert.equal(h.activeTimers, 0);
  stopGate.resolve();
  await turn();
  assert.equal(h.apis.length, 1, 'pending persistence must finish before the new reader starts');
  writeGate.resolve();
  await upgrading;
  assert.equal(h.activeTimers, 1);
  assert.equal(h.Zotero.DraftPDFWatch, h.apis[1]);
  assert.equal(h.banner, 2);
  assert.ok(h.events.indexOf('destruct-0') < h.events.indexOf('init-2'));
});

test('a late shutdown or window-unload from an old bootstrap cannot remove the new UI', async () => {
  const h = host(), old = h.scope(), fresh = h.scope();
  await old.startup(params('0.1.5'));
  await fresh.startup(params('0.1.6'));
  const count = h.events.filter(value => value === 'remove-banner').length;
  await old.shutdown();
  old.onMainWindowUnload({ window: h.window });
  assert.equal(h.banner, 2);
  assert.equal(h.ftl, true);
  assert.equal(h.Zotero.DraftPDFWatch, h.apis[1]);
  assert.equal(h.activeTimers, 1);
  assert.equal(h.handles[1].destroyed, false);
  assert.equal(h.events.filter(value => value === 'remove-banner').length, count);
});

test('synchronous start-stop-start calls follow their order even before startup begins', async () => {
  const h = host(), app = h.scope();
  const starting = app.startup(params('0.1.5'));
  const stopping = app.shutdown();
  const restarting = app.startup(params('0.1.5'));
  await Promise.all([starting, stopping, restarting]);
  assert.equal(h.apis.length, 2);
  assert.equal(h.apis[0].shutdownCount, 1);
  assert.equal(h.activeTimers, 1);
  assert.equal(h.Zotero.DraftPDFWatch, h.apis[1]);
});

test('startup failure cancels the partial instance and does not poison future lifecycle tasks', async () => {
  const h = host(), broken = h.scope(), fresh = h.scope();
  h.options.push({ initError: new Error('initialization failed') });
  await assert.rejects(broken.startup(params('0.1.5')), /initialization failed/);
  assert.equal(h.activeTimers, 0);
  assert.equal(h.banner, null);
  assert.equal(h.Zotero.DraftPDFWatch, undefined);
  assert.equal(h.handles[0].destroyed, true);
  await fresh.startup(params('0.1.6'));
  assert.equal(h.Zotero.DraftPDFWatch, h.apis[1]);
  assert.equal(h.activeTimers, 1);
});

test('legacy instances without a registry are stopped before the new core loads', async () => {
  const h = host(), app = h.scope(), gate = deferred();
  const legacy = h.makeAPI({ stopGate: gate });
  h.Zotero.DraftPDFWatch = legacy;
  const starting = app.startup(params('0.1.5'));
  await turn();
  assert.equal(legacy.shutdownCount, 1);
  assert.equal(h.loads.length, 0);
  gate.resolve();
  await starting;
  assert.equal(h.Zotero.DraftPDFWatch, h.apis[1]);
  assert.equal(h.activeTimers, 1);
});

test('an externally superseded instance cancels its timer without calling its unsafe old shutdown', async () => {
  const h = host(), app = h.scope();
  await app.startup(params('0.1.5'));
  const previous = h.apis[0];
  const foreign = h.makeAPI();
  h.Zotero.DraftPDFWatch = foreign;
  h.Zotero._draftPDFWatchRuntime = { api: foreign, ready: true };
  foreign.emit();
  await app.shutdown();
  assert.equal(previous.shutdownCount, 0);
  assert.equal(previous.stopped, true);
  assert.equal(h.activeTimers, 0);
  assert.equal(h.Zotero.DraftPDFWatch, foreign);
  assert.equal(h.banner, foreign.id);
  assert.equal(h.ftl, true);
});

test('shutdown failure still waits for outstanding writes before releasing ownership', async () => {
  const h = host(), app = h.scope(), gate = deferred();
  h.options.push({ stopError: new Error('shutdown failed'), tail: gate.promise });
  await app.startup(params('0.1.5'));
  const stopping = app.shutdown();
  await turn();
  assert.equal(h.Zotero.DraftPDFWatch, h.apis[0]);
  assert.equal(h.handles[0].destroyed, false);
  gate.resolve();
  await assert.rejects(stopping, /shutdown failed/);
  assert.equal(h.Zotero.DraftPDFWatch, undefined);
  assert.equal(h.handles[0].destroyed, true);
  assert.equal(h.activeTimers, 0);
});
