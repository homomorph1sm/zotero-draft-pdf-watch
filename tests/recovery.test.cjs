const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const source = fs.readFileSync(path.resolve(__dirname, '../content/core.js'), 'utf8');
const digest = contents => createHash('md5').update(contents).digest('hex');
const snapshot = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
};

/** Isolated Zotero host: the production core executes unchanged in its own VM. */
function host({ journal = true, freshExists = true, freshParentID = 1, freshContent, oldDeleted = true, scanGate = null } = {}) {
  const oldPDF = Buffer.from('%PDF-1.7\nold version payload\n%%EOF');
  const newPDF = Buffer.from('%PDF-1.7\nnew version payload with changes\n%%EOF');
  const files = new Map([
    ['C:\\storage\\OLDPDF01\\paper_v1.pdf', oldPDF],
    ['C:\\storage\\NEWPDF01\\paper_v2.pdf', freshContent ?? newPDF],
    ['C:\\papers\\paper_v2.pdf', newPDF],
  ]);
  const mtime = Date.now() - 10000;
  const metrics = {
    saves: [], trash: [], writes: [], imports: 0, transactions: 0,
    scans: 0, stats: 0, errors: [], enteredScan: deferred(),
  };
  const items = new Map();
  const item = ({ id, key, title, deleted = false, parentItemID = null, filePath = null }) => {
    const obj = {
      id, key, libraryID: 1, deleted, parentItemID,
      attachmentContentType: filePath ? 'application/pdf' : null,
      attachmentFilename: filePath ? path.win32.basename(filePath) : '',
      isRegularItem: () => parentItemID === null,
      getField: field => field === 'title' ? title : '',
      setField: (field, value) => { if (field === 'title') title = value; },
      getFilePathAsync: async () => filePath,
      getAttachments: () => [...items.values()].filter(a => a.parentItemID === id && !a.deleted).map(a => a.id),
      save: async () => { metrics.saves.push({ key, deleted: obj.deleted, title }); },
      saveTx: async () => { metrics.saves.push({ key, deleted: obj.deleted, title }); },
    };
    items.set(key, obj);
    return obj;
  };
  const parent = item({id: 1, key: 'PARENT01', title: 'A paper in progress'});
  const old = item({id: 2, key: 'OLDPDF01', title: 'paper_v1.pdf', deleted: oldDeleted,
    parentItemID: 1, filePath: 'C:\\storage\\OLDPDF01\\paper_v1.pdf'});
  const fresh = freshExists ? item({id: 3, key: 'NEWPDF01', title: 'paper_v2.pdf',
    parentItemID: freshParentID, filePath: 'C:\\storage\\NEWPDF01\\paper_v2.pdf'}) : null;
  const lookup = value => [...items.values()].find(a => a.id === Number(value));
  const trash = async ids => {
    metrics.trash.push([...ids]);
    for (const id of ids) lookup(id).deleted = true;
  };
  const IOUtils = {
    exists: async file => files.has(file),
    stat: async file => {
      metrics.stats++;
      if (!files.has(file)) throw new Error('ENOENT: ' + file);
      return {type: 'regular', size: files.get(file).length, lastModified: mtime};
    },
    read: async (file, options = {}) => {
      if (!files.has(file)) throw new Error('ENOENT: ' + file);
      const bytes = files.get(file);
      return bytes.subarray(options.offset || 0, (options.offset || 0) + (options.maxBytes || bytes.length));
    },
    getChildren: async directory => {
      metrics.scans++;
      metrics.enteredScan.resolve();
      if (scanGate) await scanGate.promise;
      return [...files.keys()].filter(file => path.win32.dirname(file) === directory);
    },
    writeJSON: async (file, value) => { metrics.writes.push({file, state: snapshot(value)}); },
  };
  const Zotero = {
    Items: {
      getByLibraryAndKey: (libraryID, key) => {
        const result = items.get(key);
        return result?.libraryID === libraryID ? result : false;
      },
      getByLibraryAndKeyAsync: async (libraryID, key) => {
        const result = items.get(key);
        return result?.libraryID === libraryID ? result : false;
      },
      getAsync: async ids => Array.isArray(ids) ? ids.map(lookup).filter(Boolean) : lookup(ids),
      trash, trashTx: trash,
    },
    Libraries: {get: () => ({editable: true, filesEditable: true})},
    Utilities: {
      Internal: {md5Async: async file => {
        if (!files.has(file)) throw new Error('ENOENT: ' + file);
        return digest(files.get(file));
      }},
      randomString: () => 'test-random-id',
    },
    Attachments: {importFromFile: async () => { metrics.imports++; throw new Error('Unexpected import'); }},
    DB: {executeTransaction: async callback => { metrics.transactions++; return callback(); }},
    Reader: {_readers: [], open: async () => {}},
    getMainWindows: () => [],
    logError: error => { metrics.errors.push(error); },
    debug: () => {},
  };
  const context = vm.createContext({ Zotero, IOUtils, PathUtils: {
    join: path.win32.join, filename: path.win32.basename, isAbsolute: path.win32.isAbsolute,
  }, Cc: {}, Ci: {} });
  vm.runInContext(source, context, {filename: 'core.js'});
  const api = context.DraftPDFWatch;
  api.statePath = 'C:\\test-profile\\draft-pdf-watch.json';
  const previous = {
    attachmentKey: old.key, lastHash: digest(oldPDF),
    lastSource: {path: 'C:\\papers\\paper_v1.pdf', name: 'paper_v1.pdf', mtime: mtime - 10000},
    lastUpdated: '2026-10-30T12:00:00.000Z',
  };
  const candidate = {path: 'C:\\papers\\paper_v2.pdf', name: 'paper_v2.pdf', mtime,
    size: newPDF.length, hash: digest(newPDF)};
  const binding = {
    id: 'rule-1', parentID: parent.id, parentKey: parent.key, libraryID: 1,
    title: parent.getField('title'), enabled: true, automatic: false,
    mode: 'folder', path: 'C:\\papers', pattern: 'paper_v*.pdf', order: 'version',
    ...snapshot(previous), pending: snapshot(candidate), error: null,
  };
  api.state = {schema: 1, bindings: [binding], journal: journal ? {
    bindingID: binding.id, parentKey: parent.key, libraryID: 1,
    oldKey: old.key, newKey: 'NEWPDF01', marker: 'DraftWatch pending test',
    source: snapshot(candidate), previous: snapshot(previous),
  } : null};
  return {api, binding, parent, old, fresh, files, items, metrics, previous, candidate, zotero: Zotero};
}

