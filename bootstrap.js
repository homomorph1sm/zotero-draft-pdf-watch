var runtime;

// Add-on lifecycle callbacks can arrive from different bootstrap scopes during
// an upgrade. Keep their queue on Zotero, not in a scope that is being replaced.
function lifecycle(action) {
  const previous = Zotero._draftPDFWatchLifecycle || Promise.resolve();
  const task = previous.then(action, action);
  Zotero._draftPDFWatchLifecycle = task.catch(() => {});
  return task;
}

function owns(record) {
  return !!record?.api && Zotero.DraftPDFWatch === record.api;
}

function clearWindow(window) {
  window.document.querySelector('link[href="draftwatch.ftl"]')?.remove();
  window.document.getElementById('draftwatch-banner')?.remove();
}

async function stopRuntime(record) {
  if (!record || record.cleaned) return;
  const ownAPI = record.api;
  try {
    if (ownAPI) {
      try {
        if (owns(record)) await ownAPI.shutdown();
        else {
          // A late callback must not let an old shutdown remove a newer UI.
          ownAPI.stopped = true;
          ownAPI.timer?.cancel();
        }
      } finally { await ownAPI.tail; }
    }
  } finally {
    if (owns(record)) {
      for (const win of Zotero.getMainWindows()) clearWindow(win);
      delete Zotero.DraftPDFWatch;
    }
    // Managed handoffs release the old registration before creating a new one.
    // If some external code already replaced us, do not unregister its chrome.
    if (!Zotero._draftPDFWatchRuntime || Zotero._draftPDFWatchRuntime === record) {
      record.chromeHandle?.destruct();
    }
    if (Zotero._draftPDFWatchRuntime === record) delete Zotero._draftPDFWatchRuntime;
    record.cleaned = true;
  }
}

function startup({ id, rootURI, version }) {
  return lifecycle(async () => {
    await Zotero.initializationPromise;
    if (runtime?.ready && owns(runtime) && !runtime.api.stopped) return;
    await stopRuntime(Zotero._draftPDFWatchRuntime);
    // Also take over cleanly from versions predating the runtime registry.
    const previousAPI = Zotero.DraftPDFWatch;
    if (previousAPI) {
      await previousAPI.shutdown();
      await previousAPI.tail;
      if (Zotero.DraftPDFWatch === previousAPI) delete Zotero.DraftPDFWatch;
    }
    const record = runtime = { api: null, chromeHandle: null, ready: false, cleaned: false };
    Zotero._draftPDFWatchRuntime = record;
    try {
      const aom = Cc['@mozilla.org/addons/addon-manager-startup;1'].getService(Ci.amIAddonManagerStartup);
      record.chromeHandle = aom.registerChrome(Services.io.newURI(rootURI + 'manifest.json'), [
        ['content', 'draftwatch', rootURI + 'content/']
      ]);
      const scope = { Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils };
      Services.scriptloader.loadSubScriptWithOptions(rootURI + 'content/core.js?v=' + encodeURIComponent(version || ''), {
        target: scope, ignoreCache: true
      });
      const api = record.api = scope.DraftPDFWatch;
      api.enforceOwnership = true;
      Zotero.DraftPDFWatch = api;
      for (const win of Zotero.getMainWindows()) onMainWindowLoad({ window: win });
      await api.init(id, version);
      record.ready = true;
    } catch (error) {
      try { await stopRuntime(record); } catch (cleanupError) { Zotero.logError(cleanupError); }
      throw error;
    }
  });
}

function shutdown() {
  return lifecycle(() => stopRuntime(runtime));
}
function install() {}
function uninstall() {}
function onMainWindowLoad({ window }) {
  if (!owns(runtime)) return;
  window.MozXULElement.insertFTLIfNeeded('draftwatch.ftl');
  if (runtime.ready) runtime.api.emit();
}
function onMainWindowUnload({ window }) {
  if (owns(runtime)) clearWindow(window);
}
