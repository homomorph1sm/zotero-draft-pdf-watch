const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const source = fs.readFileSync(path.resolve(__dirname, '../content/core.js'), 'utf8');
const bytes = revision => Buffer.from(`%PDF-1.7\nrevision ${revision}: equal-length document bytes\n%%EOF`);
const md5 = contents => createHash('md5').update(contents).digest('hex');

// Execute the real scanner with controlled filesystem metadata and time. The
// stored attachment key is independent from its filename, just as in Zotero.
function host(mode = 'folder') {
  let now = 1800000000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const sourcePath = 'C:\\drafts\\Manuscript_v1.0.42_2026-10-31.pdf';
  let storedPath = 'C:\\storage\\PDFKEY01\\Author - Manuscript.pdf';
  const files = new Map([
    [sourcePath, { contents: bytes('A'), mtime: now - 60000 }],
    [storedPath, { contents: bytes('A'), mtime: now - 60000 }],
  ]);
  const metrics = { hashes: [], notices: [], writes: [], errors: [] };
  const parent = { id: 1, key: 'PARENT01', libraryID: 1, deleted: false,
    isRegularItem: () => true, getField: () => 'A manuscript', getAttachments: () => [2] };
  const attachment = { id: 2, key: 'PDFKEY01', libraryID: 1, parentItemID: 1,
    deleted: false, attachmentContentType: 'application/pdf',
    get attachmentFilename() { return path.win32.basename(storedPath); },
    getField: () => 'A manuscript attachment', getFilePathAsync: async () => storedPath };
  const byID = id => id === 1 ? parent : id === 2 ? attachment : false;
  const prefs = new Map();
  const Zotero = {
    Items: {
      getByLibraryAndKeyAsync: async (libraryID, key) => libraryID !== 1 ? false
        : key === parent.key ? parent : key === attachment.key ? attachment : false,
      getAsync: async ids => Array.isArray(ids) ? ids.map(byID).filter(Boolean) : byID(ids),
    },
    Libraries: { get: () => ({ editable: true, filesEditable: true }) },
    Utilities: { Internal: { md5Async: async file => {
      metrics.hashes.push(file);
      return md5(files.get(file).contents);
    } } },
    Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
    getMainWindows: () => [],
    logError: error => metrics.errors.push(error), debug: () => {},
  };
  const context = vm.createContext({ Date: Clock, Zotero,
    PathUtils: { filename: path.win32.basename, isAbsolute: path.win32.isAbsolute },
    IOUtils: {
      exists: async file => files.has(file),
      stat: async file => {
        const value = files.get(file);
        if (!value) throw new Error('ENOENT: ' + file);
        return { type: 'regular', size: value.contents.length, lastModified: value.mtime };
      },
      getChildren: async directory => [...files.keys()].filter(file => path.win32.dirname(file) === directory),
      read: async (file, options = {}) => {
        const start = options.offset || 0;
        return files.get(file).contents.subarray(start, start + (options.maxBytes || Infinity));
      },
      writeJSON: async (_file, value) => metrics.writes.push(JSON.parse(JSON.stringify(value))),
    },
    Cc: { '@mozilla.org/alerts-service;1': { getService: () => ({
      showAlertNotification: (_icon, title, message) => metrics.notices.push({ title, message }),
    }) } },
    Ci: {},
  });
  vm.runInContext(source, context, { filename: 'core.js' });
  const api = context.DraftPDFWatch;
  const binding = { id: 'rule-a', parentID: 1, parentKey: parent.key, libraryID: 1,
    title: 'A manuscript', attachmentKey: attachment.key,
    mode, path: mode === 'file' ? sourcePath : 'C:\\drafts',
    pattern: 'Manuscript_v*_????-??-??.pdf', order: 'version',
    enabled: true, automatic: false, lastHash: md5(bytes('A')),
    lastSource: null, pending: null, error: null };
  api.state.bindings = [binding];
  api.statePath = 'C:\\test-profile\\draft-pdf-watch.json';
  const advance = milliseconds => { now += milliseconds; };
  return { api, binding, attachment, files, sourcePath, metrics, advance,
    overwrite(revision, { preserveMtime = false, onlyMtime = false } = {}) {
      const file = files.get(sourcePath);
      if (!onlyMtime) file.contents = bytes(revision);
      if (!preserveMtime) file.mtime = now;
    },
    renameStored(name) {
      const previous = files.get(storedPath);
      files.delete(storedPath);
      storedPath = path.win32.join(path.win32.dirname(storedPath), name);
      files.set(storedPath, previous);
    },
    async prime() {
      await api.checkAll();
      assert.equal(binding.status, 'stabilizing');
      advance(15000);
      await api.checkAll();
      assert.equal(binding.status, 'ready');
      assert.equal(binding.pending, null);
    },
    async settle() {
      await api.checkAll();
      assert.equal(binding.status, 'stabilizing');
      advance(15000);
      await api.checkAll();
    },
  };
}