test('key lookup loads existing items asynchronously rather than relying on a warm cache', async () => {
  const h = host({journal: false, oldDeleted: false});
  h.zotero.Items.getByLibraryAndKey = () => { throw new Error('UnloadedDataException'); };
  const target = await h.api.validateTarget(h.binding);
  assert.equal(target.old.key, h.old.key);
  const saved = await h.api.saveBinding({...h.binding, attachmentKey: h.fresh.key});
  assert.equal(saved.attachmentKey, h.fresh.key);
  assert.equal(saved.error, null);
});

test('obsolete binding permits editing its source and pausing without silently selecting another PDF', async () => {
  const h = host({journal: false});
  const updated = await h.api.saveBinding({...h.binding, path: 'C:\\new-drafts', pattern: 'revision*.pdf', enabled: false});
  assert.equal(updated.path, 'C:\\new-drafts');
  assert.equal(updated.pattern, 'revision*.pdf');
  assert.equal(updated.enabled, false);
  assert.equal(updated.attachmentKey, h.old.key);
  assert.equal(updated.errorCode, 'attachment-invalid');
  assert.equal(updated.pending, null);
  assert.equal(h.metrics.writes.at(-1).state.bindings[0].path, 'C:\\new-drafts');
  assert.equal(h.metrics.imports, 0);
  assert.deepEqual(h.metrics.trash, []);
});

