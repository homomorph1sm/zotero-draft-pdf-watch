const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const coreSource = fs.readFileSync(path.resolve(__dirname, '../content/core.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function host(entries = []) {
  const files = new Map(entries.map(entry => {
    const file = typeof entry === 'string' ? { name: entry } : entry;
    return ['/drafts/' + file.name, {
      type: file.type || 'regular', size: 100, lastModified: file.mtime || 1
    }];
  }));
  const metrics = { stats: [], directories: [], contentReads: 0, writes: 0, dialogs: [] };
  const context = vm.createContext({
    PathUtils: { isAbsolute: path.posix.isAbsolute, filename: path.posix.basename, parent: path.posix.dirname },
    IOUtils: {
      stat: async file => {
        metrics.stats.push(file);
        if (!files.has(file)) throw new Error('ENOENT');
        return files.get(file);
      },
      getChildren: async directory => {
        metrics.directories.push(directory);
        return [...files.keys()].filter(file => path.posix.dirname(file) === directory);
      },
      read: async () => { metrics.contentReads++; throw new Error('Do not read PDF contents'); },
      writeJSON: async () => { metrics.writes++; throw new Error('Do not change bindings'); }
    },
    Zotero: {
      getMainWindow: () => ({ openDialog: (...args) => {
        metrics.dialogs.push(args);
        return { closed: false, close() { this.closed = true; } };
      } })
    }
  });
  vm.runInContext(coreSource, context, { filename: 'core.js' });
  return { api: context.DraftPDFWatch, files, metrics };
}

test('a chosen versioned PDF generates a folder rule without changing a binding or reading content', async () => {
  const h = host(['Manuscript_v1.0.42_2026-10-31.pdf']);
  h.api.state.bindings = [{ id: 'existing-rule', attachmentKey: 'EXISTING', pattern: '*.pdf' }];
  const before = JSON.stringify(h.api.state);
  const rule = await h.api.ruleFromFile('/drafts/Manuscript_v1.0.42_2026-10-31.pdf');
  assert.deepEqual(plain(rule), {
    mode: 'folder', path: '/drafts', pattern: 'Manuscript_v*_????-??-??.pdf', order: 'version'
  });
  assert.equal(JSON.stringify(h.api.state), before);
  assert.equal(h.metrics.contentReads, 0);
  assert.equal(h.metrics.writes, 0);
  assert.equal(h.metrics.directories.length, 0, 'generation only examines the selected file');
});

test('generated body rule excludes supplements, conflict copies and other paper prefixes', async () => {
  const body = [
    'Manuscript_v1.0.9_2026-10-30.pdf',
    'Manuscript_v1.0.10_2026-10-31.pdf'
  ];
  const h = host([...body,
    'Manuscript_supplement_v1.0.99_2026-10-31.pdf',
    'Manuscript_v1.0.18_2026-10-11_DiskStation_Oct-11-1229-2026_RemoveLocalConflict.pdf',
    'OtherManuscript_v99_2026-10-31.pdf',
    'Manuscript_v2_2026-10-31.pdf.bak',
    { name: 'Manuscript_v99_2026-10-31.pdf', type: 'directory' }
  ]);
  const rule = await h.api.ruleFromFile('/drafts/' + body[0]);
  const candidates = await h.api.candidates(rule);
  assert.deepEqual(plain(candidates.map(file => file.name)), [body[1], body[0]]);
});

test('numeric version order beats a later modification time on an older version', async () => {
  const older = 'Manuscript_v1.0.9_2026-10-31.pdf';
  const newer = 'Manuscript_v1.0.10_2026-10-28.pdf';
  const h = host([{ name: older, mtime: 9000 }, { name: newer, mtime: 1000 }]);
  const rule = await h.api.ruleFromFile('/drafts/' + older);
  assert.ok(h.api.compareNames(newer, older) > 0);
  assert.equal((await h.api.candidates(rule))[0].name, newer);
});

test('equal version numbers are ordered by the date in the complete filename', async () => {
  const early = 'Manuscript_v1.0.10_2026-09-30.pdf';
  const late = 'Manuscript_v1.0.10_2026-10-01.pdf';
  const h = host([{ name: early, mtime: 9000 }, { name: late, mtime: 1000 }]);
  const rule = await h.api.ruleFromFile('/drafts/' + early);
  assert.deepEqual(plain((await h.api.candidates(rule)).map(file => file.name)), [late, early]);
});

test('literal punctuation in the paper prefix does not become regular-expression syntax', async () => {
  const chosen = 'Manuscript (review)+[1]_v1.2_2026-10-31.pdf';
  const next = 'Manuscript (review)+[1]_v1.3_2026-11-01.pdf';
  const h = host([chosen, next, 'Manuscript review111_v9_2026-11-01.pdf']);
  const rule = await h.api.ruleFromFile('/drafts/' + chosen);
  assert.deepEqual(plain((await h.api.candidates(rule)).map(file => file.name)), [next, chosen]);
});

test('unrecognized naming and wildcard prefixes require a manual rule instead of a broad fallback', async () => {
  const invalid = [
    'Manuscript.pdf',
    'Manuscript_v1.2.pdf',
    'Manuscript_v1..2_2026-10-31.pdf',
    'Manuscript_v1.2_2026-10-31_conflict.pdf',
    '_v1.2_2026-10-31.pdf',
    '   _v1.2_2026-10-31.pdf',
    'Manu*script_v1.2_2026-10-31.pdf',
    'Manu?script_v1.2_2026-10-31.pdf',
    'x'.repeat(200) + '_v1.2_2026-10-31.pdf'
  ];
  const h = host(invalid);
  for (const name of invalid) {
    await assert.rejects(h.api.ruleFromFile('/drafts/' + name), /手动填写/, name);
  }
  assert.equal(h.metrics.directories.length, 0);
  assert.equal(h.metrics.contentReads, 0);
  assert.equal(h.metrics.writes, 0);
});

test('relative paths, nonexistent files, directories and non-PDF files are rejected', async () => {
  const h = host([
    { name: 'Manuscript_v1.2_2026-10-31.pdf', type: 'directory' },
    'Manuscript_v1.2_2026-10-31.txt'
  ]);
  await assert.rejects(h.api.ruleFromFile('Manuscript_v1.2_2026-10-31.pdf'), /完整路径/);
  await assert.rejects(h.api.ruleFromFile(null), /完整路径/);
  await assert.rejects(h.api.ruleFromFile('/drafts/missing.pdf'), /文件存在/);
  await assert.rejects(h.api.ruleFromFile('/drafts/Manuscript_v1.2_2026-10-31.pdf'), /PDF 文件/);
  await assert.rejects(h.api.ruleFromFile('/drafts/Manuscript_v1.2_2026-10-31.txt'), /PDF 文件/);
  assert.equal(h.metrics.contentReads, 0);
});

test('manager URL varies with the plugin version and encodes that version', () => {
  const h = host();
  h.api.version = '0.1.4+test';
  h.api.open(7);
  assert.equal(h.metrics.dialogs[0][0], 'chrome://draftwatch/content/manager.xhtml?v=0.1.4%2Btest');
  assert.equal(h.metrics.dialogs[0][3].parentID, 7);
  const previousManager = h.api.manager;
  h.api.version = '0.1.5';
  h.api.open();
  assert.equal(previousManager.closed, true);
  assert.equal(h.metrics.dialogs[1][0], 'chrome://draftwatch/content/manager.xhtml?v=0.1.5');
});
