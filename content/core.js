/* Original implementation; integrates with the Zotero 10 plugin APIs. */
var DraftPDFWatch = {
  state: { schema: 1, bindings: [], journal: null },
  listeners: new Set(), menus: [], observations: new Map(), notices: new Map(),
  dismissedAlerts: new Map(),
  dismissalPref: 'extensions.draftpdfwatch.dismissedAlerts',
  tail: Promise.resolve(), stopped: false, manager: null,
  serial(fn) {
    const task = this.tail.then(async () => {
      if (this.stopped) throw new Error('插件已停止');
      if (this.state.journal) await this.recover();
      return fn();
    });
    this.tail = task.catch(e => Zotero.logError(e));
    return task;
  },
  async init(pluginID, version) {
    this.pluginID = pluginID;
    this.version = version || '';
    this.loadBannerDismissals();
    this.statePath = PathUtils.join(Services.dirsvc.get('ProfD', Ci.nsIFile).path, 'draft-pdf-watch.json');
    if (await IOUtils.exists(this.statePath)) {
      this.state = await IOUtils.readJSON(this.statePath);
      if (this.state.schema !== 1 || !Array.isArray(this.state.bindings)) throw new Error('论文监控配置格式不受支持');
    }
    try { await this.recover(); } catch(e) { Zotero.logError(e); const b = this.state.bindings.find(b => b.id === this.state.journal?.bindingID); if (b) b.error = String(e); }
    for (const target of ['main/menubar/tools', 'main/library/item']) {
      this.menus.push(Zotero.MenuManager.registerMenu({
        menuID: 'draftwatch-' + target.split('/').pop(), pluginID, target,
        menus: [{menuType: 'menuitem', l10nID: target.endsWith('/item') ? 'draftwatch-bind' : 'draftwatch-manage',
          onShowing: (_e, context) => { if (target.endsWith('/item')) context.setVisible(context.items?.length === 1 && (context.items[0].isRegularItem() || context.items[0].parentItemID)); },
          onCommand: (_e, context) => this.open(target.endsWith('/item') ? (context.items?.[0]?.parentItemID || context.items?.[0]?.id) : null)
        }]
      }));
    }
    this.timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
    this.timer.initWithCallback(() => this.checkAll().catch(e => Zotero.logError(e)), 15000, Ci.nsITimer.TYPE_REPEATING_SLACK);
    await this.checkAll().catch(e => Zotero.logError(e));
    this.emit();
  },
  async shutdown() {
    this.stopped = true;
    this.timer?.cancel();
    await this.tail;
    this.manager?.close();
    for (const id of this.menus) Zotero.MenuManager.unregisterMenu(id);
    for (const win of Zotero.getMainWindows()) win.document.getElementById('draftwatch-banner')?.remove();
    this.listeners.clear();
  },
  async persist() { await IOUtils.writeJSON(this.statePath, this.state, { tmpPath: this.statePath + '.tmp' }); },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  loadBannerDismissals() {
    try {
      const entries = JSON.parse(Zotero.Prefs.get(this.dismissalPref, true) || '[]');
      this.dismissedAlerts = new Map(Array.isArray(entries) ? entries.filter(e => Array.isArray(e) && e.length === 2 && e.every(v => typeof v === 'string')) : []);
    } catch(e) { Zotero.logError(e); this.dismissedAlerts = new Map(); }
  },
  saveBannerDismissals() {
    // Preferences are independent of attachment transactions: a failed recovery
    // must never prevent dismissing a notification.
    try { Zotero.Prefs.set(this.dismissalPref, JSON.stringify([...this.dismissedAlerts]), true); }
    catch(e) { Zotero.logError(e); }
  },
  bannerAlerts() {
    return this.state.bindings.filter(b => b.enabled && (b.error || b.pending)).map(b => ({
      id: b.id,
      kind: b.error ? 'error' : 'pending',
      token: JSON.stringify(b.error ? ['error', b.errorCode || '', b.error] : ['pending', b.pending.path, b.pending.hash])
    }));
  },
  dismissBanner() {
    for (const alert of this.bannerAlerts()) this.dismissedAlerts.set(alert.id, alert.token);
    this.saveBannerDismissals();
    this.emit();
  },
  emit() {
    let changed = false;
    for (const id of this.dismissedAlerts.keys()) {
      const b = this.state.bindings.find(b => b.id === id);
      // On restart an unchanged PDF first goes through the stability check.
      // Keep its dismissal until the check finishes, rather than flashing again.
      if (!b || !b.enabled || (!b.error && !b.pending && b.status !== 'stabilizing')) {
        this.dismissedAlerts.delete(id); changed = true;
      }
    }
    if (changed) this.saveBannerDismissals();
    const alerts = this.bannerAlerts().filter(a => this.dismissedAlerts.get(a.id) !== a.token);
    const pending = alerts.filter(a => a.kind === 'pending').length;
    const errors = alerts.filter(a => a.kind === 'error').length;
    for (const win of Zotero.getMainWindows()) {
      const doc = win.document;
      let banner = doc.getElementById('draftwatch-banner');
      if (!pending && !errors) { banner?.remove(); continue; }
      if (!banner) {
        banner = doc.createXULElement('hbox'); banner.id = 'draftwatch-banner';
        banner.setAttribute('align', 'center');
        banner.style.cssText = 'background:#ffdf78;color:#2e2400;padding:4px 8px;';
        const open = doc.createXULElement('button'); open.id = 'draftwatch-banner-open';
        open.setAttribute('flex', '1');
        open.setAttribute('crop', 'end');
        open.style.cssText = 'appearance:none;background:transparent;color:inherit;border:0;box-shadow:none;min-width:0;margin:0;padding:6px;text-align:left;font-weight:bold;';
        open.addEventListener('command', () => this.open());
        const close = doc.createXULElement('button'); close.id = 'draftwatch-banner-close';
        close.label = '×';
        close.setAttribute('aria-label', '关闭此提醒');
        close.setAttribute('tooltiptext', '关闭此提醒；监控继续，有新情况时再提示');
        close.style.cssText = 'appearance:none;background:transparent;color:inherit;border:1px solid #b69230;border-radius:4px;min-width:30px;margin:0 0 0 8px;padding:2px 8px;font-size:20px;font-weight:bold;';
        close.addEventListener('command', event => { event.stopPropagation(); this.dismissBanner(); });
        banner.append(open, close);
        doc.getElementById('zotero-pane')?.prepend(banner);
      }
      doc.getElementById('draftwatch-banner-open').label = `论文 PDF 版本监控：${pending} 个新版待更新，${errors} 个规则需处理 · 点击查看`;
    }
    for (const fn of this.listeners) { try { fn(); } catch (e) { Zotero.logError(e); } }
  },
  open(parentID = null) {
    if (this.manager && !this.manager.closed) { this.manager.close(); }
    this.manager = Zotero.getMainWindow().openDialog('chrome://draftwatch/content/manager.xhtml?v=' + encodeURIComponent(this.version || ''), 'draft-pdf-watch', 'chrome,centerscreen,resizable,width=1060,height=780', { api: this, parentID });
  },
  async getParent(parentID) {
    const parent = await Zotero.Items.getAsync(Number(parentID));
    if (!parent || !parent.isRegularItem() || parent.deleted) throw new Error('请选择一个未删除的文献父条目');
    const lib = Zotero.Libraries.get(parent.libraryID);
    if (!lib.editable || !lib.filesEditable) throw new Error('此文库没有附件写入权限');
    return {parentID: parent.id, title: parent.getField('title') || '(无标题)', libraryID: parent.libraryID, parentKey: parent.key,
      attachments: (await Zotero.Items.getAsync(parent.getAttachments())).filter(a => !a.deleted && a.attachmentContentType === 'application/pdf').map(a => ({key: a.key, title: a.getField('title'), filename: a.attachmentFilename || ''}))};
  },
  async selection() {
    const items = Zotero.getActiveZoteroPane()?.getSelectedItems();
    if (items?.length !== 1) return null;
    return this.getParent(items[0].parentItemID || items[0].id);
  },
  async pickPath(mode, win) {
    const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
    const fp = new FilePicker();
    fp.init(win, mode === 'folder' ? '选择论文版本文件夹' : '选择论文 PDF', mode === 'folder' ? fp.modeGetFolder : fp.modeOpen);
    if (mode !== 'folder') fp.appendFilter('PDF', '*.pdf');
    return (await fp.show()) === fp.returnOK ? fp.file : null;
  },
  async ruleFromFile(filePath) {
    if (typeof filePath !== 'string' || !filePath || !PathUtils.isAbsolute(filePath)) {
      throw new Error('请选择 PDF 文件的完整路径。');
    }
    let file;
    try { file = await IOUtils.stat(filePath); }
    catch (_error) { throw new Error('无法读取所选文件的信息，请确认文件存在且可以访问。'); }
    const name = PathUtils.filename(filePath);
    if (file.type !== 'regular' || !/\.pdf$/i.test(name)) throw new Error('请选择一个已存在的 PDF 文件。');
    const match = /^(.*)_v(\d+(?:\.\d+)*)_(\d{4}-\d{2}-\d{2})\.pdf$/.exec(name);
    if (!match || !match[1].trim() || /[*?]/.test(match[1])) {
      throw new Error('无法自动识别此文件的版本命名。请使用“论文前缀_v1.0.2_2026-10-31.pdf”格式，或手动填写文件夹与匹配规则。');
    }
    const pattern = match[1] + '_v*_????-??-??.pdf';
    if (pattern.length > 200) throw new Error('文件名前缀过长，无法自动生成匹配规则，请手动填写。');
    return {mode: 'folder', path: PathUtils.parent(filePath), pattern, order: 'version'};
  },
  glob(pattern) {
    if (!pattern || pattern.length > 200 || /[\\/]/.test(pattern)) throw new Error('匹配规则只填写文件名，例如 paper_v*.pdf');
    return new RegExp('^' + [...pattern].map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'i');
  },
  compareNames(a, b) {
    const aa = a.toLowerCase().match(/\d+|\D+/g) || [], bb = b.toLowerCase().match(/\d+|\D+/g) || [];
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
      if (aa[i] === bb[i]) continue;
      if (/^\d+$/.test(aa[i]) && /^\d+$/.test(bb[i])) { const x = BigInt(aa[i]), y = BigInt(bb[i]); if (x !== y) return x > y ? 1 : -1; }
      else return aa[i] > bb[i] ? 1 : -1;
    }
    return aa.length - bb.length;
  },
  validateSource(config) {
    if (!['file', 'folder'].includes(config.mode) || !['version', 'mtime'].includes(config.order)) throw new Error('无效的监控类型或排序');
    if (!config.path || !PathUtils.isAbsolute(config.path)) throw new Error('请选择完整的绝对路径');
    return this.glob(config.pattern || '*.pdf');
  },
  async candidates(config) {
    const match = this.validateSource(config);
    const paths = config.mode === 'file' ? [config.path] : await IOUtils.getChildren(config.path);
    const files = [];
    for (const path of paths) {
      const name = PathUtils.filename(path);
      if (!/\.pdf$/i.test(name) || (config.mode === 'folder' && !match.test(name))) continue;
      const st = await IOUtils.stat(path);
      if (st.type === 'regular') files.push({path, name, size: st.size, mtime: st.lastModified});
    }
    files.sort((a,b) => config.order === 'version'
      ? this.compareNames(b.name, a.name) || b.mtime - a.mtime || b.path.localeCompare(a.path)
      : b.mtime - a.mtime || this.compareNames(b.name, a.name) || b.path.localeCompare(a.path));
    return files;
  },
  async preview(config) { return (await this.candidates(config)).slice(0,20); },
  async fingerprint(file) {
    const before = await IOUtils.stat(file.path);
    if (before.size < 20 || before.size > 268435456) throw new Error('PDF 为空、尚未写完或超过 256 MB');
    const head = await IOUtils.read(file.path, {maxBytes: 1024});
    const tail = await IOUtils.read(file.path, {offset: Math.max(0, before.size - 4096), maxBytes: 4096});
    const ascii = b => Array.from(b, x => String.fromCharCode(x)).join('');
    if (!ascii(head).includes('%PDF-') || !ascii(tail).includes('%%EOF')) throw new Error('文件尚未写完，或不是完整的 PDF（缺少 PDF 头/EOF）');
    const hash = await Zotero.Utilities.Internal.md5Async(file.path);
    const after = await IOUtils.stat(file.path);
    if (!hash || before.size !== after.size || before.lastModified !== after.lastModified) throw new Error('PDF 正在变化，等待下一次检查');
    return {...file, size: after.size, mtime: after.lastModified, hash};
  },
  async listBindings() {
    return this.state.bindings.map(b => ({...b, status: !b.enabled ? 'paused' : b.error ? 'error' : b.pending ? 'pending' : b.status || 'ready'}));
  },
  saveBinding(config) { return this.serial(async () => {
    config = {...config, path: String(config.path || '').trim()};
    this.validateSource(config);
    const info = await this.getParent(config.parentID);
    const current = config.id && this.state.bindings.find(b => b.id === config.id);
    if (config.id && !current) throw new Error('该监控规则已不存在，请刷新面板');
    if (current && (current.libraryID !== info.libraryID || current.parentKey !== info.parentKey)) throw new Error('不能通过编辑规则更换父条目，请为新条目单独建立规则');
    if (this.state.bindings.some(b => b.id !== config.id && b.libraryID === info.libraryID && b.parentKey === info.parentKey)) throw new Error('此条目已经有监控规则，请编辑已有规则');
    if (info.attachments.length && !config.attachmentKey) throw new Error('请选择要替换的 PDF 附件');
    const invalidKey = config.attachmentKey && !info.attachments.some(a => a.key === config.attachmentKey);
    // An obsolete binding must not trap the user in an uneditable form. Keep
    // its identity when saving other fields; only an explicit new selection
    // changes which attachment we are allowed to replace.
    if (invalidKey && (!current || config.attachmentKey !== current.attachmentKey)) throw new Error('所选附件已不在此条目下，请刷新附件列表后重新选择');
    let sourceError = null;
    try { await this.candidates(config); } catch(e) { sourceError = String(e.message || e); }
    const binding = { id: current?.id || Zotero.Utilities.randomString(12), parentID: info.parentID, parentKey: info.parentKey, libraryID: info.libraryID,
      title: info.title, attachmentKey: config.attachmentKey || null, mode: config.mode, path: config.path.trim(), pattern: config.pattern || '*.pdf', order: config.order,
      automatic: !!config.automatic, enabled: config.enabled !== false, lastHash: current?.lastHash || null, lastSource: current?.lastSource || null,
      lastUpdated: current?.lastUpdated || null, status: 'waiting', pending: null,
      error: invalidKey ? '原附件绑定已失效；请点击「刷新附件列表 / 修复绑定」，选择当前 PDF 后保存。目录与其他规则仍可修改。' : sourceError,
      errorCode: invalidKey ? 'attachment-invalid' : sourceError ? 'source-unavailable' : null };
    if (current && ['mode', 'path', 'pattern', 'order'].some(k => current[k] !== binding[k])) binding.lastSource = null;
    if (!invalidKey && (current?.attachmentKey !== binding.attachmentKey || !binding.lastHash)) {
      const att = binding.attachmentKey && await Zotero.Items.getByLibraryAndKeyAsync(binding.libraryID, binding.attachmentKey);
      const path = att && await att.getFilePathAsync();
      binding.lastHash = path && await IOUtils.exists(path) ? await Zotero.Utilities.Internal.md5Async(path) : null;
      binding.lastSource = null;
      if (!current && att && binding.mode === 'folder' && binding.order === 'version' && this.glob(binding.pattern).test(att.attachmentFilename || '')) {
        binding.lastSource = {path: path || '', name: att.attachmentFilename, mtime: 0};
      }
    }
    const previous = this.state.bindings;
    this.state.bindings = [...previous.filter(b => b.id !== binding.id), binding];
    try { await this.persist(); } catch (e) { this.state.bindings = previous; throw e; }
    this.observations.delete(binding.id); this.notices.delete(binding.id);
    this.emit(); return binding;
  }); },
  removeBinding(id) { return this.serial(async () => {
    const old = this.state.bindings; this.state.bindings = old.filter(b => b.id !== id);
    try { await this.persist(); } catch(e) { this.state.bindings = old; throw e; }
    this.observations.delete(id); this.notices.delete(id); this.emit();
  }); },
  setEnabled(id, enabled) { return this.serial(async () => {
    const b = this.binding(id), before = b.enabled; b.enabled = !!enabled;
    try { await this.persist(); } catch(e) { b.enabled = before; throw e; }
    this.emit();
  }); },
  binding(id) { const b = this.state.bindings.find(b => b.id === id); if (!b) throw new Error('监控规则不存在'); return b; },
  async validateTarget(b) {
    const parent = await Zotero.Items.getByLibraryAndKeyAsync(b.libraryID, b.parentKey);
    if (!parent || parent.deleted || !parent.isRegularItem()) throw new Error('父条目已删除或不存在，监控已停止写入');
    await this.getParent(parent.id);
    const old = b.attachmentKey && await Zotero.Items.getByLibraryAndKeyAsync(b.libraryID, b.attachmentKey);
    if (b.attachmentKey && (!old || old.deleted || old.parentItemID !== parent.id || old.attachmentContentType !== 'application/pdf')) {
      const reason = !old ? '原绑定附件已不存在' : old.deleted ? '原绑定附件已在回收站中' : old.parentItemID !== parent.id ? '原绑定附件已不属于此条目' : '原绑定附件不再是 PDF';
      const error = new Error(reason + '。请点击「刷新附件列表 / 修复绑定」，选择当前 PDF 后保存；目录与其他规则仍可修改。');
      error.code = 'attachment-invalid'; throw error;
    }
    return {parent, old};
  },
  checkAll() {
    if (this.scanTask) return this.scanTask;
    const task = this.serial(async () => {
    if (this.state.journal) await this.recover();
    for (const b of this.state.bindings) {
      if (!b.enabled) continue;
      try {
        await this.scan(b);
        if (b.automatic && b.pending) await this.replace(b);
      } catch(e) {
        b.error = String(e.message || e); b.errorCode = e.code || null; b.pending = null; this.notify(b, '监控需要处理：' + b.error);
        if (this.state.journal) { await this.persist(); this.emit(); throw e; }
      }
    }
    await this.persist(); this.emit();
    });
    this.scanTask = task;
    task.finally(() => { this.scanTask = null; }).catch(() => {});
    return task;
  },
  async scan(b) {
    await this.validateTarget(b);
    const candidate = (await this.candidates(b))[0];
    b.error = null; b.errorCode = null;
    if (!candidate) { b.pending = null; b.status = 'waiting'; this.observations.delete(b.id); return; }
    // Never silently downgrade when the newest source disappears.
    if (b.mode === 'folder' && b.lastSource && candidate.path !== b.lastSource.path) {
      const older = b.order === 'version' ? this.compareNames(candidate.name, b.lastSource.name) < 0 : candidate.mtime <= b.lastSource.mtime;
      if (older) { b.pending = null; b.status = 'older'; return; }
    }
    const signature = `${candidate.path}|${candidate.size}|${candidate.mtime}`;
    const seen = this.observations.get(b.id);
    if (!seen || seen.signature !== signature) { this.observations.set(b.id, {signature, since: Date.now()}); b.pending = null; b.status = 'stabilizing'; return; }
    if (Date.now() - seen.since < 3000 || Date.now() - candidate.mtime < 3000) { b.pending = null; b.status = 'stabilizing'; return; }
    let fp = seen.fp;
    if (!fp || Date.now() - seen.verifiedAt > 120000) {
      fp = await this.fingerprint(candidate);
      seen.fp = fp; seen.verifiedAt = Date.now();
    }
    if (fp.hash === b.lastHash) { b.pending = null; b.status = 'ready'; b.lastSource = fp; return; }
    b.pending = fp; b.status = 'pending';
    if (!b.automatic) this.notify(b, '发现新版：' + fp.name + '。点击打开监控面板，一键更新附件。');
  },
  notify(b, message) {
    if (this.notices.get(b.id) === message) return;
    this.notices.set(b.id, message);
    try {
      const alerts = Cc['@mozilla.org/alerts-service;1'].getService(Ci.nsIAlertsService);
      alerts.showAlertNotification('', '论文 PDF · ' + b.title.slice(0,65), message, true, b.id, { observe: (_s, topic) => { if (topic === 'alertclickcallback' && !this.stopped) this.open(); } });
    } catch(e) { Zotero.debug('Draft PDF Watch notification: ' + e); }
  },
  update(id) { return this.serial(async () => { const b = this.binding(id); await this.replace(b); this.emit(); }); },
  async replace(b) {
    if (this.state.journal) throw new Error('上次替换尚待恢复，暂不开始另一项替换');
    if (!b.enabled) throw new Error('请先启用此监控规则');
    if (!b.pending) throw new Error('没有已就绪的新版本，请检查并等待文件写入稳定');
    const {parent, old} = await this.validateTarget(b);
    const wasOpen = !!old && Zotero.Reader._readers.some(r => r.itemID === old.id);
    const latest = (await this.candidates(b))[0];
    if (!latest || latest.path !== b.pending.path) throw new Error('候选版本已改变，请重新检查');
    const fp = await this.fingerprint(latest);
    if (fp.hash !== b.pending.hash) { b.pending = null; throw new Error('候选 PDF 内容已变化，请重新检查'); }
    const marker = 'DraftWatch pending ' + Zotero.Utilities.randomString(16);
    this.state.journal = {bindingID: b.id, parentKey: b.parentKey, libraryID: b.libraryID, oldKey: b.attachmentKey, newKey: null, marker, source: fp,
      previous: {attachmentKey: b.attachmentKey, lastHash: b.lastHash, lastSource: b.lastSource, lastUpdated: b.lastUpdated}};
    await this.persist();
    let fresh;
    try {
      fresh = await Zotero.Attachments.importFromFile({file: fp.path, parentItemID: parent.id, title: marker, contentType: 'application/pdf'});
      this.state.journal.newKey = fresh.key;
      await this.persist();
      const copied = await Zotero.Utilities.Internal.md5Async(await fresh.getFilePathAsync());
      if (copied !== fp.hash) throw new Error('导入副本校验失败，旧附件已保留');
      await Zotero.DB.executeTransaction(async () => {
        fresh.setField('title', fp.name); await fresh.save();
        if (old) await Zotero.Items.trash([old.id]);
      });
      await this.finish(b, fresh, fp);
    } catch(e) {
      // Reconcile committed DB changes before deciding whether to discard the new copy.
      await this.recover();
      throw e;
    }
    this.notify(b, '已更新为 ' + fp.name + '；旧附件及其批注已移至回收站。');
    if (wasOpen) {
      try { await Zotero.Reader.open(fresh.id); }
      catch(e) { Zotero.logError(e); /* Replacement succeeded; opening the reader is optional. */ }
    }
  },
  async finish(b, fresh, fp) {
    b.attachmentKey = fresh.key; b.lastHash = fp.hash; b.lastSource = fp;
    b.lastUpdated = new Date().toISOString(); b.pending = null; b.error = null; b.errorCode = null; b.status = 'ready';
    const journal = this.state.journal;
    this.state.journal = null;
    try { await this.persist(); } catch(e) { this.state.journal = journal; throw e; }
    this.notices.delete(b.id);
  },
  async recover() {
    const j = this.state.journal;
    if (!j) return;
    const b = this.binding(j.bindingID);
    const parent = await Zotero.Items.getByLibraryAndKeyAsync(j.libraryID, j.parentKey);
    const old = j.oldKey && await Zotero.Items.getByLibraryAndKeyAsync(j.libraryID, j.oldKey);
    let fresh = j.newKey && await Zotero.Items.getByLibraryAndKeyAsync(j.libraryID, j.newKey);
    if (!fresh && parent) fresh = (await Zotero.Items.getAsync(parent.getAttachments())).find(a => a.getField('title') === j.marker);
    if (!parent || parent.deleted) throw new Error('未完成的替换所对应父条目已删除，请恢复父条目后重试');
    if (fresh && (fresh.parentItemID !== parent.id || fresh.libraryID !== j.libraryID)) throw new Error('未完成的替换附件已被移动，请恢复原父条目关系后重试');
    if (fresh && !fresh.deleted && (!j.oldKey || old?.deleted)) {
      const path = await fresh.getFilePathAsync();
      if (path && await Zotero.Utilities.Internal.md5Async(path) === j.source.hash) {
        if (fresh.getField('title') === j.marker) { fresh.setField('title', j.source.name); await fresh.saveTx(); }
        await this.finish(b, fresh, j.source); return;
      }
    }
    // Also restore when the new item itself disappeared after the DB commit.
    if (old?.deleted) { old.deleted = false; await old.saveTx(); }
    if (fresh && !fresh.deleted) await Zotero.Items.trashTx([fresh.id]);
    if (j.previous) Object.assign(b, j.previous);
    else { b.attachmentKey = j.oldKey || null; b.lastHash = null; b.lastSource = null; }
    this.state.journal = null; b.pending = null; b.error = '上次替换未完成，已保留旧附件；请重新检查';
    await this.persist();
  }
};