test('explicit repair adopts the currently selected PDF and clears the error without replacing a file', async () => {
  const h = host({journal: false});
  h.binding.error = 'obsolete';
  const updated = await h.api.saveBinding({...h.binding, attachmentKey: h.fresh.key});
  assert.equal(updated.attachmentKey, h.fresh.key);
  assert.equal(updated.lastHash, h.candidate.hash);
  assert.equal(updated.error, null);
  assert.equal(updated.errorCode, null);
  assert.equal(updated.path, h.binding.path);
  assert.equal(h.old.deleted, true);
  assert.equal(h.fresh.deleted, false);
  assert.equal(h.metrics.imports, 0);
  assert.deepEqual(h.metrics.trash, []);
});

test('automatic checks never guess a replacement target for an obsolete binding', async () => {
  const h = host({journal: false});
  h.binding.automatic = true;
  await h.api.checkAll();
  assert.match(h.binding.error, /回收站/);
  assert.equal(h.binding.errorCode, 'attachment-invalid');
  assert.equal(h.binding.attachmentKey, h.old.key);
  assert.equal(h.binding.pending, null);
  assert.equal(h.metrics.imports, 0);
  assert.deepEqual(h.metrics.trash, []);
});

test('an empty target is rejected if a current PDF exists and invented keys are rejected', async () => {
  const h = host({journal: false});
  await assert.rejects(h.api.saveBinding({...h.binding, attachmentKey: ''}), /请选择要替换/);
  await assert.rejects(h.api.saveBinding({...h.binding, attachmentKey: 'WRONGKEY'}), /刷新附件列表/);
  assert.equal(h.metrics.writes.length, 0);
});

test('explicit empty-target repair is saved only when no current PDF remains', async () => {
  const h = host({journal: false, freshExists: false});
  const updated = await h.api.saveBinding({...h.binding, attachmentKey: ''});
  assert.equal(updated.attachmentKey, null);
  assert.equal(updated.lastHash, null);
  assert.equal(updated.lastSource, null);
  assert.equal(updated.error, null);
  assert.equal(h.metrics.imports, 0);
  assert.deepEqual(h.metrics.trash, []);
});

test('unavailable source can be saved as an actionable error while malformed configuration still fails', async () => {
  const h = host({journal: false, oldDeleted: false});
  const updated = await h.api.saveBinding({...h.binding, mode: 'file', path: 'C:\\missing.pdf', enabled: false});
  assert.equal(updated.path, 'C:\\missing.pdf');
  assert.equal(updated.enabled, false);
  assert.equal(updated.errorCode, 'source-unavailable');
  assert.match(updated.error, /ENOENT/);
  await assert.rejects(h.api.saveBinding({...updated, path: 'relative.pdf'}), /完整的绝对路径/);
  await assert.rejects(h.api.saveBinding({...updated, pattern: '../*.pdf'}), /只填写文件名/);
});

test('editing an existing binding cannot change its parent identity', async () => {
  const h = host({journal: false});
  h.parent.key = 'OTHER001';
  await assert.rejects(h.api.saveBinding({...h.binding}), /更换父条目/);
  assert.equal(h.metrics.writes.length, 0);
});

test('committed replacement recovers to the verified new attachment and persists it', async () => {
  const h = host();
  await h.api.recover();

  const [visible] = await h.api.listBindings();
  assert.equal(visible.attachmentKey, h.fresh.key);
  assert.equal(visible.lastHash, h.candidate.hash);
  assert.equal(visible.lastSource.name, 'paper_v2.pdf');
  assert.equal(visible.pending, null);
  assert.equal(visible.status, 'ready');
  assert.equal(h.old.deleted, true);
  assert.equal(h.fresh.deleted, false);
  assert.equal(h.api.state.journal, null);
  assert.equal(h.metrics.writes.at(-1).state.journal, null);
  assert.equal(h.metrics.writes.at(-1).state.bindings[0].attachmentKey, 'NEWPDF01');
  assert.equal(h.metrics.imports, 0, 'recovery must reuse the verified copy, not import another');
  assert.deepEqual(h.metrics.trash, []);
});

