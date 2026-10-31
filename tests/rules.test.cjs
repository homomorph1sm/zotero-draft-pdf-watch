const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = {console};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require('node:path').resolve(__dirname, '../content/core.js'), 'utf8'), context);
const api = context.DraftPDFWatch;
test('numeric version ordering and padding', () => {
  assert.ok(api.compareNames('paper_v10.pdf','paper_v2.pdf') > 0);
  assert.ok(api.compareNames('paper_v2.10.pdf','paper_v2.9.pdf') > 0);
  assert.equal(api.compareNames('paper_v002.pdf','paper_v2.pdf'), 0);
  assert.ok(api.compareNames('paper_2026-11-01.pdf','paper_2026-10-31.pdf') > 0);
  assert.ok(api.compareNames('v99999999999999999999.pdf','v9999999999999999999.pdf') > 0);
});
test('glob escapes special regex characters and matches whole filename', () => {
  const re = api.glob('draft (a)+[1]_v?.pdf');
  assert.ok(re.test('draft (a)+[1]_v2.pdf'));
  assert.ok(!re.test('draft aaaa1_v22.pdf'));
  assert.ok(!api.glob('paper_v*.pdf').test('other_paper_v1.pdf'));
  assert.ok(api.glob('paper_v*.pdf').test('PAPER_v10.PDF'));
  assert.throws(() => api.glob('../*.pdf'));
});
test('operation queue serializes writes and recovers after failure', async () => {
  const events = [];
  context.Zotero = { logError(){} };
  const a = api.serial(async()=>{events.push('start'); await new Promise(r=>setTimeout(r,5));events.push('end');throw Error('expected');});
  const b = api.serial(async()=>events.push('next'));
  await assert.rejects(a); await b;
  assert.deepEqual(events, ['start','end','next']);
});
