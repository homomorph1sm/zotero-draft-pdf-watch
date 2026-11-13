const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../content/core.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const main = 'Manuscript_v2.0.31_2026-11-13.pdf';
const chapter = 'Manuscript_v2.0.31_Ch6_SecurityAnalysis_2026-11-13.pdf';
const pdf = text => Buffer.from('%PDF-1.7\n' + text + '\n%%EOF');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');

function host(names = [main, chapter], options = {}) {
  let now = 1800000000000;
  class Clock extends Date { static now() { return now; } }
  const files = new Map(names.map((name, i) => ['/drafts/' + name, {data: pdf(name), mtime: now - 100000 + i * 1000}]));
  const metrics = { writes: [], imports: [], notifications: [], hashReads: [] };
  const prefs = new Map();
  let writeFailure = false;
  const context = vm.createContext({ Date: Clock,
    PathUtils: { filename: path.posix.basename, parent: path.posix.dirname, isAbsolute: path.posix.isAbsolute },
    IOUtils: {
      stat: async file => {
        if (!files.has(file)) throw new Error('ENOENT');
        const f = files.get(file); return {type: 'regular', size: f.data.length, lastModified: f.mtime};
      },
      getChildren: async directory => [...files.keys()].filter(file => path.posix.dirname(file) === directory),
      read: async (file, opts = {}) => files.get(file).data.subarray(opts.offset || 0, (opts.offset || 0) + (opts.maxBytes || Infinity)),
      writeJSON: async (_path, state) => { if (writeFailure) throw new Error('disk full'); metrics.writes.push(plain(state)); },
    },
    Zotero: {
      logError() {}, debug() {}, getMainWindows: () => [], Reader: {_readers: []},
      Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
      Utilities: {randomString: () => 'test-binding', Internal: {md5Async: async file => {
        metrics.hashReads.push(file); return md5(files.get(file).data);
      }}},
      Attachments: {importFromFile: async args => { metrics.imports.push(args); throw new Error('Must not import during this check'); }},
    },
  });
  vm.runInContext(source, context);
  const api = context.DraftPDFWatch;
  api.validateTarget = async () => ({ parent: {id: 1}, old: null });
  api.getParent = async () => ({parentID: 1, parentKey: 'PARENT01', libraryID: 1, title: 'Manuscript', attachments: []});
  api.notify = (binding, message, token) => {
    if (api.notices.get(binding.id) === token) return;
    api.notices.set(binding.id, token); metrics.notifications.push({message, token});
  };
  const initial = {id: 'rule', parentID: 1, parentKey: 'PARENT01', libraryID: 1, title: 'Manuscript',
    mode: 'folder', path: '/drafts', pattern: '*.pdf', order: 'version', enabled: true,
    automatic: false, lastHash: 'old-hash', lastSource: null, pending: null, ...options};
  api.state.bindings = [initial];
  return { api, files, metrics, initial, get binding() { return api.binding('rule'); },
    advance(ms = 15000) { now += ms; }, failWrites(value) { writeFailure = value; },
    async settle() { await api.checkAll(); now += 15000; await api.checkAll(); },
  };
}

test('one-second-apart full and chapter PDFs require choice under either ordering', async () => {
  for (const order of ['version', 'mtime']) {
    const h = host(undefined, { order, automatic: true });
    await h.settle();
    assert.equal(h.binding.status, 'choice');
    assert.equal(h.binding.pending, null);
    assert.deepEqual(new Set(h.binding.choices.map(f => f.name)), new Set([main, chapter]));
    assert.equal(h.metrics.imports.length, 0);
    assert.equal(h.metrics.hashReads.length, 0, 'ambiguity is decided before content reads');
    assert.equal(h.metrics.notifications.length, 1, 'unchanged choices do not notify on every poll');
  }
});

test('series ambiguity is not limited to identical or nearby timestamps', async () => {
  const h = host();
  h.files.get('/drafts/' + chapter).mtime -= 86400000;
  await h.api.checkAll();
  assert.equal(h.binding.choices.length, 2);
});

test('only explicit version and date vary; chapter identifiers and unknown names stay distinct', () => {
  const { api } = host();
  const key = name => api.seriesInfo(name).key;
  assert.equal(key(main), key('Manuscript_v3.1.0_2027-01-01.pdf'));
  assert.equal(key(chapter), key('Manuscript_v3.1.0_Ch6_SecurityAnalysis_2027-01-01.pdf'));
  assert.notEqual(key(main), key(chapter));
  assert.notEqual(key('Manuscript_v2_Ch3-6_2026-11-13.pdf'), key(chapter));
  assert.notEqual(key('Manuscript_v2_Ch3-6_2026-11-13.pdf'), key('Manuscript_v2_Ch3-7_2026-11-13.pdf'));
  assert.notEqual(key(main), key('Manuscript_supplement_v2_2026-11-13.pdf'));
  assert.notEqual(key('Unclassified1.pdf'), key('Unclassified2.pdf'));
  assert.equal(key('paper_v2.pdf'), key('paper_v10.pdf'));
  assert.equal(key('paper_2026-11-12.pdf'), key('paper_2026-11-13.pdf'));
});