test('missing new attachment restores the trashed old one and the prior binding', async () => {
  const h = host({freshExists: false});
  // A failed config write can leave the in-memory binding at the new key.
  h.binding.attachmentKey = 'NEWPDF01';
  h.binding.lastHash = h.candidate.hash;
  h.binding.lastSource = h.candidate;
  h.binding.lastUpdated = '2026-10-31T12:00:00.000Z';
  await h.api.recover();

  assert.equal(h.old.deleted, false);
  assert.ok(h.metrics.saves.some(s => s.key === 'OLDPDF01' && s.deleted === false));
  for (const key of Object.keys(h.previous)) {
    assert.deepEqual(snapshot(h.binding[key]), h.previous[key], 'prior ' + key + ' restored');
  }
  assert.equal(h.binding.pending, null);
  assert.match(h.binding.error, /已保留旧附件/);
  assert.equal(h.api.state.journal, null);
  assert.equal(h.metrics.writes.at(-1).state.journal, null);
  assert.equal(h.metrics.writes.at(-1).state.bindings[0].attachmentKey, 'OLDPDF01');
  assert.deepEqual(h.metrics.trash, []);
});

test('new attachment moved to another parent blocks recovery without discarding the journal', async () => {
  const h = host({freshParentID: 99});
  const before = snapshot(h.api.state);
  await assert.rejects(h.api.recover(), /附件已被移动/);

  assert.deepEqual(snapshot(h.api.state), before);
  assert.equal(h.fresh.parentItemID, 99);
  assert.equal(h.fresh.deleted, false);
  assert.equal(h.old.deleted, true);
  assert.deepEqual(h.metrics.saves, []);
  assert.deepEqual(h.metrics.trash, []);
  assert.deepEqual(h.metrics.writes, []);
});

test('removing a binding cannot abandon an unresolved recovery journal', async () => {
  const h = host({freshParentID: 99});
  const before = snapshot(h.api.state);
  await assert.rejects(h.api.removeBinding(h.binding.id), /附件已被移动/);
  await h.api.tail;

  assert.deepEqual(snapshot(h.api.state), before);
  assert.equal((await h.api.listBindings()).length, 1);
  assert.deepEqual(h.metrics.writes, []);
  assert.deepEqual(h.metrics.trash, []);
});

test('a second replacement cannot overwrite an existing journal or import a file', async () => {
  const h = host();
  const before = snapshot(h.api.state);
  await assert.rejects(h.api.replace(h.binding), /上次替换尚待恢复/);

  assert.deepEqual(snapshot(h.api.state), before);
  assert.equal(h.metrics.imports, 0);
  assert.equal(h.metrics.transactions, 0);
  assert.equal(h.metrics.scans, 0);
  assert.deepEqual(h.metrics.writes, []);
});

test('concurrent checks share one scan; another check can run after it finishes', async () => {
  const gate = deferred();
  const h = host({journal: false, oldDeleted: false, scanGate: gate});
  h.binding.pending = null;
  const tasks = Array.from({length: 6}, () => h.api.checkAll());
  await h.metrics.enteredScan.promise;
  assert.equal(h.metrics.scans, 1);
  for (const task of tasks) assert.equal(task, tasks[0]);

  gate.resolve();
  await Promise.all(tasks);
  assert.equal(h.metrics.scans, 1, 'one source listing for concurrent manual/timer checks');
  assert.equal(h.metrics.writes.length, 1);
  assert.equal((await h.api.listBindings())[0].status, 'stabilizing');
  assert.equal(h.metrics.imports, 0);

  await h.api.checkAll();
  assert.equal(h.metrics.scans, 2, 'completed scan does not permanently block later checks');
  assert.equal(h.metrics.writes.length, 2);
});

test('a corrupted imported copy is discarded while the prior attachment is restored', async () => {
  const h = host({freshContent: Buffer.from('not the expected PDF bytes')});
  await h.api.recover();

  assert.equal(h.old.deleted, false);
  assert.equal(h.fresh.deleted, true);
  assert.equal(h.binding.attachmentKey, h.old.key);
  assert.equal(h.binding.lastHash, h.previous.lastHash);
  assert.equal(h.api.state.journal, null);
  assert.deepEqual(h.metrics.trash, [[h.fresh.id]]);
  assert.equal(h.metrics.writes.at(-1).state.bindings[0].attachmentKey, h.old.key);
});
