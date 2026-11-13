/* global window, document */
"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const state = { api: null, bindings: [], id: null, parent: null, busy: false, dirty: false, series: null, seriesLabel: null, unsubscribe: null, refreshToken: 0 };
  const text = (tag, className, value) => {
    const el = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (className) el.className = className;
    el.textContent = value;
    return el;
  };
  const current = () => state.bindings.find(b => b.id === state.id);
  const attachmentChanged = () => !!current() && ($("attachment").value || "") !== (current().attachmentKey || "");
  const formatTime = value => {
    if (!value) return "";
    const date = new Date(value);
    const pad = (number, width = 2) => String(number).padStart(width, "0");
    return Number.isNaN(date.getTime()) ? String(value)
      : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  };
  const fileMetadata = file => [file.mtime ? `修改时间 ${formatTime(file.mtime)}` : "",
    Number.isFinite(file.size) ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : ""].filter(Boolean).join(" · ");
  const status = binding => {
    if (!binding.enabled) return { label: "已暂停", kind: "paused", description: "此条目的定时检查已暂停，点击下方「恢复监控」继续。" };
    if (binding.error || binding.status === "error") return { label: "需处理", kind: "error", description: "本次检查未完成。你仍可编辑并保存规则；附件绑定失效时，点击「刷新附件列表 / 修复绑定」。" };
    if (binding.status === "choice") return { label: "待选择系列", kind: "pending", description: "请确认要持续更新的文档系列，例如全文、章节或补充材料。选择前暂停附件替换。" };
    if (binding.selectionRequired && binding.status === "waiting") return { label: "等待候选恢复", kind: "paused", description: "待选择的文件暂不可用；恢复后仍需确认要跟踪的系列，附件替换保持暂停。" };
    if (binding.pending) return { label: "待更新", kind: "pending", description: binding.automatic ? "已发现新版本，将按自动更新规则处理。" : "已发现新版本，点击「更新附件」完成替换。" };
    const descriptions = {
      stabilizing: {label:"等待稳定",kind:"pending",description:"PDF 可能仍在写入，需连续检查确认稳定后才会更新。"},
      waiting: {label:"无匹配文件",kind:"paused",description:"当前没有匹配的 PDF。请检查路径与文件名规则，或等待新文件出现。"},
      older: {label:"避免版本回退",kind:"paused",description:"当前候选比已导入版本旧，保留现有附件，不自动回退。"},
      ready: {label:"暂无更新",kind:"",description:"当前匹配文件与已导入内容一致，继续监控后续变化。"},
    };
    return descriptions[binding.status] || { label: "监控中", kind: "", description: "规则已启用，正在等待下次检查。" };
  };
  function notice(message, error = false, tone = "") {
    $("notice-message").textContent = message;
    $("notice").className = error ? "notice error" : `notice ${tone}`.trim();
    $("notice").hidden = !message;
  }
  function controls() {
    for (const button of document.querySelectorAll(".action")) button.disabled = state.busy;
    for (const button of document.querySelectorAll(".binding-card")) button.disabled = state.busy;
    $("form-fields").disabled = state.busy || !state.parent;
    $("update-now").disabled = state.busy || state.dirty || current()?.status === "choice" || !current()?.pending;
    $("update-now").title = state.dirty ? "请先保存规则修改，再更新附件" : "导入新 PDF，将所绑定的旧附件及批注移入回收站";
    $("save-rule").disabled = state.busy || !state.parent;
    $("preview-rule").disabled = state.busy || !state.parent;
    $("repair-attachment").disabled = state.busy || !state.parent;
    $("derive-rule").disabled = state.busy || !state.parent;
    for (const button of document.querySelectorAll(".choose-candidate")) {
      button.disabled = state.busy || state.dirty || !state.parent || !current()?.enabled;
      button.title = state.dirty ? "请先保存规则修改，再选择文档系列" : !current()?.enabled ? "请先恢复监控，再选择文档系列" : "记住此文档系列，后续只跟踪该系列的新版本";
    }
    $("reset-series").disabled = state.busy || state.dirty || !state.parent;
    $("reset-series").title = state.dirty ? "请先保存规则修改，再重新选择系列" : "清除系列选择，重新检查匹配的文档系列";
    $("choice-dirty-hint").hidden = !state.dirty;
    $("save-attachment").hidden = !attachmentChanged();
    $("save-attachment").disabled = state.busy || !state.parent;
    $("action-dock").hidden = $("editor").hidden;
    $("dirty-label").hidden = !state.dirty;
  }
  async function action(fn) {
    if (state.busy) return;
    state.busy = true;
    controls();
    notice("");
    try { await fn(); }
    catch (error) { notice(error?.message || String(error), true); }
    finally { state.busy = false; controls(); }
  }
  function renderList() {
    $("binding-count").textContent = String(state.bindings.length);
    $("binding-list").replaceChildren();
    if (!state.bindings.length) {
      $("binding-list").append(text("p", "empty-list", "尚未绑定论文。每篇论文可以单独设置文件夹与更新方式。"));
    }
    for (const binding of state.bindings) {
      const button = text("button", `binding-card${binding.id === state.id ? " selected" : ""}`, "");
      button.type = "button";
      button.setAttribute("aria-pressed", String(binding.id === state.id));
      button.title = binding.title || "未命名条目";
      button.append(text("div", "binding-title", binding.title || "未命名条目"));
      const meta = text("div", "binding-sub", "");
      const info = status(binding);
      meta.append(text("span", `badge ${info.kind}`, info.label));
      meta.append(text("span", "binding-mode", binding.automatic ? "自动替换" : "通知后更新"));
      button.append(meta);
      button.addEventListener("click", () => action(async () => {
        if (!allowNavigation()) return;
        await editBinding(binding.id);
      }));
      $("binding-list").append(button);
    }
  }
  function renderState() {
    const binding = current();
    $("rule-status").hidden = !binding;
    $("rule-summary").hidden = !binding;
    $("pending-panel").hidden = !binding?.pending || binding?.status === "choice";
    renderCandidates(binding);
    $("selected-series").hidden = !state.series;
    $("series-name").textContent = state.seriesLabel || state.series || "";
    $("existing-actions").hidden = !binding;
    $("remove-hint").hidden = !binding;
    $("rule-error").hidden = !binding?.error;
    const changed = attachmentChanged();
    $("rule-error").textContent = binding?.error ? (changed ? "已保存规则的检查结果（新选择尚未保存）：" : "") + binding.error : "";
    $("editor-kicker").textContent = binding ? "监控规则" : "新建监控";
    if (binding) {
      const info = changed ? {label: "待保存", kind: "pending", description: "附件选择已修改，尚未保存；监控仍使用原绑定。点击附件下方「保存并修复绑定」后生效。"} : status(binding);
      $("rule-status").textContent = info.label;
      $("rule-status").className = `badge ${info.kind}`;
      $("rule-summary").textContent = info.description;
      $("pending-name").textContent = binding.pending?.name || binding.pending?.path || "";
      $("pending-name").title = binding.pending?.path || "";
      $("toggle-rule").textContent = binding.enabled ? "暂停监控" : "恢复监控";
      $("last-update").textContent = binding.lastUpdated ? `上次更新：${formatTime(binding.lastUpdated)}` : "尚未通过此插件更新";
    }
    controls();
  }
  function renderCandidates(binding) {
    const choices = binding?.status === "choice" ? binding.choices || [] : [];
    $("choice-panel").hidden = binding?.status !== "choice";
    $("choice-list").replaceChildren();
    for (const file of choices) {
      const card = text("div", "candidate-card", "");
      const details = text("div", "candidate-details", "");
      if (file.label) details.append(text("div", "candidate-series", file.label));
      const filename = text("div", "candidate-name", file.name || file.path);
      filename.title = file.path;
      details.append(filename, text("div", "candidate-meta", fileMetadata(file)));
      const button = text("button", "action secondary choose-candidate", "跟踪此系列");
      button.type = "button";
      button.setAttribute("aria-label", `跟踪此系列：${file.name || file.path}`);
      button.addEventListener("click", () => action(async () => {
        if (!state.id || state.dirty) return;
        const id = state.id;
        await state.api.chooseCandidate(id, file.path);
        await refresh(); await editBinding(id);
        if (current()?.error) { notice("系列已保存，本次检查仍需处理：" + current().error, true); return; }
        notice(current()?.automatic
          ? "已记住所选系列。后续检查确认文件稳定且内容变化后，将按自动更新设置替换附件。"
          : "已记住所选系列。后续检查确认文件稳定且内容变化后，会提示你点击「更新附件」。", false, "pending");
      }));
      card.append(details, button);
      $("choice-list").append(card);
    }
  }
  async function refresh() {
    const token = ++state.refreshToken;
    const bindings = await state.api.listBindings();
    if (token !== state.refreshToken || window.closed) return;
    const previousAttachmentKey = current()?.attachmentKey;
    const previousSeries = current()?.series;
    state.bindings = bindings;
    renderList();
    renderState();
    // Automatic replacement may swap the attachment while this window stays open.
    // Keep an untouched form current, while preserving deliberate user edits.
    if (state.id && !state.dirty && current()
        && (previousAttachmentKey !== current().attachmentKey || previousSeries !== current().series)) {
      await editBinding(state.id);
    }
  }
  function allowNavigation() {
    // This only protects edits in the form; attachment replacement needs no extra confirmation.
    return !state.dirty || window.confirm("当前规则有未保存的修改。放弃这些修改并切换条目？");
  }
  function setSourceMode() {
    const folder = $("mode").value === "folder";
    $("pattern-field").hidden = !folder;
    $("order").disabled = !folder;
    $("path-label").textContent = folder ? "PDF 所在文件夹" : "PDF 文件的完整路径";
    $("path").placeholder = folder ? "选择文件夹，或粘贴完整路径" : "选择 PDF 文件，或粘贴完整路径";
    $("order-hint").hidden = !folder;
    $("order-hint").textContent = $("order").value === "version"
      ? "按文件名中的数字自然排序；同一论文应使用一致前缀，如 paper_v2.pdf、paper_v10.pdf。"
      : "按磁盘上的文件修改时间选择。复制或下载旧版本也可能改变修改时间，请先查看匹配预览。";
  }
  function attachmentOptions(parent, chosen = undefined) {
    const attachments = parent.attachments || [];
    const select = $("attachment");
    const missing = !!chosen && !attachments.some(a => a.key === chosen);
    select.replaceChildren();
    if (missing) {
      const option = text("option", "", `原绑定附件不可用 [${chosen}] — 请点击修复绑定`);
      option.value = chosen;
      option.disabled = true;
      select.append(option);
    }
    if (!attachments.length) {
      const option = text("option", "", "暂无 PDF，首次更新时导入附件");
      option.value = "";
      select.append(option);
      select.value = missing ? chosen : "";
      $("attachment-hint").textContent = missing
        ? "原绑定已失效，当前父条目下没有可用 PDF。点击修复绑定后保存，可在下次更新时新增附件；也可先修改路径并保存。"
        : "当前父条目下没有 PDF，首次更新会在此条目下新增附件。";
    } else {
      if (attachments.length > 1 && !missing) {
        const option = text("option", "", "请选择要替换的 PDF 附件…");
        option.value = "";
        select.append(option);
      }
      for (const attachment of attachments) {
        const title = attachment.filename || attachment.title || attachment.key;
        const option = text("option", "", `${title}  [${attachment.key}]`);
        option.value = attachment.key;
        select.append(option);
      }
      select.value = chosen || (chosen === undefined && attachments.length === 1 ? attachments[0].key : "");
      // A cleared binding with one newly added PDF still needs an explicit choice.
      if (select.selectedIndex < 0) {
        const option = text("option", "", "请选择要替换的 PDF 附件…");
        option.value = "";
        select.prepend(option);
        select.value = "";
      }
      $("attachment-hint").textContent = missing
        ? "原绑定附件不可用。可在下拉框选择现存 PDF，或点击修复绑定；确认后保存。修改路径、暂停监控和移除绑定仍可用。"
        : attachments.length > 1
        ? "该条目有多个 PDF。只替换你选中的这个附件，其他附件保留。"
        : "只替换这个 PDF 附件；父条目的元数据和独立笔记保留。";
    }
  }
  async function repairAttachment() {
    if (!state.parent) throw new Error("请先选择可编辑的论文条目。");
    const parent = await state.api.getParent(state.parent.parentID);
    if (!parent) throw new Error("父条目已不存在，请先在 Zotero 中恢复条目。");
    const before = $("attachment").value;
    const attachments = parent.attachments || [];
    const valid = before && attachments.some(a => a.key === before);
    state.parent = parent;
    let chosen = valid ? before : attachments.length === 1 ? attachments[0].key : "";
    attachmentOptions(parent, chosen);
    if (chosen !== before || attachmentChanged()) markDirty();
    else renderState();
    if (attachmentChanged()) notice(chosen
      ? "当前选择可用，但尚未保存。点击附件下方「保存并修复绑定」完成修复。"
      : attachments.length ? "找到多个 PDF，请选择要替换的附件，再保存并修复绑定。"
      : "当前没有 PDF，已选择下次更新时新增附件。点击「保存并修复绑定」后生效。", false, "pending");
    else if (valid && current()?.error) notice("附件列表已刷新，当前选择可用；已保存规则仍有检查错误。请保存规则或重新检查，详情见下方。", false, "pending");
    else if (valid) notice("附件列表已刷新，已保存的附件绑定仍有效。");
    else if (attachments.length === 1) notice("已选择当前唯一的 PDF。请核对附件名称，再点击下方「保存监控规则」完成修复。");
    else if (!attachments.length) notice("当前没有 PDF，已选择下次更新时新增附件。点击下方「保存监控规则」完成修复。");
    else notice("找到多个 PDF，请在下拉框选择要替换的附件，再点击下方「保存监控规则」。");
  }
  function populate(parent, binding = null) {
    state.parent = parent;
    state.id = binding?.id || null;
    state.dirty = false;
    state.series = binding?.series || null;
    state.seriesLabel = binding?.seriesLabel || null;
    $("empty-state").hidden = true;
    $("editor").hidden = false;
    $("parent-title").textContent = parent.title || binding?.title || "未命名条目";
    $("parent-title").title = parent.title || "";
    attachmentOptions(parent, binding?.attachmentKey);
    $("mode").value = binding?.mode || "folder";
    $("path").value = binding?.path || "";
    $("pattern").value = binding?.pattern || "*.pdf";
    $("order").value = binding?.order || "version";
    $("automatic").checked = !!binding?.automatic;
    $("enabled").checked = binding ? !!binding.enabled : true;
    $("preview-panel").hidden = true;
    setSourceMode();
    renderList();
    renderState();
  }
  async function editBinding(id) {
    const binding = state.bindings.find(b => b.id === id);
    if (!binding) throw new Error("该监控绑定已不存在。");
    let parent;
    try { parent = await state.api.getParent(binding.parentID); }
    catch (error) {
      showOrphan(binding, error.message || String(error));
      return;
    }
    if (!parent) {
      showOrphan(binding, "找不到对应的 Zotero 父条目。请检查条目是否已被删除。");
      return;
    }
    populate(parent, binding);
  }
  function showOrphan(binding, message) {
    populate({ parentID: binding.parentID, title: binding.title, attachments: [] }, binding);
    state.parent = null;
    controls();
    notice(`${message} 你仍可以移除这条监控绑定。`, true);
  }
  function markDirty() {
    state.dirty = true;
    $("preview-panel").hidden = true;
    renderState();
  }
  function sourceEdited(event) {
    if (["mode", "path", "pattern"].includes(event.target.id)) {
      state.series = null; state.seriesLabel = null;
    }
    markDirty();
  }
  function config(requireAttachment = true) {
    if (!state.parent) throw new Error("请先在 Zotero 中选择要绑定的论文条目。");
    const path = $("path").value.trim();
    if (!path) throw new Error("请选择文件夹或 PDF 文件。");
    const attachmentKey = $("attachment").value;
    if (requireAttachment && state.parent.attachments?.length && !attachmentKey) {
      throw new Error("请选择要替换的现有 PDF 附件。");
    }
    const pattern = $("pattern").value.trim() || "*.pdf";
    return {
      ...(state.id ? { id: state.id } : {}), parentID: state.parent.parentID,
      attachmentKey, mode: $("mode").value, path, pattern, order: $("order").value,
      series: state.series,
      automatic: $("automatic").checked, enabled: $("enabled").checked,
    };
  }
  async function startNew(parent = null) {
    if (!allowNavigation()) return;
    parent = parent || await state.api.selection();
    if (!parent) throw new Error("请在 Zotero 主窗口的文献列表中选中一篇论文（或其 PDF 附件），再点击「绑定当前选中的条目」。");
    const existing = state.bindings.find(b => b.parentID === parent.parentID);
    if (existing) { await editBinding(existing.id); notice("这个条目已有监控规则，已打开现有绑定。"); }
    else { populate(parent); notice("已选择条目。设置来源与匹配规则后保存。"); }
  }
  function showPreview(files) {
    $("preview-list").replaceChildren();
    if (!files.length) $("preview-list").append(text("p", "preview-empty", "没有匹配的 PDF。请检查路径和文件名规则。"));
    for (const file of files.slice(0, 20)) {
      const row = text("div", "preview-row", "");
      row.title = file.path || "";
      row.append(text("div", "preview-name", file.name || file.path));
      row.append(text("div", "preview-meta", fileMetadata(file)));
      $("preview-list").append(row);
    }
    $("preview-panel").hidden = false;
  }
  async function init() {
    const args = window.arguments?.[0];
    if (!args?.api) throw new Error("无法连接 PDF 更新监控插件。请从 Zotero 的插件菜单重新打开此窗口。");
    state.api = args.api;
    $("plugin-version").textContent = state.api.version ? `v${state.api.version}` : "需要重新启动 Zotero";
    $("notice-close").addEventListener("click", () => notice(""));
    $("new-binding").addEventListener("click", () => action(() => startNew()));
    $("check-all").addEventListener("click", () => action(async () => {
      await state.api.checkAll({forceHash: true}); await refresh();
      const errors = state.bindings.filter(b => b.enabled && b.error).length;
      notice(errors ? `检查完成，${errors} 条规则仍需处理，原因见条目中的提示。` : "检查完成。正在写入的文件会在稳定后识别，待更新条目会显示在列表中。", !!errors);
    }));
    $("browse").addEventListener("click", () => action(async () => {
      const path = await state.api.pickPath($("mode").value, window);
      if (path) { $("path").value = path; state.series = null; state.seriesLabel = null; markDirty(); }
    }));
    $("repair-attachment").addEventListener("click", () => action(() => repairAttachment()));
    $("derive-rule").addEventListener("click", () => action(async () => {
      const file = await state.api.pickPath("file", window);
      if (!file) return;
      const rule = await state.api.ruleFromFile(file);
      for (const key of ["mode", "path", "pattern", "order"]) $(key).value = rule[key];
      state.series = rule.series || null;
      state.seriesLabel = rule.seriesLabel || null;
      setSourceMode(); markDirty();
      showPreview(await state.api.preview(config(false)));
      notice("已从所选 PDF 生成同系列版本规则。请核对下方候选文件，再保存监控规则。", false, "pending");
    }));
    $("mode").addEventListener("change", setSourceMode);
    $("order").addEventListener("change", setSourceMode);
    $("rule-form").addEventListener("input", sourceEdited);
    $("rule-form").addEventListener("change", sourceEdited);
    $("reset-series").addEventListener("click", () => action(async () => {
      if (state.dirty) return;
      if (!state.id) { state.series = null; state.seriesLabel = null; markDirty(); return; }
      const id = state.id;
      await state.api.chooseCandidate(id, null);
      await refresh(); await editBinding(id);
      if (current()?.error) notice("已清除系列选择，本次检查仍需处理：" + current().error, true);
      else notice(current()?.status === "choice" ? "已清除系列选择，请从候选列表重新选择要跟踪的系列。" : "已清除系列选择；后续检查将按当前规则识别文档系列。", false, "pending");
    }));
    $("rule-form").addEventListener("submit", event => {
      event.preventDefault();
      action(async () => {
        const binding = await state.api.saveBinding(config());
        state.dirty = false;
        await refresh(); await editBinding(binding.id);
        if (binding.errorCode === 'source-unavailable') notice("规则已保存，监控来源暂不可读：" + binding.error, true);
        else if (binding.error) notice("规则已保存，附件绑定仍需修复。点击「刷新附件列表 / 修复绑定」选择现存 PDF 后再保存。", true);
        else notice(binding.automatic ? "规则已保存；稳定的新版本将自动替换旧附件。" : "规则已保存；发现更新后会通知你，由你点击更新。");
      });
    });
    $("preview-rule").addEventListener("click", () => action(async () => showPreview(await state.api.preview(config(false)))));
    $("update-now").addEventListener("click", () => action(async () => {
      if (!state.id || state.dirty) return;
      const id = state.id;
      const hadAttachment = !!current()?.attachmentKey;
      await state.api.update(id); await refresh(); await editBinding(id);
      notice(hadAttachment ? "更新完成。新 PDF 已附加到原条目，旧附件及批注已移入回收站。" : "更新完成。新 PDF 已导入到原条目下。");
    }));
    $("toggle-rule").addEventListener("click", () => action(async () => {
      const binding = current();
      if (!binding) return;
      if (!allowNavigation()) return;
      const enabled = !binding.enabled;
      await state.api.setEnabled(binding.id, enabled); await refresh(); await editBinding(binding.id);
      notice(enabled ? "已恢复监控。" : "已暂停监控。");
    }));
    $("remove-rule").addEventListener("click", () => action(async () => {
      if (!state.id) return;
      if (!allowNavigation()) return;
      await state.api.removeBinding(state.id);
      state.id = null; state.parent = null; state.dirty = false;
      $("editor").hidden = true; $("empty-state").hidden = false;
      await refresh();
      notice("已移除监控绑定。Zotero 条目、附件和源文件已保留。");
    }));
    window.addEventListener("unload", () => { state.unsubscribe?.(); }, { once: true });
    await refresh();
    state.unsubscribe = state.api.subscribe(() => { refresh().catch(error => notice(error.message || String(error), true)); });
    if (args.parentID) await startNew(await state.api.getParent(args.parentID));
    else if (state.bindings.length) await editBinding(state.bindings[0].id);
    controls();
  }
  window.addEventListener("DOMContentLoaded", () => { init().catch(error => notice(error.message || String(error), true)); }, { once: true });
})();