test('choices contain the latest candidate of each series and keep complete filenames', async () => {
  const old = 'Manuscript_v2.0.9_2026-11-12.pdf';
  const h = host([old, chapter, main]);
  await h.api.checkAll();
  assert.equal(h.binding.choices.length, 2);
  assert.ok(h.binding.choices.some(f => f.name === main && f.size > 0 && typeof f.mtime === 'number'));
  assert.ok(!h.binding.choices.some(f => f.name === old));
  await assert.rejects(h.api.chooseCandidate('rule', '/drafts/' + old), /更新的候选/);
});

test('choosing a full document persists its series and future checks never choose chapter PDFs', async () => {
  const h = host();
  await h.api.checkAll();
  const result = await h.api.chooseCandidate('rule', '/drafts/' + main);
  assert.equal(result.series, h.api.seriesInfo(main).key);
  assert.equal(result.status, 'stabilizing', 'selection checks only its own rule immediately');
  assert.equal(result.pending, null);
  assert.equal(h.metrics.imports.length, 0, 'selecting does not replace the attachment');
  assert.equal(h.metrics.writes.at(-1).bindings[0].series, result.series);
  await h.settle();
  assert.equal(h.binding.pending.name, main);
  const next = 'Manuscript_v2.0.32_2026-11-14.pdf';
  h.files.set('/drafts/' + next, {data: pdf('next full document'), mtime: Date.now() - 60000});
  await h.settle();
  assert.equal(h.binding.pending.name, next);
  h.files.delete('/drafts/' + main); h.files.delete('/drafts/' + next);
  await h.api.checkAll();
  assert.equal(h.binding.pending, null);
  assert.equal(h.binding.status, 'waiting', 'missing selected series never falls back to chapter');
});

test('old lastSource and stored pending do not count as user selection during upgrade', async () => {
  const h = host(undefined, {pending: {path: '/drafts/' + chapter, name: chapter, hash: 'saved'}, lastSource: {path: '/drafts/' + chapter, name: chapter}});
  await assert.rejects(h.api.update('rule'), /先选择/);
  assert.equal(h.binding.status, 'choice');
  assert.equal(h.binding.pending, null);
  assert.equal(h.metrics.imports.length, 0);
  assert.equal(h.metrics.writes.at(-1).bindings[0].status, 'choice');
});

test('a second series arriving after scan blocks replacement at its final candidate check', async () => {
  const h = host([main]);
  await h.settle();
  assert.ok(h.binding.pending);
  h.files.set('/drafts/' + chapter, {data: pdf('chapter'), mtime: Date.now() - 60000});
  await assert.rejects(h.api.update('rule'), /先选择/);
  assert.equal(h.metrics.imports.length, 0);
  assert.equal(h.binding.choices.length, 2);
});

test('candidate selection rejects removed or foreign paths and rolls back on failed persistence', async () => {
  const h = host();
  const before = plain(h.binding);
  const observation = {signature: 'old-observation', since: 1};
  h.api.observations.set('rule', observation);
  await assert.rejects(h.api.chooseCandidate('rule', '/elsewhere/' + main), /不在匹配目录/);
  h.failWrites(true);
  await assert.rejects(h.api.chooseCandidate('rule', '/drafts/' + main), /disk full/);
  assert.deepEqual(plain(h.binding), before);
  assert.equal(h.api.observations.get('rule'), observation, 'failed selection restores the previous stability sample');
  h.failWrites(false);
  await h.api.chooseCandidate('rule', '/drafts/' + main);
  await h.api.chooseCandidate('rule', null);
  assert.equal(h.binding.series, null);
  assert.equal(h.binding.status, 'choice', 'reset exposes choices immediately without a global scan');
});

test('selection scans only its own rule and records scan errors without importing', async () => {
  const h = host(undefined, {automatic: true});
  const other = {...h.binding, id: 'other', automatic: true, status: 'pending', pending: {name: 'other.pdf'}};
  h.api.state.bindings.push(other);
  const previousOther = plain(other);
  h.api.checkAll = () => { throw new Error('Do not scan unrelated rules'); };
  await h.api.chooseCandidate('rule', '/drafts/' + main);
  assert.equal(h.binding.status, 'stabilizing');
  assert.deepEqual(plain(other), previousOther);
  assert.equal(h.metrics.imports.length, 0);
  h.api.validateTarget = async () => { throw new Error('Target needs repair'); };
  const result = await h.api.chooseCandidate('rule', '/drafts/' + chapter);
  assert.equal(result.series, h.api.seriesInfo(chapter).key);
  assert.match(result.error, /Target needs repair/);
  assert.equal(h.metrics.writes.at(-1).bindings[0].series, result.series);
});

