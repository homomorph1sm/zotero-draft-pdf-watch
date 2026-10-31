var chromeHandle, scope;
async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  const aom = Cc['@mozilla.org/addons/addon-manager-startup;1'].getService(Ci.amIAddonManagerStartup);
  chromeHandle = aom.registerChrome(Services.io.newURI(rootURI + 'manifest.json'), [
    ['content', 'draftwatch', rootURI + 'content/']
  ]);
  scope = { Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils };
  for (const win of Zotero.getMainWindows()) onMainWindowLoad({ window: win });
  Services.scriptloader.loadSubScript(rootURI + 'content/core.js', scope);
  Zotero.DraftPDFWatch = scope.DraftPDFWatch;
  await scope.DraftPDFWatch.init(id);
}
async function shutdown() {
  if (scope) await scope.DraftPDFWatch.shutdown();
  delete Zotero.DraftPDFWatch;
  for (const win of Zotero.getMainWindows()) onMainWindowUnload({ window: win });
  chromeHandle?.destruct();
  scope = null;
}
function install() {}
function uninstall() {}
function onMainWindowLoad({ window }) {
  window.MozXULElement.insertFTLIfNeeded('draftwatch.ftl');
}
function onMainWindowUnload({ window }) {
  window.document.querySelector('link[href="draftwatch.ftl"]')?.remove();
  window.document.getElementById('draftwatch-banner')?.remove();
}
