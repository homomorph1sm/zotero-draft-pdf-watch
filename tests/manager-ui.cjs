// Headless regression checks of the actual XHTML/JS/CSS, with synthetic APIs.
// Requires Playwright; no screenshots, desktop interaction, or Zotero data.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const managerURL = pathToFileURL(process.env.MANAGER_FILE || path.resolve(__dirname, '../content/manager.xhtml')).href;
const solePDF = [{ key: 'CURRENT1', filename: 'paper_v2.pdf' }];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  let passed = 0;
  const failures = [];

  async function fixture(attachments = solePDF, viewport = { width: 850, height: 540 }) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.addInitScript(({ attachments }) => {
      window.confirm = () => true;
      const clone = value => JSON.parse(JSON.stringify(value));
      const state = window.testState = {
        saved: [], attempts: [], callbacks: [], attachmentWrites: 0, checks: 0,
        saveError: null, pickedPath: null, previewed: [],
        parent: {
          parentID: 23,
          title: 'A long manuscript title for testing attachment repair and notification layout in a small window',
          attachments,
        },
        bindings: [{
          id: 'rule-a', parentID: 23, title: 'A manuscript', attachmentKey: 'MISSING1',
          mode: 'folder', path: 'C:\\Drafts', pattern: 'paper_v*.pdf', order: 'version',
          automatic: false, enabled: true, status: 'error', pending: null,
          error: '原绑定附件已在回收站中。请选择当前 PDF 后保存。', errorCode: 'attachment-invalid',
        }],
      };
      state.emit = () => { for (const callback of state.callbacks) callback(); };
      const api = {
        version: 'test',
        listBindings: async () => clone(state.bindings),
        getParent: async () => clone(state.parent),
        selection: async () => clone(state.parent),
        preview: async config => { state.previewed.push(clone(config)); return []; },
        checkAll: async () => { state.checks++; },
        pickPath: async () => state.pickedPath,
        ruleFromFile: async file => {
          if (file !== 'C:\\New drafts\\paper_v12.pdf') throw new Error('Unexpected fixture path');
          return { mode: 'folder', path: 'C:\\New drafts', pattern: 'paper_v*.pdf', order: 'version' };
        },
        saveBinding: async config => {
          state.attempts.push(clone(config));
          if (state.saveError) throw new Error(state.saveError);
          const live = state.parent.attachments.some(item => item.key === config.attachmentKey);
          if (state.parent.attachments.length && !config.attachmentKey) throw new Error('请选择要替换的 PDF 附件');
          const error = config.attachmentKey && !live ? '原绑定附件已在回收站中。请选择当前 PDF 后保存。' : null;
          const binding = {
            ...clone(config), id: config.id || 'rule-a', title: state.parent.title,
            error, errorCode: error ? 'attachment-invalid' : null, status: 'waiting', pending: null,
          };
          state.bindings = [binding];
          state.saved.push(clone(config));
          state.emit();
          return clone(binding);
        },
        setEnabled: async (_id, enabled) => { state.bindings[0].enabled = enabled; },
        removeBinding: async () => { state.bindings = []; },
        update: async () => { state.attachmentWrites++; },
        subscribe: callback => {
          state.callbacks.push(callback);
          return () => { state.callbacks = state.callbacks.filter(item => item !== callback); };
        },
      };
      window.arguments = [{ api }];
    }, { attachments });
    await page.goto(managerURL);
    await page.locator('#editor').waitFor({ state: 'visible' });
    return { page, errors };
  }

  const edit = async (page, id, value, type = 'input') => page.locator(id).evaluate((element, args) => {
    element.value = args.value;
    element.dispatchEvent(new Event(args.type, { bubbles: true }));
  }, { value, type });
  // Playwright's inputValue() assumes HTML node-name casing; this page is XHTML.
  const value = (page, id) => page.locator(id).evaluate(element => element.value);
  const message = page => page.locator('#notice-message').textContent();
  async function click(page, id) {
    await page.locator(id).click();
    await page.waitForFunction(() => !document.getElementById('check-all').disabled);
  }
  async function visibleInViewport(page, id) {
    assert.equal(await page.locator(id).isVisible(), true, `${id} is visible`);
    const box = await page.locator(id).boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box && box.width > 0 && box.height > 0, `${id} has dimensions`);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1, `${id} stays inside ${viewport.width}x${viewport.height}`);
  }
  async function run(name, fn, attachments, viewport) {
    let context;
    try {
      context = await fixture(attachments, viewport);
      await fn(context.page);
      assert.deepEqual(context.errors, [], 'the page has no uncaught errors');
      assert.equal(await context.page.evaluate(() => testState.attachmentWrites), 0, 'repair and dismissal never replace attachments');
      passed++;
      console.log(`PASS: ${name}`);
    } catch (error) {
      failures.push({ name, error: error.stack || String(error) });
      console.error(`FAIL: ${name}\n${error.stack || error}`);
    } finally {
      if (context) await context.page.close();
    }
  }

  try {
    await run('manager notice closes without submitting, discarding edits, or pausing monitoring', async page => {
      await edit(page, '#path', 'C:\\Changed drafts');
      await edit(page, '#pattern', 'revision*.pdf');
      await click(page, '#repair-attachment');
      assert.equal(await page.locator('#notice-close').count(), 1, 'a close button exists in the actual manager page');
      assert.match(await page.locator('#notice-close').getAttribute('aria-label'), /关闭/);
      await visibleInViewport(page, '#notice-close');
      const before = await page.evaluate(() => JSON.stringify({
        bindings: testState.bindings, saved: testState.saved, attempts: testState.attempts,
      }));
      await click(page, '#notice-close');
      assert.equal(await page.locator('#notice').isVisible(), false);
      assert.equal(await value(page, '#path'), 'C:\\Changed drafts');
      assert.equal(await value(page, '#pattern'), 'revision*.pdf');
      assert.equal(await value(page, '#attachment'), 'CURRENT1');
      assert.equal(await page.evaluate(() => JSON.stringify({
        bindings: testState.bindings, saved: testState.saved, attempts: testState.attempts,
      })), before);
      await page.evaluate(async () => { testState.emit(); await new Promise(resolve => setTimeout(resolve, 0)); });
      assert.equal(await page.locator('#notice').isVisible(), false, 'background refresh does not restore dismissed notice');
      assert.equal(await value(page, '#attachment'), 'CURRENT1', 'background refresh preserves the unsaved selection');
      assert.equal(await value(page, '#path'), 'C:\\Changed drafts');
      assert.match(await page.locator('#rule-status').textContent(), /待保存/);
      assert.equal(await page.locator('#save-attachment').isVisible(), true);
      await click(page, '#repair-attachment');
      assert.equal(await page.locator('#notice').isVisible(), true, 'a subsequent action may show a new notice');
    });

    await run('repeated repair cannot call an unsaved replacement an already valid binding', async page => {
      await click(page, '#repair-attachment');
      assert.equal(await value(page, '#attachment'), 'CURRENT1');
      await click(page, '#repair-attachment');
      const notice = await message(page);
      assert.doesNotMatch(notice, /当前绑定仍有效|绑定已修复|修复完成/);
      assert.match(notice, /保存/);
      assert.match(await page.locator('#rule-status').textContent(), /待保存/);
      assert.match(await page.locator('#rule-summary').textContent(), /保存/);
      assert.equal(await page.locator('#save-attachment').isVisible(), true);
      assert.equal(await page.evaluate(() => testState.bindings[0].attachmentKey), 'MISSING1');
      assert.equal(await page.evaluate(() => testState.saved.length), 0);
    });

    await run('nearby explicit repair save preserves edited rules and clears the old saved error', async page => {
      await edit(page, '#path', 'C:\\Revised drafts');
      await edit(page, '#pattern', 'revision_v*.pdf');
      await click(page, '#repair-attachment');
      await click(page, '#save-attachment');
      assert.equal(await page.evaluate(() => testState.saved.length), 1);
      assert.deepEqual(await page.evaluate(() => {
        const saved = testState.saved[0];
        return { key: saved.attachmentKey, path: saved.path, pattern: saved.pattern };
      }), { key: 'CURRENT1', path: 'C:\\Revised drafts', pattern: 'revision_v*.pdf' });
      assert.equal(await page.locator('#rule-error').isVisible(), false);
      assert.equal(await page.locator('#save-attachment').isVisible(), false);
      assert.doesNotMatch(await page.locator('#rule-status').textContent(), /待保存|需处理/);
      assert.equal(await page.locator('#notice').evaluate(el => el.classList.contains('error')), false);
      assert.equal(await page.locator('#notice').evaluate(el => el.classList.contains('pending')), false);
      await click(page, '#notice-close');
      assert.equal(await page.locator('#notice').isVisible(), false, 'the success notice also closes');
      assert.equal(await page.evaluate(() => testState.saved.length), 1);
      await click(page, '#repair-attachment');
      assert.doesNotMatch(await message(page), /尚未保存|还未保存/);
    });

    await run('save failure remains actionable and its red notice closes with Enter', async page => {
      await click(page, '#repair-attachment');
      await page.evaluate(() => { testState.saveError = '模拟：规则文件写入失败'; });
      await click(page, '#save-attachment');
      assert.match(await message(page), /规则文件写入失败/);
      assert.equal(await page.locator('#notice').evaluate(el => el.classList.contains('error')), true);
      assert.equal(await page.evaluate(() => testState.bindings[0].attachmentKey), 'MISSING1');
      assert.equal(await page.locator('#save-attachment').isVisible(), true);
      assert.match(await page.locator('#rule-status').textContent(), /待保存/);
      await page.locator('#notice-close').focus();
      await page.locator('#notice-close').press('Enter');
      assert.equal(await page.locator('#notice').isVisible(), false);
      assert.equal(await page.evaluate(() => testState.attempts.length), 1, 'closing does not resubmit');
      await page.evaluate(() => { testState.saveError = null; });
      await click(page, '#save-attachment');
      assert.equal(await page.evaluate(() => testState.bindings[0].attachmentKey), 'CURRENT1');
      assert.equal(await page.locator('#rule-error').isVisible(), false);
    });

    await run('multiple PDFs require a deliberate selection before saving', async page => {
      await click(page, '#repair-attachment');
      assert.equal(await value(page, '#attachment'), '');
      await click(page, '#save-rule');
      assert.match(await message(page), /请选择/);
      assert.equal(await page.evaluate(() => testState.saved.length), 0);
      await edit(page, '#attachment', 'PDF00002', 'change');
      await click(page, '#save-attachment');
      assert.equal(await page.evaluate(() => testState.saved[0].attachmentKey), 'PDF00002');
      assert.equal(await page.locator('#rule-error').isVisible(), false);
    }, [{ key: 'PDF00001', filename: 'paper_v1.pdf' }, { key: 'PDF00002', filename: 'paper_v2.pdf' }]);

    await run('no remaining PDF supports explicit clearing without an implicit save', async page => {
      assert.equal(await value(page, '#attachment'), 'MISSING1');
      await click(page, '#repair-attachment');
      assert.equal(await value(page, '#attachment'), '');
      assert.equal(await page.evaluate(() => testState.saved.length), 0);
      assert.equal(await page.locator('#save-attachment').isVisible(), true);
      await click(page, '#save-attachment');
      assert.equal(await page.evaluate(() => testState.saved[0].attachmentKey), '');
      assert.equal(await page.locator('#rule-error').isVisible(), false);
    }, []);

    await run('selecting a source PDF fills a previewed rule without saving or changing attachment choice', async page => {
      await click(page, '#repair-attachment');
      await page.evaluate(() => { testState.pickedPath = 'C:\\New drafts\\paper_v12.pdf'; });
      await click(page, '#derive-rule');
      assert.equal(await value(page, '#mode'), 'folder');
      assert.equal(await value(page, '#path'), 'C:\\New drafts');
      assert.equal(await value(page, '#pattern'), 'paper_v*.pdf');
      assert.equal(await value(page, '#order'), 'version');
      assert.equal(await value(page, '#attachment'), 'CURRENT1');
      assert.equal(await page.locator('#preview-panel').isVisible(), true);
      assert.equal(await page.evaluate(() => testState.saved.length), 0);
      assert.deepEqual(await page.evaluate(() => {
        const preview = testState.previewed.at(-1);
        return { path: preview.path, pattern: preview.pattern, attachmentKey: preview.attachmentKey };
      }), { path: 'C:\\New drafts', pattern: 'paper_v*.pdf', attachmentKey: 'CURRENT1' });
      assert.match(await message(page), /保存/);
      await click(page, '#notice-close');
      assert.equal(await page.locator('#notice').isVisible(), false);
      assert.equal(await value(page, '#path'), 'C:\\New drafts');
      await page.evaluate(() => { testState.pickedPath = null; });
      await click(page, '#derive-rule');
      assert.equal(await value(page, '#path'), 'C:\\New drafts', 'cancelling file selection preserves existing edits');
      assert.equal(await page.evaluate(() => testState.previewed.length), 1);
    });

    for (const viewport of [{ width: 850, height: 540 }, { width: 1024, height: 630 }]) {
      await run(`close and footer remain visible at ${viewport.width}x${viewport.height}`, async page => {
        await click(page, '#repair-attachment');
        for (const id of ['#notice-close', '#save-rule', '#toggle-rule', '#remove-rule']) {
          await visibleInViewport(page, id);
        }
        await page.locator('.detail').evaluate(el => { el.scrollTop = el.scrollHeight; });
        await visibleInViewport(page, '#notice-close');
        await visibleInViewport(page, '#save-rule');
      }, solePDF, viewport);
    }
  } finally {
    await browser.close();
  }
  console.log(`Manager UI: ${passed} passed, ${failures.length} failed. Headless synthetic fixtures only; no screenshots or desktop control.`);
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