test('known ambiguity remains locked when only one series remains, including across restart', async () => {
  const h = host(undefined, {automatic: true});
  await h.api.checkAll();
  assert.equal(h.binding.selectionRequired, true);
  h.files.delete('/drafts/' + main);
  await h.settle();
  assert.equal(h.binding.status, 'choice');
  assert.equal(h.binding.choices.length, 1);
  assert.equal(h.metrics.imports.length, 0);
  const resumed = host([chapter], plain(h.binding));
  await resumed.settle();
  assert.equal(resumed.binding.status, 'choice');
  assert.equal(resumed.metrics.imports.length, 0);
});

test('zero files and unchanged-source saves cannot erase a required selection', async () => {
  const h = host(undefined, {automatic: true});
  await h.api.checkAll();
  h.files.clear();
  await h.api.checkAll();
  assert.equal(h.binding.status, 'waiting');
  assert.equal(h.binding.selectionRequired, true);
  await h.api.saveBinding({...h.binding, order: 'mtime'});
  assert.equal(h.binding.selectionRequired, true);
  h.files.set('/drafts/' + chapter, {data: pdf('chapter restored'), mtime: Date.now() - 60000});
  await h.settle();
  assert.equal(h.binding.status, 'choice');
  assert.equal(h.metrics.imports.length, 0);
  await h.api.chooseCandidate('rule', '/drafts/' + chapter);
  assert.equal(h.binding.selectionRequired, false);
  assert.equal(h.binding.status, 'stabilizing');
});

test('stored pending cannot bypass a persisted selection lock after a file disappears', async () => {
  const h = host([chapter], {selectionRequired: true, pending: {path: '/drafts/' + chapter, name: chapter, hash: 'old-pending'}});
  await assert.rejects(h.api.update('rule'), /先选择/);
  assert.equal(h.binding.status, 'choice');
  assert.equal(h.binding.choices.length, 1);
  assert.equal(h.metrics.imports.length, 0);
});

test('both full and chapter rule generators retain precise series across a glob wildcard', async () => {
  const h = host();
  for (const name of [main, chapter]) {
    const config = await h.api.ruleFromFile('/drafts/' + name);
    assert.equal(config.series, h.api.seriesInfo(name).key);
    assert.deepEqual(plain((await h.api.candidates(config)).map(f => f.name)), [name]);
  }
});

test('same-name content updates still use MD5 after a series has been selected', async () => {
  const h = host();
  await h.api.chooseCandidate('rule', '/drafts/' + main);
  h.binding.lastHash = md5(h.files.get('/drafts/' + main).data);
  await h.settle();
  assert.equal(h.binding.status, 'ready');
  h.files.get('/drafts/' + main).data = pdf('changed contents');
  h.files.get('/drafts/' + main).mtime += 10000;
  await h.settle();
  assert.equal(h.binding.pending.name, main);
  assert.notEqual(h.binding.pending.hash, h.binding.lastHash);
});

test('a fixed file is unaffected by other documents in its directory', async () => {
  const h = host(undefined, { mode: 'file', path: '/drafts/' + main });
  await h.settle();
  assert.equal(h.binding.pending.name, main);
  assert.equal(h.binding.choices.length, 0);
});

test('saving a changed source clears stale choices and lastSource while preserving explicit series', async () => {
  const h = host();
  const rule = await h.api.ruleFromFile('/drafts/' + main);
  await h.api.checkAll();
  const updated = await h.api.saveBinding({...h.binding, ...rule});
  assert.equal(updated.series, rule.series);
  assert.equal(updated.lastSource, null);
  assert.equal(updated.pending, null);
  assert.equal(updated.choices.length, 0);
});

test('dismissed ambiguity stays dismissed and a changed set of candidates becomes actionable again', async () => {
  const h = host();
  await h.api.checkAll();
  h.api.dismissBanner();
  const dismissed = h.api.dismissedAlerts.get('rule');
  await h.api.checkAll();
  assert.equal(h.api.dismissedAlerts.get('rule'), dismissed);
  assert.equal(h.api.bannerAlerts()[0].token, dismissed);
  h.files.set('/drafts/Manuscript_supplement_v2_2026-11-13.pdf', {data: pdf('supplement'), mtime: Date.now() - 60000});
  await h.api.checkAll();
  assert.notEqual(h.api.bannerAlerts()[0].token, dismissed);
});