test('same filename and size with a changed modification time detects changed PDF contents', async () => {
  const h = host();
  await h.prime();
  h.overwrite('B');
  await h.settle();
  assert.equal(h.binding.pending.path, h.sourcePath);
  assert.equal(h.binding.pending.hash, md5(bytes('B')));
  assert.equal(h.binding.attachmentKey, 'PDFKEY01');
  assert.equal(h.binding.error, null);
  assert.equal(h.metrics.notices.length, 1);
  assert.match(h.metrics.notices[0].message, /发现新版/);
  assert.equal(h.metrics.writes.at(-1).bindings[0].pending.hash, md5(bytes('B')));
});

test('same filename, size and modification time are rehashed after the cache expires', async () => {
  const h = host('file');
  await h.prime();
  const initialHashes = h.metrics.hashes.length;
  h.overwrite('B', { preserveMtime: true });
  h.advance(15000);
  await h.api.checkAll();
  assert.equal(h.binding.pending, null, 'metadata cache is still fresh');
  assert.equal(h.metrics.hashes.length, initialHashes);
  h.advance(120000);
  await h.api.checkAll();
  assert.equal(h.binding.pending.hash, md5(bytes('B')));
  assert.equal(h.metrics.hashes.length, initialHashes + 1);
  assert.equal(h.metrics.notices.length, 1);
});

test('a modification-time-only change does not offer an unchanged PDF as a new version', async () => {
  const h = host();
  await h.prime();
  h.overwrite('A', { onlyMtime: true });
  await h.settle();
  assert.equal(h.binding.status, 'ready');
  assert.equal(h.binding.pending, null);
  assert.equal(h.binding.lastHash, md5(bytes('A')));
  assert.equal(h.metrics.notices.length, 0);
});

test('manual checking rehashes unchanged metadata without waiting for cache expiry', async () => {
  const h = host('file');
  await h.prime();
  const hashes = h.metrics.hashes.length;
  h.overwrite('B', { preserveMtime: true });
  await h.api.checkAll({forceHash: true});
  assert.equal(h.metrics.hashes.length, hashes + 1);
  assert.equal(h.binding.pending.hash, md5(bytes('B')));
  assert.equal(h.metrics.notices.length, 1);
});

test('renaming the stored Zotero PDF does not invalidate its unchanged attachment item key', async () => {
  const h = host();
  await h.prime();
  h.renameStored('another-name-without-source-version.pdf');
  h.advance(15000);
  await h.api.checkAll();
  const target = await h.api.validateTarget(h.binding);
  assert.equal(target.old, h.attachment);
  assert.equal(h.binding.attachmentKey, 'PDFKEY01');
  assert.equal(h.binding.error, null);
  assert.equal(h.binding.status, 'ready');
  assert.equal(h.binding.pending, null);
});

test('a second pending content revision under the same filename triggers a fresh notification', async () => {
  const h = host();
  await h.prime();
  h.overwrite('B');
  await h.settle();
  const tokenB = h.api.bannerAlerts()[0].token;
  assert.equal(h.metrics.notices.length, 1);
  h.api.dismissBanner();
  await h.api.checkAll();
  assert.equal(h.metrics.notices.length, 1, 'unchanged content is not repeatedly announced');
  h.overwrite('C');
  await h.settle();
  assert.equal(h.binding.pending.hash, md5(bytes('C')));
  assert.notEqual(h.api.bannerAlerts()[0].token, tokenB);
  assert.equal(h.metrics.notices.length, 2, 'the same filename with a new MD5 is a new alert');
});
